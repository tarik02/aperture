package session

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/db"
)

type CollaborationRole string

const (
	CollaborationRoleEditor CollaborationRole = "editor"
	CollaborationRoleViewer CollaborationRole = "viewer"
)

type CollaborationCapabilitiesView struct {
	Editor string
	Viewer string
}

type CollaborationCapabilityAuth struct {
	SessionID string
	TenantID  string
	Role      CollaborationRole
	Session   *db.Session
}

func collaborationCapabilityPrefix(role CollaborationRole) (string, error) {
	switch role {
	case CollaborationRoleEditor:
		return "ape_", nil
	case CollaborationRoleViewer:
		return "apv_", nil
	default:
		return "", fmt.Errorf("invalid collaboration role %q", role)
	}
}

func GenerateCollaborationCapability(sessionID string, role CollaborationRole) (raw string, hash string, err error) {
	prefix, err := collaborationCapabilityPrefix(role)
	if err != nil {
		return "", "", err
	}
	secretBytes := make([]byte, sessionTokenSecretBytes)
	if _, err := rand.Read(secretBytes); err != nil {
		return "", "", fmt.Errorf("generate collaboration capability secret: %w", err)
	}
	secret := base64.RawURLEncoding.EncodeToString(secretBytes)
	raw = fmt.Sprintf("%s%s_%s", prefix, sessionID, secret)
	hash, err = auth.HashSecret(secret)
	return raw, hash, err
}

func ParseCollaborationCapability(raw string) (sessionID string, role CollaborationRole, secret string, err error) {
	switch {
	case strings.HasPrefix(raw, "ape_"):
		role = CollaborationRoleEditor
	case strings.HasPrefix(raw, "apv_"):
		role = CollaborationRoleViewer
	default:
		return "", "", "", ErrSessionTokenInvalid
	}
	rest := raw[4:]
	const uuidLength = 36
	if len(rest) <= uuidLength+1 || rest[uuidLength] != '_' {
		return "", "", "", ErrSessionTokenInvalid
	}
	sessionID = rest[:uuidLength]
	secret = rest[uuidLength+1:]
	if sessionID == "" || secret == "" {
		return "", "", "", ErrSessionTokenInvalid
	}
	return sessionID, role, secret, nil
}

func (s *Service) AuthenticateCollaborationCapability(ctx context.Context, routeSessionID, authorization string) (*CollaborationCapabilityAuth, error) {
	rawToken, err := bearerToken(authorization)
	if err != nil {
		return nil, err
	}
	tokenSessionID, role, secret, err := ParseCollaborationCapability(rawToken)
	if err != nil || tokenSessionID != strings.TrimSpace(routeSessionID) {
		return nil, ErrSessionTokenInvalid
	}
	capability, err := s.repo.GetSessionCollaborationCapability(ctx, tokenSessionID, string(role))
	if err != nil {
		return nil, err
	}
	if capability == nil || capability.RevokedAt != nil || !s.successCache.Verify(capability.TokenHash, secret) {
		return nil, ErrSessionTokenInvalid
	}
	sessionRow, err := s.authorizedCollaborationSession(ctx, tokenSessionID, capability.TenantID)
	if err != nil {
		return nil, err
	}
	return &CollaborationCapabilityAuth{SessionID: tokenSessionID, TenantID: capability.TenantID, Role: role, Session: sessionRow}, nil
}

func (s *Service) authorizedCollaborationSession(ctx context.Context, sessionID, tenantID string) (*db.Session, error) {
	sessionRow, err := s.repo.GetSessionByID(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if sessionRow == nil {
		return nil, ErrNotFound
	}
	if sessionRow.Status != db.SessionStatusRunning && sessionRow.Status != db.SessionStatusSuspended {
		return nil, ErrNotRunning
	}
	if isExpired(sessionRow.ExpiresAt, s.now().UTC()) {
		return nil, ErrExpired
	}
	if sessionRow.TenantID != tenantID {
		return nil, ErrSessionTokenInvalid
	}
	return sessionRow, nil
}

func (s *Service) ensureCollaborationCapabilities(ctx context.Context, sessionRow db.Session) (CollaborationCapabilitiesView, error) {
	result := CollaborationCapabilitiesView{}
	for _, role := range []CollaborationRole{CollaborationRoleEditor, CollaborationRoleViewer} {
		capability, err := s.repo.GetSessionCollaborationCapability(ctx, sessionRow.ID, string(role))
		if err != nil {
			return CollaborationCapabilitiesView{}, err
		}
		if capability == nil {
			raw, hash, err := GenerateCollaborationCapability(sessionRow.ID, role)
			if err != nil {
				return CollaborationCapabilitiesView{}, err
			}
			capability = &db.SessionCollaborationCapability{
				SessionID: sessionRow.ID,
				Role:      string(role),
				TenantID:  sessionRow.TenantID,
				TokenHash: hash,
				RawToken:  raw,
				CreatedAt: s.now().UTC().Format(time.RFC3339Nano),
			}
			if err := s.repo.CreateSessionCollaborationCapability(ctx, capability); err != nil {
				return CollaborationCapabilitiesView{}, err
			}
		}
		switch role {
		case CollaborationRoleEditor:
			result.Editor = capability.RawToken
		case CollaborationRoleViewer:
			result.Viewer = capability.RawToken
		}
	}
	return result, nil
}

func (s *Service) RotateCollaborationCapability(ctx context.Context, tenantID, sessionID string, role CollaborationRole) (*SessionView, error) {
	if _, err := collaborationCapabilityPrefix(role); err != nil {
		return nil, ErrInvalidState
	}
	unlock := s.repo.LockSession(sessionID)
	defer unlock()
	sessionRow, err := s.requireTenantSession(ctx, tenantID, sessionID)
	if err != nil {
		return nil, err
	}
	if !isRetainedOrRunning(sessionRow.Status) {
		return nil, ErrInvalidState
	}
	capabilities, err := s.ensureCollaborationCapabilities(ctx, *sessionRow)
	if err != nil {
		return nil, err
	}
	raw, hash, err := GenerateCollaborationCapability(sessionID, role)
	if err != nil {
		return nil, err
	}
	if err := s.repo.ReplaceSessionCollaborationCapability(ctx, sessionID, string(role), hash, raw, s.now().UTC().Format(time.RFC3339Nano)); err != nil {
		return nil, err
	}
	switch role {
	case CollaborationRoleEditor:
		capabilities.Editor = raw
	case CollaborationRoleViewer:
		capabilities.Viewer = raw
	}
	tags, err := s.repo.ListSessionTags(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	view := &SessionView{Session: *sessionRow, Tags: tags, Media: s.sessionMediaView(*sessionRow), CollaborationCapabilities: capabilities}
	if err := s.populateSessionCredentials(ctx, view); err != nil {
		return nil, err
	}
	if err := s.appendEvent(ctx, sessionRow, "session.collaboration_capability_rotated", "session "+string(role)+" collaboration capability rotated", nil); err != nil {
		return nil, err
	}
	return view, nil
}
