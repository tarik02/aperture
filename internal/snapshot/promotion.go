package snapshot

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/ids"
	"github.com/aperture/aperture/internal/overlay"
	"github.com/aperture/aperture/internal/paths"
)

// BrowserSupervisor reports whether a browser unit is active.
type BrowserSupervisor interface {
	IsActive(ctx context.Context, sessionID string) (bool, error)
}

// PromoteInput configures session promotion.
type PromoteInput struct {
	TenantID    string
	SessionID   string
	Name        string
	Description *string
	Force       bool
	Tags        map[string]string
}

// PromotionService owns session promotion.
type PromotionService struct {
	cfg         config.Config
	repo        *db.Repository
	browser     BrowserSupervisor
	snapshots   *Service
	now         func() time.Time
	locks       sync.Map
	materialize func(ctx context.Context, input overlay.MaterializeInput) error
}

// NewPromotionService constructs a promotion service.
func NewPromotionService(cfg config.Config, repo *db.Repository, browser BrowserSupervisor, snapshots *Service) *PromotionService {
	return &PromotionService{
		cfg:         cfg,
		repo:        repo,
		browser:     browser,
		snapshots:   snapshots,
		now:         time.Now,
		materialize: overlay.Materialize,
	}
}

// Promote materializes a stopped retained session into a new snapshot.
func (p *PromotionService) Promote(ctx context.Context, input PromoteInput) (*SnapshotView, error) {
	lock := p.sessionLock(input.SessionID)
	lock.Lock()
	defer lock.Unlock()

	sessionRow, err := p.repo.GetSessionByTenantAndID(ctx, input.TenantID, input.SessionID)
	if err != nil {
		return nil, err
	}
	if sessionRow == nil {
		return nil, ErrSessionNotFound
	}
	if isExpired(sessionRow.ExpiresAt, p.now().UTC()) {
		return nil, ErrSessionExpired
	}
	if err := p.validatePromotable(ctx, sessionRow); err != nil {
		return nil, err
	}
	if err := p.validateSnapshotName(ctx, input.TenantID, input.Name, input.Force); err != nil {
		return nil, err
	}

	lowerDir, parentSnapshotID, err := p.resolveLowerDir(ctx, sessionRow)
	if err != nil {
		return nil, err
	}

	finalSnapshotID, err := ids.NewUUIDv7()
	if err != nil {
		return nil, err
	}
	tempSnapshotID, err := ids.NewUUIDv7()
	if err != nil {
		return nil, err
	}

	tempLayout, err := paths.Snapshot(p.cfg, tempSnapshotID)
	if err != nil {
		return nil, err
	}
	finalLayout, err := paths.Snapshot(p.cfg, finalSnapshotID)
	if err != nil {
		return nil, err
	}

	if err := p.materialize(ctx, overlay.MaterializeInput{
		LowerDir: lowerDir,
		UpperDir: sessionRow.UpperPath,
		DestDir:  tempLayout.Profile,
	}); err != nil {
		return nil, err
	}

	if err := os.MkdirAll(filepath.Dir(finalLayout.Root), 0o755); err != nil {
		_ = os.RemoveAll(tempLayout.Root)
		return nil, fmt.Errorf("prepare snapshot root: %w", err)
	}
	if err := os.Rename(tempLayout.Root, finalLayout.Root); err != nil {
		_ = os.RemoveAll(tempLayout.Root)
		return nil, fmt.Errorf("publish snapshot directory: %w", err)
	}

	now := p.now().UTC()
	createdAt := now.Format(time.RFC3339Nano)
	sessionCopy := *sessionRow
	sessionCopy.ExpiresAt = now.Add(time.Duration(p.cfg.SessionRetentionDays) * 24 * time.Hour).Format(time.RFC3339Nano)

	snapshotRow := &db.Snapshot{
		ID:                    finalSnapshotID,
		TenantID:              input.TenantID,
		Name:                  input.Name,
		Description:           input.Description,
		Path:                  finalLayout.Root,
		ParentSnapshotID:      parentSnapshotID,
		PromotedFromSessionID: &sessionCopy.ID,
		CreatedAt:             createdAt,
	}

	var view *SnapshotView
	var renameTombstone *db.Snapshot
	if input.Force {
		existing, err := p.repo.GetSnapshotByTenantAndName(ctx, input.TenantID, input.Name)
		if err != nil {
			_ = os.RemoveAll(finalLayout.Root)
			return nil, err
		}
		if existing != nil && existing.DeletedAt != nil {
			renameCopy := *existing
			renameCopy.Name = fmt.Sprintf("%s.tombstone.%s", renameCopy.Name, renameCopy.ID)
			renameTombstone = &renameCopy
		}
	}

	if err := p.repo.CommitPromotion(ctx, snapshotRow, tagsToRows(snapshotRow.ID, input.Tags), &sessionCopy, renameTombstone); err != nil {
		_ = os.RemoveAll(finalLayout.Root)
		return nil, err
	}

	tags, err := p.repo.ListSnapshotTags(ctx, snapshotRow.ID)
	if err != nil {
		return nil, err
	}
	view = &SnapshotView{Snapshot: *snapshotRow, Tags: tags}

	return view, nil
}

func (p *PromotionService) validatePromotable(ctx context.Context, sessionRow *db.Session) error {
	switch sessionRow.Status {
	case db.SessionStatusDeleted, db.SessionStatusFailed, db.SessionStatusSuspended:
	default:
		return &PromotionConflictError{
			SessionID: sessionRow.ID,
			Reason:    "session must be stopped and retained",
		}
	}

	active, err := p.browser.IsActive(ctx, sessionRow.ID)
	if err != nil {
		return err
	}
	if active {
		return &PromotionConflictError{SessionID: sessionRow.ID, Reason: "browser is still running"}
	}

	if sessionRow.UpperPath == "" {
		return ErrOverlayMissing
	}
	if _, err := os.Stat(sessionRow.UpperPath); err != nil {
		return ErrOverlayMissing
	}
	return nil
}

func (p *PromotionService) validateSnapshotName(ctx context.Context, tenantID, name string, force bool) error {
	existing, err := p.repo.GetSnapshotByTenantAndName(ctx, tenantID, name)
	if err != nil {
		return err
	}
	if existing == nil {
		return nil
	}
	if existing.DeletedAt == nil {
		if force {
			return &NameConflictError{Name: name}
		}
		return &NameConflictError{Name: name}
	}
	if !force {
		return &DeletedError{Name: name}
	}
	return nil
}

func (p *PromotionService) resolveLowerDir(ctx context.Context, sessionRow *db.Session) (string, *string, error) {
	if sessionRow.BaseSnapshotID == nil {
		lowerDir, err := paths.EmptyLowerDir(p.cfg)
		if err != nil {
			return "", nil, err
		}
		return lowerDir, nil, nil
	}

	parent, err := p.repo.GetSnapshotByID(ctx, *sessionRow.BaseSnapshotID)
	if err != nil {
		return "", nil, err
	}
	if parent == nil {
		return "", nil, fmt.Errorf("base snapshot not found")
	}
	layout, err := paths.Snapshot(p.cfg, parent.ID)
	if err != nil {
		return "", nil, err
	}
	parentID := parent.ID
	return layout.Profile, &parentID, nil
}

func (p *PromotionService) sessionLock(sessionID string) *sync.Mutex {
	value, _ := p.locks.LoadOrStore(sessionID, &sync.Mutex{})
	return value.(*sync.Mutex)
}

func (p *PromotionService) SetMaterializeHook(fn func(ctx context.Context, input overlay.MaterializeInput) error) {
	p.materialize = fn
}

func tagsToRows(snapshotID string, tags map[string]string) []db.SnapshotTag {
	rows := make([]db.SnapshotTag, 0, len(tags))
	for key, value := range tags {
		rows = append(rows, db.SnapshotTag{
			SnapshotID: snapshotID,
			Key:        key,
			Value:      value,
		})
	}
	return rows
}

func isExpired(expiresAt string, now time.Time) bool {
	parsed, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil {
		return true
	}
	return now.After(parsed)
}
