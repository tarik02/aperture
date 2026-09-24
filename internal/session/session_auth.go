package session

import (
	"context"
	"slices"
	"strings"

	"github.com/aperture/aperture/internal/db"
)

// SessionTokenAuth identifies a session authorized by its live-access token.
type SessionTokenAuth struct {
	SessionID string
	TenantID  string
	Session   *db.Session
}

// AuthenticateSessionToken validates a session live-access token and returns reusable auth context.
func (s *Service) AuthenticateSessionToken(ctx context.Context, routeSessionID, authorization string) (*SessionTokenAuth, error) {
	sessionRow, err := s.authorizedSession(ctx, routeSessionID, authorization)
	if err != nil {
		return nil, err
	}
	return &SessionTokenAuth{SessionID: sessionRow.ID, TenantID: sessionRow.TenantID, Session: sessionRow}, nil
}

// ValidateSessionTokenForwardAuth checks a session token for Traefik ForwardAuth.
func (s *Service) ValidateSessionTokenForwardAuth(ctx context.Context, routeSessionID, authorization string) error {
	return s.WakeAuthorizedSession(ctx, routeSessionID, authorization)
}

// authorizedSession authorizes a session token for a session clients may use.
func (s *Service) authorizedSession(ctx context.Context, routeSessionID, authorization string) (*db.Session, error) {
	return s.tokenSession(ctx, routeSessionID, authorization, db.SessionStatusRunning, db.SessionStatusSuspended)
}

// wrapperSession authorizes the session's own browser wrapper, which already
// calls Aperture while the session is still being created.
func (s *Service) wrapperSession(ctx context.Context, routeSessionID, authorization string) (*db.Session, error) {
	return s.tokenSession(ctx, routeSessionID, authorization, db.SessionStatusCreating, db.SessionStatusRunning, db.SessionStatusSuspended)
}

func (s *Service) tokenSession(ctx context.Context, routeSessionID, authorization string, allowedStatuses ...string) (*db.Session, error) {
	routeSessionID = strings.TrimSpace(routeSessionID)
	if routeSessionID == "" {
		return nil, ErrNotFound
	}

	rawToken, err := bearerToken(authorization)
	if err != nil {
		return nil, err
	}

	tokenSessionID, secret, err := ParseSessionToken(rawToken)
	if err != nil {
		return nil, ErrSessionTokenInvalid
	}
	if tokenSessionID != routeSessionID {
		return nil, ErrSessionTokenInvalid
	}

	tokenRow, err := s.repo.GetSessionToken(ctx, routeSessionID)
	if err != nil {
		return nil, err
	}
	if tokenRow == nil {
		return nil, ErrSessionTokenInvalid
	}
	if tokenRow.RevokedAt != nil {
		return nil, ErrSessionTokenRevoked
	}
	if !s.successCache.Verify(tokenRow.TokenHash, secret) {
		return nil, ErrSessionTokenInvalid
	}

	sessionRow, err := s.repo.GetSessionByID(ctx, routeSessionID)
	if err != nil {
		return nil, err
	}
	if sessionRow == nil {
		return nil, ErrNotFound
	}
	if !slices.Contains(allowedStatuses, sessionRow.Status) {
		return nil, ErrNotRunning
	}
	if isExpired(sessionRow.ExpiresAt, s.now().UTC()) {
		return nil, ErrExpired
	}
	if tokenRow.TenantID != sessionRow.TenantID {
		return nil, ErrSessionTokenInvalid
	}

	tenant, err := s.repo.GetTenantByID(ctx, sessionRow.TenantID)
	if err != nil {
		return nil, err
	}
	if tenant == nil || tenant.DeletedAt != nil {
		return nil, ErrSessionTokenInvalid
	}

	return sessionRow, nil
}

func bearerToken(authorization string) (string, error) {
	authorization = strings.TrimSpace(authorization)
	if authorization == "" {
		return "", ErrSessionTokenMissing
	}

	const prefix = "Bearer "
	if !strings.HasPrefix(authorization, prefix) {
		return "", ErrSessionTokenInvalid
	}

	raw := strings.TrimSpace(authorization[len(prefix):])
	if raw == "" {
		return "", ErrSessionTokenMissing
	}
	return raw, nil
}
