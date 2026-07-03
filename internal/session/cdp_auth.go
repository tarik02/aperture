package session

import (
	"context"
	"strings"

	"github.com/aperture/aperture/internal/db"
)

// ValidateCDPForwardAuth checks a CDP bearer token for Traefik ForwardAuth.
func (s *Service) ValidateCDPForwardAuth(ctx context.Context, routeSessionID, authorization string) error {
	routeSessionID = strings.TrimSpace(routeSessionID)
	if routeSessionID == "" {
		return ErrNotFound
	}

	rawToken, err := bearerToken(authorization)
	if err != nil {
		return err
	}

	tokenSessionID, secret, err := ParseCDPToken(rawToken)
	if err != nil {
		return ErrCDPTokenInvalid
	}
	if tokenSessionID != routeSessionID {
		return ErrCDPTokenInvalid
	}

	tokenRow, err := s.repo.GetSessionToken(ctx, routeSessionID)
	if err != nil {
		return err
	}
	if tokenRow == nil {
		return ErrCDPTokenInvalid
	}
	if tokenRow.RevokedAt != nil {
		return ErrCDPTokenRevoked
	}
	if !VerifyCDPToken(tokenRow.TokenHash, secret) {
		return ErrCDPTokenInvalid
	}

	sessionRow, err := s.repo.GetSessionByID(ctx, routeSessionID)
	if err != nil {
		return err
	}
	if sessionRow == nil {
		return ErrNotFound
	}
	if sessionRow.Status != db.SessionStatusRunning {
		return ErrNotRunning
	}
	if isExpired(sessionRow.ExpiresAt, s.now().UTC()) {
		return ErrExpired
	}
	if tokenRow.TenantID != sessionRow.TenantID {
		return ErrCDPTokenInvalid
	}

	tenant, err := s.repo.GetTenantByID(ctx, sessionRow.TenantID)
	if err != nil {
		return err
	}
	if tenant == nil || tenant.DeletedAt != nil {
		return ErrCDPTokenInvalid
	}

	return nil
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
