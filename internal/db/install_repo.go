package db

import (
	"context"
	"fmt"
)

// InstallID returns the identity the database migrations gave this install.
func (r *Repository) InstallID(ctx context.Context) (string, error) {
	var installID string
	if err := r.db.bun.NewRaw("SELECT install_id FROM install_identity WHERE id = 1").Scan(ctx, &installID); err != nil {
		return "", fmt.Errorf("select install id: %w", err)
	}
	return installID, nil
}

// HasColdData reports whether a snapshot that garbage collection has not removed
// or a session that has not expired exists. Their files live under cold_root.
func (r *Repository) HasColdData(ctx context.Context) (bool, error) {
	var exists bool
	err := r.db.bun.NewRaw(
		"SELECT EXISTS (SELECT 1 FROM snapshots WHERE gc_completed_at IS NULL) OR EXISTS (SELECT 1 FROM sessions WHERE status != ?)",
		SessionStatusExpired,
	).Scan(ctx, &exists)
	if err != nil {
		return false, fmt.Errorf("check for snapshots and sessions: %w", err)
	}
	return exists, nil
}
