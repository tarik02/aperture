package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// UserFilter controls user listing behavior.
type UserFilter struct {
	Query           *string
	IncludeDisabled bool
	DisabledOnly    bool
}

// CreateUser inserts a user.
func (r *Repository) CreateUser(ctx context.Context, user *User) error {
	if _, err := r.db.bun.NewInsert().Model(user).Exec(ctx); err != nil {
		return fmt.Errorf("insert user: %w", err)
	}
	return nil
}

// GetUserByID returns a user by id.
func (r *Repository) GetUserByID(ctx context.Context, userID string) (*User, error) {
	user := new(User)
	err := r.db.bun.NewSelect().Model(user).Where("id = ?", userID).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select user: %w", err)
	}
	return user, nil
}

// GetUserByEmail returns a user by case-insensitive email.
func (r *Repository) GetUserByEmail(ctx context.Context, email string) (*User, error) {
	user := new(User)
	err := r.db.bun.NewSelect().Model(user).Where("email = ? COLLATE NOCASE", email).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select user by email: %w", err)
	}
	return user, nil
}

// ListUsersPage returns users with cursor pagination.
func (r *Repository) ListUsersPage(ctx context.Context, filter UserFilter, params PageParams) (PageResult[User], error) {
	params = NormalizePageParams(params)
	cursor, err := parsePageCursor(params)
	if err != nil {
		return PageResult[User]{}, err
	}

	query := r.db.bun.NewSelect().Model((*User)(nil))
	if filter.Query != nil {
		pattern := "%" + strings.ToLower(*filter.Query) + "%"
		query = query.Where("LOWER(display_name) LIKE ? OR LOWER(COALESCE(email, '')) LIKE ?", pattern, pattern)
	}
	if filter.DisabledOnly {
		query = query.Where("disabled_at IS NOT NULL")
	} else if !filter.IncludeDisabled {
		query = query.Where("disabled_at IS NULL")
	}
	query = paginateCreatedAtID(query, params, cursor)

	users := make([]User, 0)
	if err := query.Scan(ctx, &users); err != nil {
		return PageResult[User]{}, fmt.Errorf("list users page: %w", err)
	}
	return buildPageResult(users, params.Limit, func(user User) string { return user.CreatedAt }, func(user User) string { return user.ID })
}

// UpdateUser replaces mutable user metadata.
func (r *Repository) UpdateUser(ctx context.Context, userID string, email *string, displayName string, isSystemAdmin bool, updatedAt string) error {
	result, err := r.db.bun.NewUpdate().Model((*User)(nil)).
		Set("email = ?", email).
		Set("display_name = ?", displayName).
		Set("is_system_admin = ?", isSystemAdmin).
		Set("updated_at = ?", updatedAt).
		Where("id = ?", userID).
		Exec(ctx)
	if err != nil {
		return fmt.Errorf("update user: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("user update rows affected: %w", err)
	}
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// SetUserDisabledAt enables or disables a user.
func (r *Repository) SetUserDisabledAt(ctx context.Context, userID string, disabledAt *string, updatedAt string) error {
	result, err := r.db.bun.NewUpdate().Model((*User)(nil)).
		Set("disabled_at = ?", disabledAt).
		Set("updated_at = ?", updatedAt).
		Where("id = ?", userID).
		Exec(ctx)
	if err != nil {
		return fmt.Errorf("set user disabled state: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("user disabled state rows affected: %w", err)
	}
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// UpsertTenantMembership creates or updates a user's tenant scopes.
func (r *Repository) UpsertTenantMembership(ctx context.Context, membership *TenantMembership) error {
	_, err := r.db.bun.NewInsert().Model(membership).
		On("CONFLICT (tenant_id, user_id) DO UPDATE").
		Set("scopes_json = EXCLUDED.scopes_json").
		Set("updated_at = EXCLUDED.updated_at").
		Exec(ctx)
	if err != nil {
		return fmt.Errorf("upsert tenant membership: %w", err)
	}
	return nil
}

// GetTenantMembership returns one tenant membership.
func (r *Repository) GetTenantMembership(ctx context.Context, tenantID, userID string) (*TenantMembership, error) {
	membership := new(TenantMembership)
	err := r.db.bun.NewSelect().Model(membership).
		Where("tenant_id = ?", tenantID).
		Where("user_id = ?", userID).
		Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select tenant membership: %w", err)
	}
	return membership, nil
}

// ListTenantMemberships returns memberships for a tenant.
func (r *Repository) ListTenantMemberships(ctx context.Context, tenantID string) ([]TenantMembership, error) {
	memberships := make([]TenantMembership, 0)
	if err := r.db.bun.NewSelect().Model(&memberships).
		Where("tenant_id = ?", tenantID).
		OrderExpr("created_at ASC, user_id ASC").
		Scan(ctx); err != nil {
		return nil, fmt.Errorf("list tenant memberships: %w", err)
	}
	return memberships, nil
}

// ListUserMemberships returns memberships for a user.
func (r *Repository) ListUserMemberships(ctx context.Context, userID string) ([]TenantMembership, error) {
	memberships := make([]TenantMembership, 0)
	if err := r.db.bun.NewSelect().Model(&memberships).
		Where("user_id = ?", userID).
		OrderExpr("created_at ASC, tenant_id ASC").
		Scan(ctx); err != nil {
		return nil, fmt.Errorf("list user memberships: %w", err)
	}
	return memberships, nil
}

// ListUserTenants returns active tenants joined through a user's memberships.
func (r *Repository) ListUserTenants(ctx context.Context, userID string) ([]Tenant, error) {
	tenants := make([]Tenant, 0)
	if err := r.db.bun.NewSelect().Model(&tenants).
		Join("JOIN tenant_memberships AS membership ON membership.tenant_id = tenant.id").
		Where("membership.user_id = ?", userID).
		Where("tenant.deleted_at IS NULL").
		OrderExpr("tenant.display_name ASC, tenant.id ASC").
		Scan(ctx); err != nil {
		return nil, fmt.Errorf("list user tenants: %w", err)
	}
	return tenants, nil
}

// DeleteTenantMembership removes a user's access to a tenant.
func (r *Repository) DeleteTenantMembership(ctx context.Context, tenantID, userID string) error {
	result, err := r.db.bun.NewDelete().Model((*TenantMembership)(nil)).
		Where("tenant_id = ?", tenantID).
		Where("user_id = ?", userID).
		Exec(ctx)
	if err != nil {
		return fmt.Errorf("delete tenant membership: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("tenant membership delete rows affected: %w", err)
	}
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// AuditEventFilter controls audit event listing behavior.
type AuditEventFilter struct {
	TenantID     *string
	ActorType    *string
	ActorID      *string
	Action       *string
	ResourceType *string
	ResourceID   *string
}

// CreateAuditEvent inserts an audit event.
func (r *Repository) CreateAuditEvent(ctx context.Context, event *AuditEvent) error {
	if _, err := r.db.bun.NewInsert().Model(event).Exec(ctx); err != nil {
		return fmt.Errorf("insert audit event: %w", err)
	}
	return nil
}

// ListAuditEventsPage returns audit events with cursor pagination.
func (r *Repository) ListAuditEventsPage(ctx context.Context, filter AuditEventFilter, params PageParams) (PageResult[AuditEvent], error) {
	params = NormalizePageParams(params)
	cursor, err := parsePageCursor(params)
	if err != nil {
		return PageResult[AuditEvent]{}, err
	}

	query := r.db.bun.NewSelect().Model((*AuditEvent)(nil))
	if filter.TenantID != nil {
		query = query.Where("tenant_id = ?", *filter.TenantID)
	}
	if filter.ActorType != nil {
		query = query.Where("actor_type = ?", *filter.ActorType)
	}
	if filter.ActorID != nil {
		query = query.Where("actor_id = ?", *filter.ActorID)
	}
	if filter.Action != nil {
		query = query.Where("action = ?", *filter.Action)
	}
	if filter.ResourceType != nil {
		query = query.Where("resource_type = ?", *filter.ResourceType)
	}
	if filter.ResourceID != nil {
		query = query.Where("resource_id = ?", *filter.ResourceID)
	}
	query = paginateCreatedAtID(query, params, cursor)

	events := make([]AuditEvent, 0)
	if err := query.Scan(ctx, &events); err != nil {
		return PageResult[AuditEvent]{}, fmt.Errorf("list audit events page: %w", err)
	}
	return buildPageResult(events, params.Limit, func(event AuditEvent) string { return event.CreatedAt }, func(event AuditEvent) string { return event.ID })
}
