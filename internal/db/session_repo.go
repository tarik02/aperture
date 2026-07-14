package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/uptrace/bun"
)

const (
	SessionStatusCreating  = "creating"
	SessionStatusRunning   = "running"
	SessionStatusSuspended = "suspended"
	SessionStatusDeleted   = "deleted"
	SessionStatusExpired   = "expired"
	SessionStatusFailed    = "failed"
)

// CreateSession inserts a session row.
func (r *Repository) CreateSession(ctx context.Context, session *Session) error {
	_, err := r.db.bun.NewInsert().Model(session).Exec(ctx)
	if err != nil {
		return fmt.Errorf("insert session: %w", err)
	}
	return nil
}

// GetSessionByID returns a session by id.
func (r *Repository) GetSessionByID(ctx context.Context, sessionID string) (*Session, error) {
	session := new(Session)
	err := r.db.bun.NewSelect().
		Model(session).
		Where("id = ?", sessionID).
		Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select session: %w", err)
	}
	return session, nil
}

// GetSessionByTenantAndID returns a tenant-owned session.
func (r *Repository) GetSessionByTenantAndID(ctx context.Context, tenantID, sessionID string) (*Session, error) {
	session := new(Session)
	err := r.db.bun.NewSelect().
		Model(session).
		Where("id = ?", sessionID).
		Where("tenant_id = ?", tenantID).
		Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select tenant session: %w", err)
	}
	return session, nil
}

// UpdateSession replaces mutable session fields.
func (r *Repository) UpdateSession(ctx context.Context, session *Session) error {
	_, err := r.db.bun.NewUpdate().
		Model(session).
		WherePK().
		Exec(ctx)
	if err != nil {
		return fmt.Errorf("update session: %w", err)
	}
	return nil
}

// ListSessionsByStatus returns sessions with the given status.
func (r *Repository) ListSessionsByStatus(ctx context.Context, status string) ([]Session, error) {
	sessions := make([]Session, 0)
	err := r.db.bun.NewSelect().
		Model(&sessions).
		Where("status = ?", status).
		OrderExpr("created_at ASC").
		Scan(ctx)
	if err != nil {
		return nil, fmt.Errorf("list sessions by status: %w", err)
	}
	return sessions, nil
}

// ListSessionsByStatuses returns sessions with any of the given statuses.
func (r *Repository) ListSessionsByStatuses(ctx context.Context, statuses []string) ([]Session, error) {
	sessions := make([]Session, 0)
	if len(statuses) == 0 {
		return sessions, nil
	}
	err := r.db.bun.NewSelect().
		Model(&sessions).
		Where("status IN (?)", bun.In(statuses)).
		OrderExpr("created_at ASC").
		Scan(ctx)
	if err != nil {
		return nil, fmt.Errorf("list sessions by statuses: %w", err)
	}
	return sessions, nil
}

// ListRunningSessionsIdleBefore returns running sessions without recent connection activity.
func (r *Repository) ListRunningSessionsIdleBefore(ctx context.Context, connectedBefore string) ([]Session, error) {
	sessions := make([]Session, 0)
	err := r.db.bun.NewSelect().
		Model(&sessions).
		Where("status = ?", SessionStatusRunning).
		Where("COALESCE(last_connected_at, started_at, created_at) <= ?", connectedBefore).
		OrderExpr("COALESCE(last_connected_at, started_at, created_at) ASC").
		Scan(ctx)
	if err != nil {
		return nil, fmt.Errorf("list idle running sessions: %w", err)
	}
	return sessions, nil
}

// CreateSessionToken inserts a session token row.
func (r *Repository) CreateSessionToken(ctx context.Context, token *SessionToken) error {
	_, err := r.db.bun.NewInsert().Model(token).Exec(ctx)
	if err != nil {
		return fmt.Errorf("insert session token: %w", err)
	}
	return nil
}

// ReplaceSessionToken updates the stored session token for a session.
func (r *Repository) ReplaceSessionToken(ctx context.Context, sessionID, tokenHash, rawToken, createdAt string) error {
	result, err := r.db.bun.NewUpdate().
		Model((*SessionToken)(nil)).
		Set("token_hash = ?", tokenHash).
		Set("raw_token = ?", rawToken).
		Set("created_at = ?", createdAt).
		Set("revoked_at = NULL").
		Where("session_id = ?", sessionID).
		Exec(ctx)
	if err != nil {
		return fmt.Errorf("replace session token: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("replace session token rows affected: %w", err)
	}
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// GetSessionToken returns the persisted session token row for a session.
func (r *Repository) GetSessionToken(ctx context.Context, sessionID string) (*SessionToken, error) {
	token := new(SessionToken)
	err := r.db.bun.NewSelect().
		Model(token).
		Where("session_id = ?", sessionID).
		Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select session token: %w", err)
	}
	return token, nil
}

// ReplaceSessionTags replaces all tags for a session.
func (r *Repository) ReplaceSessionTags(ctx context.Context, sessionID string, tags []SessionTag) error {
	return r.WithTx(ctx, func(ctx context.Context, tx bun.Tx) error {
		if _, err := tx.NewDelete().
			Model((*SessionTag)(nil)).
			Where("session_id = ?", sessionID).
			Exec(ctx); err != nil {
			return fmt.Errorf("delete session tags: %w", err)
		}
		if len(tags) == 0 {
			return nil
		}
		if _, err := tx.NewInsert().Model(&tags).Exec(ctx); err != nil {
			return fmt.Errorf("insert session tags: %w", err)
		}
		return nil
	})
}

// ListSessionTags returns tags for a session.
func (r *Repository) ListSessionTags(ctx context.Context, sessionID string) (map[string]string, error) {
	tags := make([]SessionTag, 0)
	if err := r.db.bun.NewSelect().
		Model(&tags).
		Where("session_id = ?", sessionID).
		OrderExpr("key ASC").
		Scan(ctx); err != nil {
		return nil, fmt.Errorf("list session tags: %w", err)
	}

	result := make(map[string]string, len(tags))
	for _, tag := range tags {
		result[tag.Key] = tag.Value
	}
	return result, nil
}

// CreateEvent inserts an event row.
func (r *Repository) CreateEvent(ctx context.Context, event *Event) error {
	_, err := r.db.bun.NewInsert().Model(event).Exec(ctx)
	if err != nil {
		return fmt.Errorf("insert event: %w", err)
	}
	return nil
}

// ListEventsForResource returns events for a resource ordered by creation time.
func (r *Repository) ListEventsForResource(ctx context.Context, resourceType, resourceID string) ([]Event, error) {
	events := make([]Event, 0)
	err := r.db.bun.NewSelect().
		Model(&events).
		Where("resource_type = ?", resourceType).
		Where("resource_id = ?", resourceID).
		OrderExpr("created_at ASC").
		Scan(ctx)
	if err != nil {
		return nil, fmt.Errorf("list events: %w", err)
	}
	return events, nil
}
