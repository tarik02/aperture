package session

import (
	"context"
	"strings"

	"github.com/aperture/aperture/internal/db"
)

// ValidateCDPForwardAuth checks a CDP bearer token for Traefik ForwardAuth.
func (s *Service) ValidateCDPForwardAuth(ctx context.Context, routeSessionID, authorization string) error {
	_, err := s.authorizedCDPSession(ctx, routeSessionID, authorization)
	return err
}

// AuthorizedCDPPort checks a CDP bearer token and returns the running CDP port.
func (s *Service) AuthorizedCDPPort(ctx context.Context, routeSessionID, authorization string) (int, error) {
	sessionRow, err := s.authorizedCDPSession(ctx, routeSessionID, authorization)
	if err != nil {
		return 0, err
	}
	if sessionRow.CurrentCDPPort == nil || *sessionRow.CurrentCDPPort <= 0 {
		return 0, ErrNotRunning
	}
	return *sessionRow.CurrentCDPPort, nil
}

func (s *Service) authorizedCDPSession(ctx context.Context, routeSessionID, authorization string) (*db.Session, error) {
	routeSessionID = strings.TrimSpace(routeSessionID)
	if routeSessionID == "" {
		return nil, ErrNotFound
	}

	rawToken, err := bearerToken(authorization)
	if err != nil {
		return nil, err
	}

	tokenSessionID, secret, err := ParseCDPToken(rawToken)
	if err != nil {
		return nil, ErrCDPTokenInvalid
	}
	if tokenSessionID != routeSessionID {
		return nil, ErrCDPTokenInvalid
	}

	tokenRow, err := s.repo.GetSessionToken(ctx, routeSessionID)
	if err != nil {
		return nil, err
	}
	if tokenRow == nil {
		return nil, ErrCDPTokenInvalid
	}
	if tokenRow.RevokedAt != nil {
		return nil, ErrCDPTokenRevoked
	}
	if !VerifyCDPToken(tokenRow.TokenHash, secret) {
		return nil, ErrCDPTokenInvalid
	}

	sessionRow, err := s.repo.GetSessionByID(ctx, routeSessionID)
	if err != nil {
		return nil, err
	}
	if sessionRow == nil {
		return nil, ErrNotFound
	}
	if sessionRow.Status != db.SessionStatusRunning {
		return nil, ErrNotRunning
	}
	if isExpired(sessionRow.ExpiresAt, s.now().UTC()) {
		return nil, ErrExpired
	}
	if tokenRow.TenantID != sessionRow.TenantID {
		return nil, ErrCDPTokenInvalid
	}

	tenant, err := s.repo.GetTenantByID(ctx, sessionRow.TenantID)
	if err != nil {
		return nil, err
	}
	if tenant == nil || tenant.DeletedAt != nil {
		return nil, ErrCDPTokenInvalid
	}

	return sessionRow, nil
}

func bearerToken(authorization string) (string, error) {
	authorization = strings.TrimSpace(authorization)
	if authorization == "" {
		return "", ErrCDPTokenMissing
	}

	const prefix = "Bearer "
	if !strings.HasPrefix(authorization, prefix) {
		return "", ErrCDPTokenInvalid
	}

	raw := strings.TrimSpace(authorization[len(prefix):])
	if raw == "" {
		return "", ErrCDPTokenMissing
	}
	return raw, nil
}
