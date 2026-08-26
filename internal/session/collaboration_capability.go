package session

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
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
	SessionID  string
	TenantID   string
	Role       CollaborationRole
	Generation string
	Session    *db.Session
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
	return &CollaborationCapabilityAuth{
		SessionID:  tokenSessionID,
		TenantID:   capability.TenantID,
		Role:       role,
		Generation: capability.TokenHash,
		Session:    sessionRow,
	}, nil
}

// WakeCollaborationSession validates a collaboration capability and waits until its session is ready.
func (s *Service) WakeCollaborationSession(ctx context.Context, routeSessionID, authorization string) (*CollaborationCapabilityAuth, error) {
	routeSessionID = strings.TrimSpace(routeSessionID)
	unlock := s.repo.LockSession(routeSessionID)
	authorized, err := s.AuthenticateCollaborationCapability(ctx, routeSessionID, authorization)
	if err != nil {
		unlock()
		return nil, err
	}
	release := s.acquireInhibitor(authorized.SessionID)
	unlock()

	sessionRow, err := s.ensureSessionRunning(ctx, authorized.Session)
	if err != nil {
		release()
		return nil, err
	}
	if err := s.touchConnected(ctx, sessionRow); err != nil {
		release()
		return nil, err
	}
	release()
	authorized.Session = sessionRow
	return authorized, nil
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
	tenant, err := s.repo.GetTenantByID(ctx, sessionRow.TenantID)
	if err != nil {
		return nil, err
	}
	if tenant == nil || tenant.DeletedAt != nil {
		return nil, ErrSessionTokenInvalid
	}
	return sessionRow, nil
}

func (s *Service) ensureCollaborationCapabilities(ctx context.Context, sessionRow db.Session) (CollaborationCapabilitiesView, error) {
	capabilities, err := s.ensureCollaborationCapabilitiesForSessions(ctx, []db.Session{sessionRow})
	if err != nil {
		return CollaborationCapabilitiesView{}, err
	}
	result, ok := capabilities[sessionRow.ID]
	if !ok {
		return CollaborationCapabilitiesView{}, ErrInvalidState
	}
	return result, nil
}

func (s *Service) ensureCollaborationCapabilitiesForSessions(ctx context.Context, sessionRows []db.Session) (map[string]CollaborationCapabilitiesView, error) {
	result := make(map[string]CollaborationCapabilitiesView, len(sessionRows))
	if len(sessionRows) == 0 {
		return result, nil
	}
	sessionIDs := make([]string, 0, len(sessionRows))
	for _, sessionRow := range sessionRows {
		sessionIDs = append(sessionIDs, sessionRow.ID)
		result[sessionRow.ID] = CollaborationCapabilitiesView{}
	}
	capabilities, err := s.repo.ListSessionCollaborationCapabilitiesForSessions(ctx, sessionIDs)
	if err != nil {
		return nil, err
	}
	type capabilityKey struct {
		sessionID string
		role      string
	}
	present := make(map[capabilityKey]struct{}, len(capabilities))
	for _, capability := range capabilities {
		present[capabilityKey{sessionID: capability.SessionID, role: capability.Role}] = struct{}{}
	}
	missing := make([]db.SessionCollaborationCapability, 0)
	now := s.now().UTC().Format(time.RFC3339Nano)
	for _, sessionRow := range sessionRows {
		for _, role := range []CollaborationRole{CollaborationRoleEditor, CollaborationRoleViewer} {
			if _, ok := present[capabilityKey{sessionID: sessionRow.ID, role: string(role)}]; ok {
				continue
			}
			raw, hash, err := GenerateCollaborationCapability(sessionRow.ID, role)
			if err != nil {
				return nil, err
			}
			missing = append(missing, db.SessionCollaborationCapability{
				SessionID: sessionRow.ID,
				Role:      string(role),
				TenantID:  sessionRow.TenantID,
				TokenHash: hash,
				RawToken:  raw,
				CreatedAt: now,
			})
		}
	}
	if len(missing) > 0 {
		if err := s.repo.CreateSessionCollaborationCapabilities(ctx, missing); err != nil {
			return nil, err
		}
		capabilities, err = s.repo.ListSessionCollaborationCapabilitiesForSessions(ctx, sessionIDs)
		if err != nil {
			return nil, err
		}
	}
	for _, capability := range capabilities {
		view, ok := result[capability.SessionID]
		if !ok {
			continue
		}
		switch CollaborationRole(capability.Role) {
		case CollaborationRoleEditor:
			view.Editor = capability.RawToken
		case CollaborationRoleViewer:
			view.Viewer = capability.RawToken
		}
		result[capability.SessionID] = view
	}
	for _, sessionRow := range sessionRows {
		view := result[sessionRow.ID]
		if view.Editor == "" || view.Viewer == "" {
			return nil, ErrInvalidState
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
	current, err := s.repo.GetSessionCollaborationCapability(ctx, sessionID, string(role))
	if err != nil {
		return nil, err
	}
	if current == nil {
		return nil, ErrInvalidState
	}
	if err := disconnectCollaborationCapabilityConsumers(ctx, sessionRow, role, current.TokenHash); err != nil {
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

func disconnectCollaborationCapabilityConsumers(ctx context.Context, sessionRow *db.Session, role CollaborationRole, generation string) error {
	if sessionRow.Status != db.SessionStatusRunning {
		return nil
	}
	port, err := wrapperPort(sessionRow)
	if err != nil {
		return fmt.Errorf("disconnect %s collaboration clients: %w", role, err)
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		fmt.Sprintf(
			"http://127.0.0.1:%d/collaboration/capability-rotated?role=%s&generation=%s",
			port,
			role,
			url.QueryEscape(generation),
		),
		nil,
	)
	if err != nil {
		return fmt.Errorf("disconnect %s collaboration clients: %w", role, err)
	}
	response, err := (&http.Client{Timeout: time.Second}).Do(request)
	if err != nil {
		return fmt.Errorf("disconnect %s collaboration clients: %w", role, err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusNoContent {
		return fmt.Errorf("disconnect %s collaboration clients: unexpected wrapper status %s", role, response.Status)
	}
	return nil
}
