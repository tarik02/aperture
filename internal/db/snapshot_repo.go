package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/uptrace/bun"
)

var (
	ErrSnapshotNameConflict = errors.New("snapshot name already exists")
	ErrSessionStateConflict = errors.New("session state changed")
)

// CreateSnapshot inserts a snapshot row.
func (r *Repository) CreateSnapshot(ctx context.Context, snapshot *Snapshot) error {
	_, err := r.db.bun.NewInsert().Model(snapshot).Exec(ctx)
	if err != nil {
		return fmt.Errorf("insert snapshot: %w", err)
	}
	return nil
}

// GetSnapshotByID returns a snapshot by id.
func (r *Repository) GetSnapshotByID(ctx context.Context, snapshotID string) (*Snapshot, error) {
	snapshot := new(Snapshot)
	err := r.db.bun.NewSelect().
		Model(snapshot).
		Where("id = ?", snapshotID).
		Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select snapshot: %w", err)
	}
	return snapshot, nil
}

// GetSnapshotByTenantAndName returns a snapshot for a tenant by name.
func (r *Repository) GetSnapshotByTenantAndName(ctx context.Context, tenantID, name string) (*Snapshot, error) {
	snapshot := new(Snapshot)
	err := r.db.bun.NewSelect().
		Model(snapshot).
		Where("tenant_id = ?", tenantID).
		Where("name = ?", name).
		Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select snapshot by name: %w", err)
	}
	return snapshot, nil
}

// UpdateSnapshot replaces mutable snapshot fields.
func (r *Repository) UpdateSnapshot(ctx context.Context, snapshot *Snapshot) error {
	_, err := r.db.bun.NewUpdate().
		Model(snapshot).
		WherePK().
		Exec(ctx)
	if err != nil {
		return fmt.Errorf("update snapshot: %w", err)
	}
	return nil
}

// ReplaceSnapshotTags replaces all tags for a snapshot.
func (r *Repository) ReplaceSnapshotTags(ctx context.Context, snapshotID string, tags []SnapshotTag) error {
	return r.WithTx(ctx, func(ctx context.Context, tx bun.Tx) error {
		if _, err := tx.NewDelete().
			Model((*SnapshotTag)(nil)).
			Where("snapshot_id = ?", snapshotID).
			Exec(ctx); err != nil {
			return fmt.Errorf("delete snapshot tags: %w", err)
		}
		if len(tags) == 0 {
			return nil
		}
		if _, err := tx.NewInsert().Model(&tags).Exec(ctx); err != nil {
			return fmt.Errorf("insert snapshot tags: %w", err)
		}
		return nil
	})
}

// CommitPromotion resolves name replacement, inserts a snapshot, replaces tags, and refreshes the session lease in one transaction.
func (r *Repository) CommitPromotion(
	ctx context.Context,
	snapshot *Snapshot,
	tags []SnapshotTag,
	sessionID string,
	expectedSessionStatus string,
	sessionExpiresAt string,
	replaceExisting bool,
	deletedAt string,
	expiresAt string,
) error {
	return r.WithImmediateTx(ctx, func(ctx context.Context, tx bun.IDB) error {
		existing := new(Snapshot)
		err := tx.NewSelect().
			Model(existing).
			Where("tenant_id = ?", snapshot.TenantID).
			Where("name = ?", snapshot.Name).
			Scan(ctx)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("select snapshot by name: %w", err)
		}
		if err == nil {
			if existing.DeletedAt == nil && !replaceExisting {
				return ErrSnapshotNameConflict
			}

			tombstoneName := fmt.Sprintf("%s.tombstone.%s", existing.Name, existing.ID)
			for suffix := 2; ; suffix++ {
				count, err := tx.NewSelect().
					Model((*Snapshot)(nil)).
					Where("tenant_id = ?", existing.TenantID).
					Where("name = ?", tombstoneName).
					Count(ctx)
				if err != nil {
					return fmt.Errorf("check tombstone snapshot name: %w", err)
				}
				if count == 0 {
					break
				}
				tombstoneName = fmt.Sprintf("%s.tombstone.%s.%d", existing.Name, existing.ID, suffix)
			}

			update := tx.NewUpdate().
				Model((*Snapshot)(nil)).
				Set("name = ?", tombstoneName).
				Where("id = ?", existing.ID)
			if existing.DeletedAt == nil {
				update = update.
					Set("deleted_at = ?", deletedAt).
					Set("expires_at = ?", expiresAt)
			}
			if _, err := update.Exec(ctx); err != nil {
				return fmt.Errorf("supersede snapshot: %w", err)
			}
		}
		if _, err := tx.NewInsert().Model(snapshot).Exec(ctx); err != nil {
			return fmt.Errorf("insert snapshot: %w", err)
		}
		if _, err := tx.NewDelete().
			Model((*SnapshotTag)(nil)).
			Where("snapshot_id = ?", snapshot.ID).
			Exec(ctx); err != nil {
			return fmt.Errorf("delete snapshot tags: %w", err)
		}
		if len(tags) > 0 {
			if _, err := tx.NewInsert().Model(&tags).Exec(ctx); err != nil {
				return fmt.Errorf("insert snapshot tags: %w", err)
			}
		}
		result, err := tx.NewUpdate().
			Model((*Session)(nil)).
			Set("expires_at = ?", sessionExpiresAt).
			Where("id = ?", sessionID).
			Where("status = ?", expectedSessionStatus).
			Exec(ctx)
		if err != nil {
			return fmt.Errorf("update session lease: %w", err)
		}
		updated, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("read updated session lease count: %w", err)
		}
		if updated != 1 {
			return ErrSessionStateConflict
		}
		return nil
	})
}

func (r *Repository) ListSnapshotTags(ctx context.Context, snapshotID string) (map[string]string, error) {
	tags := make([]SnapshotTag, 0)
	if err := r.db.bun.NewSelect().
		Model(&tags).
		Where("snapshot_id = ?", snapshotID).
		OrderExpr("key ASC").
		Scan(ctx); err != nil {
		return nil, fmt.Errorf("list snapshot tags: %w", err)
	}

	result := make(map[string]string, len(tags))
	for _, tag := range tags {
		result[tag.Key] = tag.Value
	}
	return result, nil
}
