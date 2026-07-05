package session

import (
	"context"
	"strings"

	"github.com/aperture/aperture/internal/db"
)

// ValidateMediaProducerSignalAuth checks a per-session media producer token.
func (s *Service) ValidateMediaProducerSignalAuth(ctx context.Context, routeSessionID, rawToken string) (*db.Session, error) {
	routeSessionID = strings.TrimSpace(routeSessionID)
	if routeSessionID == "" {
		return nil, ErrNotFound
	}
	rawToken = strings.TrimSpace(rawToken)
	if rawToken == "" {
		return nil, ErrMediaTokenMissing
	}

	tokenSessionID, secret, err := ParseMediaToken(rawToken)
	if err != nil {
		return nil, ErrMediaTokenInvalid
	}
	if tokenSessionID != routeSessionID {
		return nil, ErrMediaTokenInvalid
	}

	tokenHash, err := LoadMediaTokenHash(s.cfg, routeSessionID)
	if err != nil {
		return nil, ErrMediaTokenInvalid
	}
	if !VerifyMediaToken(tokenHash, secret) {
		return nil, ErrMediaTokenInvalid
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

	tenant, err := s.repo.GetTenantByID(ctx, sessionRow.TenantID)
	if err != nil {
		return nil, err
	}
	if tenant == nil || tenant.DeletedAt != nil {
		return nil, ErrMediaTokenInvalid
	}

	return sessionRow, nil
}
