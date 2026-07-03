package db

import (
	"context"
	"fmt"

	"github.com/uptrace/bun"
)

// ListSessionsExpiringBefore returns non-expired sessions whose lease has passed.
func (r *Repository) ListSessionsExpiringBefore(ctx context.Context, expiresBefore string) ([]Session, error) {
	sessions := make([]Session, 0)
	err := r.db.bun.NewSelect().
		Model(&sessions).
		Where("status != ?", SessionStatusExpired).
		Where("expires_at <= ?", expiresBefore).
		OrderExpr("created_at ASC").
		Scan(ctx)
	if err != nil {
		return nil, fmt.Errorf("list expiring sessions: %w", err)
	}
	return sessions, nil
}

// ListSessionsWithExpiredArtifacts returns expired sessions whose artifacts retention has passed.
func (r *Repository) ListSessionsWithExpiredArtifacts(ctx context.Context, artifactsBefore string) ([]Session, error) {
	sessions := make([]Session, 0)
	err := r.db.bun.NewSelect().
		Model(&sessions).
		Where("status = ?", SessionStatusExpired).
		Where("expired_at IS NOT NULL").
		Where("expired_at <= ?", artifactsBefore).
		OrderExpr("created_at ASC").
		Scan(ctx)
	if err != nil {
		return nil, fmt.Errorf("list sessions with expired artifacts: %w", err)
	}
	return sessions, nil
}

// ListSnapshotsEligibleForGC returns tombstoned snapshots past retention with no GC completion.
func (r *Repository) ListSnapshotsEligibleForGC(ctx context.Context, expiresBefore string) ([]Snapshot, error) {
	snapshots := make([]Snapshot, 0)
	err := r.db.bun.NewSelect().
		Model(&snapshots).
		Where("deleted_at IS NOT NULL").
		Where("expires_at IS NOT NULL").
		Where("expires_at <= ?", expiresBefore).
		Where("gc_completed_at IS NULL").
		OrderExpr("created_at ASC").
		Scan(ctx)
	if err != nil {
		return nil, fmt.Errorf("list snapshots eligible for gc: %w", err)
	}
	return snapshots, nil
}

// CountRetainedSessionsReferencingSnapshot counts non-expired retained sessions using a snapshot as base.
func (r *Repository) CountRetainedSessionsReferencingSnapshot(ctx context.Context, snapshotID string) (int, error) {
	count, err := r.db.bun.NewSelect().
		Model((*Session)(nil)).
		Where("base_snapshot_id = ?", snapshotID).
		Where("status IN (?)", bun.In([]string{
			SessionStatusRunning,
			SessionStatusDeleted,
			SessionStatusFailed,
			SessionStatusCreating,
		})).
		Count(ctx)
	if err != nil {
		return 0, fmt.Errorf("count sessions referencing snapshot: %w", err)
	}
	return count, nil
}
