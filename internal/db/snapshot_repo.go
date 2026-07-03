package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// CreateSnapshot inserts a snapshot row.
func (r *Repository) CreateSnapshot(ctx context.Context, snapshot *Snapshot) error {
	_, err := r.db.bun.NewInsert().Model(snapshot).Exec(ctx)
	if err != nil {
		return fmt.Errorf("insert snapshot: %w", err)
	}
	return nil
}

// GetSnapshotByTenantAndName returns an active snapshot for a tenant by name.
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
