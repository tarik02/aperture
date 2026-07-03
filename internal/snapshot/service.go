package snapshot

import (
	"context"
	"fmt"
	"time"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
)

// Service owns snapshot lifecycle outside promotion materialization.
type Service struct {
	cfg  config.Config
	repo *db.Repository
	now  func() time.Time
}

// NewService constructs a snapshot service.
func NewService(cfg config.Config, repo *db.Repository) *Service {
	return &Service{
		cfg:  cfg,
		repo: repo,
		now:  time.Now,
	}
}

// SnapshotView is returned by snapshot APIs.
type SnapshotView struct {
	Snapshot db.Snapshot
	Tags     map[string]string
}

// Delete tombstones a snapshot.
func (s *Service) Delete(ctx context.Context, tenantID, name string) (*SnapshotView, error) {
	snapshotRow, err := s.requireTenantSnapshot(ctx, tenantID, name)
	if err != nil {
		return nil, err
	}
	if snapshotRow.DeletedAt != nil {
		return s.view(ctx, snapshotRow)
	}

	now := s.now().UTC()
	deletedAt := now.Format(time.RFC3339Nano)
	expiresAt := now.Add(time.Duration(s.cfg.SnapshotRetentionDays) * 24 * time.Hour).Format(time.RFC3339Nano)
	snapshotRow.DeletedAt = &deletedAt
	snapshotRow.ExpiresAt = &expiresAt

	if err := s.repo.UpdateSnapshot(ctx, snapshotRow); err != nil {
		return nil, err
	}
	return s.view(ctx, snapshotRow)
}

// Restore clears tombstone state for a deleted snapshot.
func (s *Service) Restore(ctx context.Context, tenantID, name string) (*SnapshotView, error) {
	snapshotRow, err := s.requireTenantSnapshot(ctx, tenantID, name)
	if err != nil {
		return nil, err
	}
	if snapshotRow.DeletedAt == nil {
		return nil, ErrNotDeleted
	}

	snapshotRow.DeletedAt = nil
	snapshotRow.ExpiresAt = nil
	if err := s.repo.UpdateSnapshot(ctx, snapshotRow); err != nil {
		return nil, err
	}
	return s.view(ctx, snapshotRow)
}

func (s *Service) requireTenantSnapshot(ctx context.Context, tenantID, name string) (*db.Snapshot, error) {
	snapshotRow, err := s.repo.GetSnapshotByTenantAndName(ctx, tenantID, name)
	if err != nil {
		return nil, err
	}
	if snapshotRow == nil {
		return nil, ErrNotFound
	}
	return snapshotRow, nil
}

func (s *Service) view(ctx context.Context, snapshotRow *db.Snapshot) (*SnapshotView, error) {
	tags, err := s.repo.ListSnapshotTags(ctx, snapshotRow.ID)
	if err != nil {
		return nil, err
	}
	return &SnapshotView{
		Snapshot: *snapshotRow,
		Tags:     tags,
	}, nil
}

// RenameTombstonedSnapshot frees a tenant-scoped name for force promotion.
func (s *Service) RenameTombstonedSnapshot(ctx context.Context, snapshotRow *db.Snapshot) error {
	if snapshotRow.DeletedAt == nil {
		return fmt.Errorf("snapshot is not tombstoned")
	}
	snapshotRow.Name = fmt.Sprintf("%s.tombstone.%s", snapshotRow.Name, snapshotRow.ID)
	return s.repo.UpdateSnapshot(ctx, snapshotRow)
}
