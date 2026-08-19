package auth

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/ids"
)

// CreateUserInput configures a local user record.
type CreateUserInput struct {
	Email         *string
	DisplayName   string
	IsSystemAdmin bool
}

// UpdateUserInput replaces mutable user metadata.
type UpdateUserInput struct {
	Email         *string
	DisplayName   string
	IsSystemAdmin bool
}

// UpsertMembershipInput configures a user's tenant scopes.
type UpsertMembershipInput struct {
	TenantID string
	UserID   string
	Scopes   []string
}

// AuditInput describes one security audit entry.
type AuditInput struct {
	TenantID     *string
	Action       string
	ResourceType string
	ResourceID   *string
	Data         map[string]any
}

// CreateUser creates a user account.
func (s *Service) CreateUser(ctx context.Context, input CreateUserInput) (*db.User, error) {
	displayName := strings.TrimSpace(input.DisplayName)
	if displayName == "" {
		return nil, fmt.Errorf("display name is required")
	}
	email := normalizeEmail(input.Email)
	now := db.NowUTC()
	userID, err := ids.NewUUIDv7()
	if err != nil {
		return nil, err
	}

	user := &db.User{
		ID:            userID,
		Email:         email,
		DisplayName:   displayName,
		IsSystemAdmin: input.IsSystemAdmin,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := s.repo.CreateUser(ctx, user); err != nil {
		if isUniqueViolation(err) {
			return nil, ErrUserEmailConflict
		}
		return nil, err
	}
	return user, nil
}

// GetUser returns a user including disabled users.
func (s *Service) GetUser(ctx context.Context, userID string) (*db.User, error) {
	user, err := s.repo.GetUserByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, ErrUserNotFound
	}
	return user, nil
}

// ListUsersPage returns users with cursor pagination.
func (s *Service) ListUsersPage(ctx context.Context, filter db.UserFilter, params db.PageParams) (db.PageResult[db.User], error) {
	return s.repo.ListUsersPage(ctx, filter, params)
}

// UpdateUser updates a user account.
func (s *Service) UpdateUser(ctx context.Context, userID string, input UpdateUserInput) (*db.User, error) {
	displayName := strings.TrimSpace(input.DisplayName)
	if displayName == "" {
		return nil, fmt.Errorf("display name is required")
	}
	if err := s.repo.UpdateUser(ctx, userID, normalizeEmail(input.Email), displayName, input.IsSystemAdmin, db.NowUTC()); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		if isUniqueViolation(err) {
			return nil, ErrUserEmailConflict
		}
		return nil, err
	}
	return s.GetUser(ctx, userID)
}

// DisableUser prevents a user from authenticating.
func (s *Service) DisableUser(ctx context.Context, userID string) (*db.User, error) {
	disabledAt := db.NowUTC()
	if err := s.repo.SetUserDisabledAt(ctx, userID, &disabledAt, disabledAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		return nil, err
	}
	return s.GetUser(ctx, userID)
}

// RestoreUser re-enables a user.
func (s *Service) RestoreUser(ctx context.Context, userID string) (*db.User, error) {
	if err := s.repo.SetUserDisabledAt(ctx, userID, nil, db.NowUTC()); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		return nil, err
	}
	return s.GetUser(ctx, userID)
}

// UpsertTenantMembership creates or replaces a user's tenant scopes.
func (s *Service) UpsertTenantMembership(ctx context.Context, input UpsertMembershipInput) (*db.TenantMembership, error) {
	if err := ValidateScopes(AuthorityTenant, input.Scopes); err != nil {
		return nil, err
	}
	if _, err := s.requireActiveTenant(ctx, input.TenantID); err != nil {
		return nil, err
	}
	user, err := s.GetUser(ctx, input.UserID)
	if err != nil {
		return nil, err
	}
	if user.DisabledAt != nil {
		return nil, ErrUserDisabled
	}
	scopesJSON, err := MarshalScopesJSON(input.Scopes)
	if err != nil {
		return nil, err
	}
	now := db.NowUTC()
	membership, err := s.repo.GetTenantMembership(ctx, input.TenantID, input.UserID)
	if err != nil {
		return nil, err
	}
	createdAt := now
	if membership != nil {
		createdAt = membership.CreatedAt
	}
	membership = &db.TenantMembership{
		TenantID:   input.TenantID,
		UserID:     input.UserID,
		ScopesJSON: scopesJSON,
		CreatedAt:  createdAt,
		UpdatedAt:  now,
	}
	if err := s.repo.UpsertTenantMembership(ctx, membership); err != nil {
		return nil, err
	}
	return membership, nil
}

// ListTenantMemberships returns all memberships for a tenant.
func (s *Service) ListTenantMemberships(ctx context.Context, tenantID string) ([]db.TenantMembership, error) {
	if _, err := s.GetTenant(ctx, tenantID); err != nil {
		return nil, err
	}
	return s.repo.ListTenantMemberships(ctx, tenantID)
}

// ListUserMemberships returns all memberships for a user.
func (s *Service) ListUserMemberships(ctx context.Context, userID string) ([]db.TenantMembership, error) {
	if _, err := s.GetUser(ctx, userID); err != nil {
		return nil, err
	}
	return s.repo.ListUserMemberships(ctx, userID)
}

// DeleteTenantMembership removes a user's tenant access.
func (s *Service) DeleteTenantMembership(ctx context.Context, tenantID, userID string) error {
	if err := s.repo.DeleteTenantMembership(ctx, tenantID, userID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrMembershipNotFound
		}
		return err
	}
	return nil
}

// RecordAudit records a security audit event for the authenticated principal.
func (s *Service) RecordAudit(ctx context.Context, principal Principal, input AuditInput) error {
	event, err := s.newAuditEvent(principal, input)
	if err != nil {
		return err
	}
	return s.repo.CreateAuditEvent(ctx, event)
}

func (s *Service) newAuditEvent(principal Principal, input AuditInput) (*db.AuditEvent, error) {
	action := strings.TrimSpace(input.Action)
	resourceType := strings.TrimSpace(input.ResourceType)
	if action == "" || resourceType == "" {
		return nil, fmt.Errorf("audit action and resource type are required")
	}
	data := input.Data
	if data == nil {
		data = map[string]any{}
	}
	dataJSON, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("marshal audit data: %w", err)
	}
	eventID, err := ids.NewUUIDv7()
	if err != nil {
		return nil, err
	}
	var actorID *string
	if principal.ID != "" {
		value := principal.ID
		actorID = &value
	}
	return &db.AuditEvent{
		ID:           eventID,
		ActorType:    principal.Type,
		ActorID:      actorID,
		TenantID:     input.TenantID,
		Action:       action,
		ResourceType: resourceType,
		ResourceID:   input.ResourceID,
		DataJSON:     string(dataJSON),
		CreatedAt:    db.NowUTC(),
	}, nil
}

// ListAuditEventsPage returns security audit entries.
func (s *Service) ListAuditEventsPage(ctx context.Context, filter db.AuditEventFilter, params db.PageParams) (db.PageResult[db.AuditEvent], error) {
	return s.repo.ListAuditEventsPage(ctx, filter, params)
}

func normalizeEmail(email *string) *string {
	if email == nil {
		return nil
	}
	normalized := strings.ToLower(strings.TrimSpace(*email))
	if normalized == "" {
		return nil
	}
	return &normalized
}
