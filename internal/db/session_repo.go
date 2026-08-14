package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/uptrace/bun"
)

const (
	SessionStatusCreating  = "creating"
	SessionStatusRunning   = "running"
	SessionStatusSuspended = "suspended"
	SessionStatusDeleted   = "deleted"
	SessionStatusExpired   = "expired"
	SessionStatusFailed    = "failed"
	sessionClaimLease      = 5 * time.Minute
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

// ClaimSessionIncarnation marks an incarnation as being prepared or cleaned up.
func (r *Repository) ClaimSessionIncarnation(ctx context.Context, sessionID, expectedStatus string, expectedStartedAt *string, claimToken string) (bool, error) {
	now := time.Now().UTC()
	query := r.db.bun.NewUpdate().Model((*Session)(nil)).
		Set("status = ?", SessionStatusCreating).
		Set("claim_token = ?", claimToken).
		Set("claim_expires_at = ?", now.Add(sessionClaimLease).Format(time.RFC3339Nano)).
		Where("id = ?", sessionID).
		Where("((status = ? AND (claim_token IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)) OR (status = ? AND claim_token IS NOT NULL AND claim_expires_at <= ?))", expectedStatus, now.Format(time.RFC3339Nano), SessionStatusCreating, now.Format(time.RFC3339Nano))
	if expectedStartedAt == nil {
		query = query.Where("started_at IS NULL")
	} else {
		query = query.Where("started_at = ?", *expectedStartedAt)
	}
	result, err := query.Exec(ctx)
	if err != nil {
		return false, fmt.Errorf("claim session incarnation: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("claim session incarnation rows affected: %w", err)
	}
	return rows > 0, nil
}

// ReserveSessionClaim validates and extends an exact live claim before an external side effect.
func (r *Repository) ReserveSessionClaim(ctx context.Context, sessionID, claimToken string) (bool, error) {
	now := time.Now().UTC()
	result, err := r.db.bun.NewUpdate().Model((*Session)(nil)).
		Set("claim_expires_at = ?", now.Add(sessionClaimLease).Format(time.RFC3339Nano)).
		Where("id = ? AND status = ? AND claim_token = ? AND claim_expires_at IS NOT NULL AND claim_expires_at > ?", sessionID, SessionStatusCreating, claimToken, now.Format(time.RFC3339Nano)).
		Exec(ctx)
	if err != nil {
		return false, fmt.Errorf("reserve session claim: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("reserve session claim rows affected: %w", err)
	}
	return rows > 0, nil
}

// RestoreSessionStatusIfClaimed releases a cleanup claim after successful external work.
func (r *Repository) RestoreSessionStatusIfClaimed(ctx context.Context, sessionID, claimToken, status string, restoredStartedAt *string) error {
	result, err := r.db.bun.NewUpdate().Model((*Session)(nil)).
		Set("status = ?", status).
		Set("started_at = ?", restoredStartedAt).
		Set("claim_token = NULL").
		Set("claim_expires_at = NULL").
		Where("id = ?", sessionID).
		Where("status = ?", SessionStatusCreating).
		Where("claim_token = ?", claimToken).
		Exec(ctx)
	if err != nil {
		return fmt.Errorf("restore claimed session: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("restore claimed session rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("restore claimed session: generation conflict")
	}
	return nil
}

// PromoteClaimedSession atomically promotes a prepared incarnation to running.
func (r *Repository) PromoteClaimedSession(ctx context.Context, session *Session, claimToken string) (bool, error) {
	result, err := r.db.bun.NewUpdate().Model((*Session)(nil)).
		Set("status = ?", SessionStatusRunning).
		Set("started_at = ?", session.StartedAt).
		Set("deleted_at = NULL").
		Set("stopped_at = NULL").
		Set("suspended_at = NULL").
		Set("expires_at = ?", session.ExpiresAt).
		Set("runtime_env_path = ?", session.RuntimeEnvPath).
		Set("current_cdp_port = ?", session.CurrentCDPPort).
		Set("last_connected_at = ?", session.LastConnectedAt).
		Set("claim_token = NULL").
		Set("claim_expires_at = NULL").
		Where("id = ?", session.ID).
		Where("status = ?", SessionStatusCreating).
		Where("claim_token = ?", claimToken).
		Exec(ctx)
	if err != nil {
		return false, fmt.Errorf("promote claimed session: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("promote claimed session rows affected: %w", err)
	}
	return rows > 0, nil
}

// FinalizeDeletedSessionIfClaimed publishes a deleted session and releases its claim atomically.
func (r *Repository) FinalizeDeletedSessionIfClaimed(ctx context.Context, session *Session, claimToken string) (bool, error) {
	result, err := r.db.bun.NewUpdate().Model((*Session)(nil)).
		Set("status = ?", SessionStatusDeleted).
		Set("deleted_at = ?", session.DeletedAt).
		Set("stopped_at = ?", session.StoppedAt).
		Set("suspended_at = NULL").
		Set("expires_at = ?", session.ExpiresAt).
		Set("runtime_env_path = NULL").
		Set("current_cdp_port = NULL").
		Set("claim_token = NULL").
		Set("claim_expires_at = NULL").
		Where("id = ?", session.ID).
		Where("status = ?", SessionStatusCreating).
		Where("claim_token = ?", claimToken).
		Exec(ctx)
	if err != nil {
		return false, fmt.Errorf("finalize deleted session: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("finalize deleted session rows affected: %w", err)
	}
	return rows > 0, nil
}

// FinalizeSuspendedSessionIfClaimed publishes a suspended session and releases its claim atomically.
func (r *Repository) FinalizeSuspendedSessionIfClaimed(ctx context.Context, session *Session, claimToken string) (bool, error) {
	result, err := r.db.bun.NewUpdate().Model((*Session)(nil)).
		Set("status = ?", SessionStatusSuspended).
		Set("stopped_at = ?", session.StoppedAt).
		Set("suspended_at = ?", session.SuspendedAt).
		Set("expires_at = ?", session.ExpiresAt).
		Set("claim_token = NULL").
		Set("claim_expires_at = NULL").
		Where("id = ?", session.ID).
		Where("status = ?", SessionStatusCreating).
		Where("claim_token = ?", claimToken).
		Exec(ctx)
	if err != nil {
		return false, fmt.Errorf("finalize suspended session: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("finalize suspended session rows affected: %w", err)
	}
	return rows > 0, nil
}

// FinalizeExpiredSessionIfClaimed publishes an expired session and releases its claim atomically.
func (r *Repository) FinalizeExpiredSessionIfClaimed(ctx context.Context, session *Session, claimToken string) (bool, error) {
	result, err := r.db.bun.NewUpdate().Model((*Session)(nil)).
		Set("status = ?", SessionStatusExpired).
		Set("expired_at = ?", session.ExpiredAt).
		Set("runtime_env_path = NULL").
		Set("current_cdp_port = NULL").
		Set("stopped_at = ?", session.StoppedAt).
		Set("suspended_at = NULL").
		Set("claim_token = NULL").
		Set("claim_expires_at = NULL").
		Where("id = ?", session.ID).
		Where("status = ?", SessionStatusCreating).
		Where("claim_token = ?", claimToken).
		Exec(ctx)
	if err != nil {
		return false, fmt.Errorf("finalize expired session: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("finalize expired session rows affected: %w", err)
	}
	return rows > 0, nil
}

func (r *Repository) ReleaseSessionClaim(ctx context.Context, sessionID, claimToken string) error {
	result, err := r.db.bun.NewUpdate().Model((*Session)(nil)).
		Set("claim_token = NULL").Set("claim_expires_at = NULL").
		Where("id = ? AND status = ? AND claim_token = ?", sessionID, SessionStatusRunning, claimToken).Exec(ctx)
	if err != nil {
		return fmt.Errorf("release session claim: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("release session claim rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("release session claim: generation conflict")
	}
	return nil
}

// MarkSessionFailedIfGeneration transitions a session only when its status and incarnation are unchanged.
func (r *Repository) MarkSessionFailedIfGeneration(ctx context.Context, sessionID, expectedStatus string, expectedStartedAt *string, stoppedAt string) (bool, error) {
	return markSessionFailed(ctx, r.db.bun, sessionID, expectedStatus, expectedStartedAt, stoppedAt)
}

func (r *Repository) MarkSessionFailedIfUnclaimedGeneration(ctx context.Context, sessionID, expectedStatus, expectedStartedAt, stoppedAt string) (bool, error) {
	result, err := r.db.bun.NewUpdate().Model((*Session)(nil)).
		Set("status = ?", SessionStatusFailed).Set("stopped_at = ?", stoppedAt).
		Set("suspended_at = NULL").Set("runtime_env_path = NULL").Set("current_cdp_port = NULL").Set("claim_token = NULL").Set("claim_expires_at = NULL").
		Where("id = ? AND status = ? AND started_at = ? AND claim_token IS NULL", sessionID, expectedStatus, expectedStartedAt).Exec(ctx)
	if err != nil {
		return false, fmt.Errorf("mark unclaimed session failed: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("mark unclaimed session failed rows affected: %w", err)
	}
	return rows > 0, nil
}

// MarkSessionFailedIfClaimed transitions only the exact durable claim.
func (r *Repository) MarkSessionFailedIfClaimed(ctx context.Context, sessionID, claimToken, stoppedAt string) (bool, error) {
	result, err := r.db.bun.NewUpdate().Model((*Session)(nil)).
		Set("status = ?", SessionStatusFailed).
		Set("stopped_at = ?", stoppedAt).
		Set("suspended_at = NULL").
		Set("runtime_env_path = NULL").
		Set("current_cdp_port = NULL").
		Set("claim_token = NULL").
		Set("claim_expires_at = NULL").
		Where("id = ? AND status IN (?, ?) AND claim_token = ?", sessionID, SessionStatusCreating, SessionStatusRunning, claimToken).
		Exec(ctx)
	if err != nil {
		return false, fmt.Errorf("mark claimed session failed: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("mark claimed session failed rows affected: %w", err)
	}
	return rows > 0, nil
}

// RestoreFailedSessionStartedAt restores the last successful start only for the failed incarnation.
func (r *Repository) RestoreFailedSessionStartedAt(ctx context.Context, sessionID, failedStartedAt string, restoredStartedAt *string) error {
	result, err := r.db.bun.NewUpdate().
		Model((*Session)(nil)).
		Set("started_at = ?", restoredStartedAt).
		Where("id = ?", sessionID).
		Where("status = ?", SessionStatusFailed).
		Where("started_at = ?", failedStartedAt).
		Where("claim_token IS NULL").
		Exec(ctx)
	if err != nil {
		return fmt.Errorf("restore failed session start: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("restore failed session start rows affected: %w", err)
	}
	if rows > 0 {
		return nil
	}

	current := new(Session)
	if err := r.db.bun.NewSelect().Model(current).
		Column("status", "started_at", "claim_token").
		Where("id = ?", sessionID).
		Scan(ctx); err != nil {
		return fmt.Errorf("restore failed session start: %w", err)
	}
	if current.Status == SessionStatusFailed && current.ClaimToken == nil &&
		((current.StartedAt == nil && restoredStartedAt == nil) ||
			(current.StartedAt != nil && restoredStartedAt != nil && *current.StartedAt == *restoredStartedAt)) {
		return nil
	}
	return fmt.Errorf("restore failed session start: generation conflict")
}

func markSessionFailed(ctx context.Context, db bun.IDB, sessionID, expectedStatus string, expectedStartedAt *string, stoppedAt string) (bool, error) {
	query := db.NewUpdate().
		Model((*Session)(nil)).
		Set("status = ?", SessionStatusFailed).
		Set("stopped_at = ?", stoppedAt).
		Set("suspended_at = NULL").
		Set("runtime_env_path = NULL").
		Set("current_cdp_port = NULL").
		Set("claim_token = NULL").
		Set("claim_expires_at = NULL").
		Where("id = ?", sessionID).
		Where("status = ?", expectedStatus)
	query = query.Where("claim_token IS NULL")
	if expectedStartedAt == nil {
		query = query.Where("started_at IS NULL")
	} else {
		query = query.Where("started_at = ?", *expectedStartedAt)
	}
	result, err := query.Exec(ctx)
	if err != nil {
		return false, fmt.Errorf("mark session failed: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("mark session failed rows affected: %w", err)
	}
	return rows > 0, nil
}

// TouchRunningSession refreshes connection and retention timestamps without replacing lifecycle state.
func (r *Repository) TouchRunningSession(ctx context.Context, sessionID string, startedAt *string, connectedAt, expiresAt string) (bool, error) {
	query := r.db.bun.NewUpdate().
		Model((*Session)(nil)).
		Set("last_connected_at = ?", connectedAt).
		Set("expires_at = ?", expiresAt).
		Where("id = ?", sessionID).
		Where("status = ?", SessionStatusRunning).
		Where("claim_token IS NULL")
	if startedAt == nil {
		query = query.Where("started_at IS NULL")
	} else {
		query = query.Where("started_at = ?", *startedAt)
	}
	result, err := query.Exec(ctx)
	if err != nil {
		return false, fmt.Errorf("touch running session: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("touch running session rows affected: %w", err)
	}
	return rows > 0, nil
}

// RefreshRunningSessionExpiry extends retention without replacing lifecycle state.
func (r *Repository) RefreshRunningSessionExpiry(ctx context.Context, sessionID, expiresAt string) error {
	_, err := r.db.bun.NewUpdate().
		Model((*Session)(nil)).
		Set("expires_at = ?", expiresAt).
		Where("id = ?", sessionID).
		Where("status = ?", SessionStatusRunning).
		Where("claim_token IS NULL").
		Exec(ctx)
	if err != nil {
		return fmt.Errorf("refresh running session expiry: %w", err)
	}
	return nil
}

// RefreshRunningSessionExpiries advances non-expired running session deadlines in one update.
func (r *Repository) RefreshRunningSessionExpiries(ctx context.Context, generations []SessionGeneration, expiresBefore, expiresAt string) error {
	if len(generations) == 0 {
		return nil
	}

	expiresSeconds := rfc3339SecondsExpr("expires_at")
	expiresFraction := rfc3339FractionExpr("expires_at")
	beforeSeconds := rfc3339SecondsExpr("?")
	beforeFraction := rfc3339FractionExpr("?")
	targetSeconds := rfc3339SecondsExpr("?")
	targetFraction := rfc3339FractionExpr("?")
	query := r.db.bun.NewUpdate().
		Model((*Session)(nil)).
		Set("expires_at = ?", expiresAt).
		Where(fmt.Sprintf("(%s > %s OR (%s = %s AND %s > %s))", expiresSeconds, beforeSeconds, expiresSeconds, beforeSeconds, expiresFraction, beforeFraction), expiresBefore, expiresBefore, expiresBefore, expiresBefore, expiresBefore).
		Where(fmt.Sprintf("(%s < %s OR (%s = %s AND %s < %s))", expiresSeconds, targetSeconds, expiresSeconds, targetSeconds, expiresFraction, targetFraction), expiresAt, expiresAt, expiresAt, expiresAt, expiresAt).
		Where("status = ?", SessionStatusRunning).
		Where("claim_token IS NULL")
	parts := make([]string, 0, len(generations))
	args := make([]any, 0, len(generations)*2)
	for _, generation := range generations {
		if generation.StartedAt == nil {
			parts = append(parts, "(id = ? AND started_at IS NULL)")
			args = append(args, generation.ID)
		} else {
			parts = append(parts, "(id = ? AND started_at = ?)")
			args = append(args, generation.ID, *generation.StartedAt)
		}
	}
	_, err := query.Where("("+strings.Join(parts, " OR ")+")", args...).Exec(ctx)
	if err != nil {
		return fmt.Errorf("refresh running session expiries: %w", err)
	}
	return nil
}

// RefreshSessionExpiryIfGeneration updates retention only for an unclaimed, unchanged incarnation.
func (r *Repository) RefreshSessionExpiryIfGeneration(ctx context.Context, sessionID, status string, startedAt *string, expiresAt string) (bool, error) {
	query := r.db.bun.NewUpdate().Model((*Session)(nil)).
		Set("expires_at = ?", expiresAt).
		Where("id = ?", sessionID).
		Where("status = ?", status).
		Where("claim_token IS NULL")
	if startedAt == nil {
		query = query.Where("started_at IS NULL")
	} else {
		query = query.Where("started_at = ?", *startedAt)
	}
	result, err := query.Exec(ctx)
	if err != nil {
		return false, fmt.Errorf("refresh session expiry: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("refresh session expiry rows affected: %w", err)
	}
	return rows > 0, nil
}

func rfc3339SecondsExpr(value string) string {
	return fmt.Sprintf("CAST(strftime('%%s', %s) AS INTEGER)", value)
}

func rfc3339FractionExpr(value string) string {
	return fmt.Sprintf("CASE WHEN instr(%s, '.') > 0 THEN CAST(substr(substr(%s, instr(%s, '.') + 1) || '000000000', 1, 9) AS INTEGER) ELSE 0 END", value, value, value)
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
		Where("status IN (?)", bun.List(statuses)).
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

func (r *Repository) CreateEvents(ctx context.Context, events []Event) error {
	return r.db.WithTx(ctx, func(ctx context.Context, tx bun.Tx) error {
		if _, err := tx.NewInsert().Model(&events).On("CONFLICT (id) DO NOTHING").Exec(ctx); err != nil {
			return fmt.Errorf("insert events: %w", err)
		}
		eventIDs := make([]string, 0, len(events))
		expected := make(map[string]Event, len(events))
		for _, event := range events {
			eventIDs = append(eventIDs, event.ID)
			expected[event.ID] = event
		}
		stored := make([]Event, 0, len(events))
		if err := tx.NewSelect().Model(&stored).Where("id IN (?)", bun.List(eventIDs)).Scan(ctx); err != nil {
			return fmt.Errorf("read events: %w", err)
		}
		if len(stored) != len(events) {
			return fmt.Errorf("verify events: event count mismatch")
		}
		for _, event := range stored {
			candidate := expected[event.ID]
			if event.TenantID != candidate.TenantID || event.ResourceType != candidate.ResourceType || event.ResourceID != candidate.ResourceID || event.Type != candidate.Type || event.Message != candidate.Message || event.DataJSON != candidate.DataJSON {
				return fmt.Errorf("verify events: event id conflict")
			}
		}
		return nil
	})
}

func (r *Repository) ListEventsForResourceType(ctx context.Context, resourceType, resourceID, eventType string) ([]Event, error) {
	events := make([]Event, 0)
	if err := r.db.bun.NewSelect().
		Model(&events).
		Where("resource_type = ?", resourceType).
		Where("resource_id = ?", resourceID).
		Where("type = ?", eventType).
		OrderExpr("created_at ASC").
		Scan(ctx); err != nil {
		return nil, fmt.Errorf("list events by type: %w", err)
	}
	return events, nil
}

func (r *Repository) FinalizeEvents(ctx context.Context, resourceType, resourceID, pendingType, finalType, finalMessage string, eventIDs []string) error {
	return r.db.WithTx(ctx, func(ctx context.Context, tx bun.Tx) error {
		if _, err := tx.NewUpdate().
			Model((*Event)(nil)).
			Set("type = ?", finalType).
			Set("message = ?", finalMessage).
			Where("id IN (?)", bun.List(eventIDs)).
			Where("resource_type = ?", resourceType).
			Where("resource_id = ?", resourceID).
			Where("type = ?", pendingType).
			Exec(ctx); err != nil {
			return fmt.Errorf("finalize events: %w", err)
		}
		stored := make([]Event, 0, len(eventIDs))
		if err := tx.NewSelect().Model(&stored).Where("id IN (?)", bun.List(eventIDs)).Scan(ctx); err != nil {
			return fmt.Errorf("read finalized events: %w", err)
		}
		if len(stored) != len(eventIDs) {
			return fmt.Errorf("verify finalized events: event count mismatch")
		}
		for _, event := range stored {
			if event.ResourceType != resourceType || event.ResourceID != resourceID || event.Type != finalType {
				return fmt.Errorf("verify finalized events: event state mismatch")
			}
		}
		return nil
	})
}

func (r *Repository) DeletePendingEvents(ctx context.Context, resourceType, resourceID, pendingType string, eventIDs []string) error {
	if _, err := r.db.bun.NewDelete().
		Model((*Event)(nil)).
		Where("id IN (?)", bun.List(eventIDs)).
		Where("resource_type = ?", resourceType).
		Where("resource_id = ?", resourceID).
		Where("type = ?", pendingType).
		Exec(ctx); err != nil {
		return fmt.Errorf("delete pending events: %w", err)
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
