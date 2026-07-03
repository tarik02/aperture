package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/uptrace/bun"
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

// CommitPromotion inserts a snapshot, replaces tags, and refreshes the session lease in one transaction.
func (r *Repository) CommitPromotion(
	ctx context.Context,
	snapshot *Snapshot,
	tags []SnapshotTag,
	session *Session,
	renameTombstone *Snapshot,
) error {
	return r.WithTx(ctx, func(ctx context.Context, tx bun.Tx) error {
		if renameTombstone != nil {
			if _, err := tx.NewUpdate().Model(renameTombstone).WherePK().Exec(ctx); err != nil {
				return fmt.Errorf("rename tombstoned snapshot: %w", err)
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
		if _, err := tx.NewUpdate().Model(session).WherePK().Exec(ctx); err != nil {
			return fmt.Errorf("update session lease: %w", err)
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
