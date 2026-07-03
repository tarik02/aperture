package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/uptrace/bun"
)

const (
	SessionStatusCreating = "creating"
	SessionStatusRunning  = "running"
	SessionStatusDeleted  = "deleted"
	SessionStatusExpired  = "expired"
	SessionStatusFailed   = "failed"
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

// CreateSessionToken inserts a session CDP token row.
func (r *Repository) CreateSessionToken(ctx context.Context, token *SessionToken) error {
	_, err := r.db.bun.NewInsert().Model(token).Exec(ctx)
	if err != nil {
		return fmt.Errorf("insert session token: %w", err)
	}
	return nil
}

// GetSessionToken returns the persisted CDP token row for a session.
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
