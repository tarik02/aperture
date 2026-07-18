package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/uptrace/bun"
)

// TenantFilter controls tenant listing behavior.
type TenantFilter struct {
	IncludeDeleted bool
	DeletedOnly    bool
}

// CreateTenant inserts a new tenant row.
func (r *Repository) CreateTenant(ctx context.Context, tenant *Tenant) error {
	_, err := r.db.bun.NewInsert().Model(tenant).Exec(ctx)
	if err != nil {
		return fmt.Errorf("insert tenant: %w", err)
	}
	return nil
}

// GetTenantByID returns a tenant by id.
func (r *Repository) GetTenantByID(ctx context.Context, tenantID string) (*Tenant, error) {
	tenant := new(Tenant)
	err := r.db.bun.NewSelect().
		Model(tenant).
		Where("id = ?", tenantID).
		Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select tenant: %w", err)
	}
	return tenant, nil
}

// ListTenants returns tenants ordered by creation time.
func (r *Repository) ListTenants(ctx context.Context, filter TenantFilter) ([]Tenant, error) {
	query := r.db.bun.NewSelect().Model((*Tenant)(nil)).OrderExpr("created_at ASC")
	if filter.DeletedOnly {
		query = query.Where("deleted_at IS NOT NULL")
	} else if !filter.IncludeDeleted {
		query = query.Where("deleted_at IS NULL")
	}

	tenants := make([]Tenant, 0)
	if err := query.Scan(ctx, &tenants); err != nil {
		return nil, fmt.Errorf("list tenants: %w", err)
	}
	return tenants, nil
}

// ListTenantsPage returns tenants with cursor pagination.
func (r *Repository) ListTenantsPage(ctx context.Context, filter TenantFilter, params PageParams) (PageResult[Tenant], error) {
	params = NormalizePageParams(params)
	cursor, err := parsePageCursor(params)
	if err != nil {
		return PageResult[Tenant]{}, err
	}

	query := r.db.bun.NewSelect().Model((*Tenant)(nil))
	if filter.DeletedOnly {
		query = query.Where("deleted_at IS NOT NULL")
	} else if !filter.IncludeDeleted {
		query = query.Where("deleted_at IS NULL")
	}
	query = paginateCreatedAtID(query, params, cursor)

	tenants := make([]Tenant, 0)
	if err := query.Scan(ctx, &tenants); err != nil {
		return PageResult[Tenant]{}, fmt.Errorf("list tenants page: %w", err)
	}

	return buildPageResult(tenants, params.Limit, func(t Tenant) string { return t.CreatedAt }, func(t Tenant) string { return t.ID })
}

// UpdateTenantDisplayName updates a tenant display name.
func (r *Repository) UpdateTenantDisplayName(ctx context.Context, tenantID string, displayName string) error {
	result, err := r.db.bun.NewUpdate().
		Model((*Tenant)(nil)).
		Set("display_name = ?", displayName).
		Where("id = ?", tenantID).
		Where("deleted_at IS NULL").
		Exec(ctx)
	if err != nil {
		return fmt.Errorf("update tenant display name: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("tenant update rows affected: %w", err)
	}
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// DeactivateTenant marks a tenant deleted and revokes tenant-scoped API tokens.
func (r *Repository) DeactivateTenant(ctx context.Context, tenantID string, deletedAt string) error {
	return r.WithTx(ctx, func(ctx context.Context, tx bun.Tx) error {
		result, err := tx.NewUpdate().
			Model((*Tenant)(nil)).
			Set("deleted_at = ?", deletedAt).
			Where("id = ?", tenantID).
			Where("deleted_at IS NULL").
			Exec(ctx)
		if err != nil {
			return fmt.Errorf("deactivate tenant: %w", err)
		}

		rows, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("deactivate tenant rows affected: %w", err)
		}
		if rows == 0 {
			return sql.ErrNoRows
		}

		if _, err := tx.NewUpdate().
			Model((*APIToken)(nil)).
			Set("revoked_at = ?", deletedAt).
			Where("tenant_id = ?", tenantID).
			Where("authority_type = ?", "tenant").
			Where("revoked_at IS NULL").
			Exec(ctx); err != nil {
			return fmt.Errorf("revoke tenant tokens: %w", err)
		}

		return nil
	})
}

// RestoreTenant clears deleted_at for a tenant.
func (r *Repository) RestoreTenant(ctx context.Context, tenantID string) error {
	result, err := r.db.bun.NewUpdate().
		Model((*Tenant)(nil)).
		Set("deleted_at = NULL").
		Where("id = ?", tenantID).
		Where("deleted_at IS NOT NULL").
		Exec(ctx)
	if err != nil {
		return fmt.Errorf("restore tenant: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("restore tenant rows affected: %w", err)
	}
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// CountAPITokens returns the number of stored API tokens.
func (r *Repository) CountAPITokens(ctx context.Context) (int, error) {
	count, err := r.db.bun.NewSelect().Model((*APIToken)(nil)).Count(ctx)
	if err != nil {
		return 0, fmt.Errorf("count api tokens: %w", err)
	}
	return count, nil
}

// ErrBootstrapNotEmpty indicates bootstrap found existing API tokens.
var ErrBootstrapNotEmpty = errors.New("bootstrap refused: api tokens already exist")

// CreateBootstrapAPIToken inserts the first API token atomically.
func (r *Repository) CreateBootstrapAPIToken(ctx context.Context, token *APIToken, audit *AuditEvent) error {
	return r.WithImmediateTx(ctx, func(ctx context.Context, tx bun.IDB) error {
		result, err := tx.ExecContext(ctx, `
			INSERT INTO api_tokens (
				id, authority_type, tenant_id, name, token_hash, scopes_json, created_at,
				created_by_type, created_by_id, parent_token_id, expires_at
			)
			SELECT ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?
			WHERE NOT EXISTS (SELECT 1 FROM api_tokens)
		`,
			token.ID,
			token.AuthorityType,
			token.Name,
			token.TokenHash,
			token.ScopesJSON,
			token.CreatedAt,
			token.CreatedByType,
			token.CreatedByID,
			token.ParentTokenID,
			token.ExpiresAt,
		)
		if err != nil {
			return fmt.Errorf("insert bootstrap api token: %w", err)
		}

		rows, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("bootstrap api token rows affected: %w", err)
		}
		if rows == 0 {
			return ErrBootstrapNotEmpty
		}
		if _, err := tx.NewInsert().Model(audit).Exec(ctx); err != nil {
			return fmt.Errorf("insert bootstrap token audit event: %w", err)
		}
		return nil
	})
}

// CreateAPIToken inserts a token and its audit event atomically.
func (r *Repository) CreateAPIToken(ctx context.Context, token *APIToken, audit *AuditEvent) error {
	return r.WithTx(ctx, func(ctx context.Context, tx bun.Tx) error {
		if _, err := tx.NewInsert().Model(token).Exec(ctx); err != nil {
			return fmt.Errorf("insert api token: %w", err)
		}
		if _, err := tx.NewInsert().Model(audit).Exec(ctx); err != nil {
			return fmt.Errorf("insert token audit event: %w", err)
		}
		return nil
	})
}

// GetAPITokenByID returns an API token by id.
func (r *Repository) GetAPITokenByID(ctx context.Context, tokenID string) (*APIToken, error) {
	token := new(APIToken)
	err := r.db.bun.NewSelect().
		Model(token).
		Where("id = ?", tokenID).
		Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select api token: %w", err)
	}
	return token, nil
}

// APITokenFilter controls API token listing behavior.
type APITokenFilter struct {
	TenantID      *string
	AuthorityType *string
	Name          *string
	Scope         *string
	RevokedOnly   bool
	ActiveOnly    bool
}

// ListAPITokens returns API tokens, optionally filtered by tenant.
func (r *Repository) ListAPITokens(ctx context.Context, tenantID *string) ([]APIToken, error) {
	return r.listAPITokens(ctx, APITokenFilter{TenantID: tenantID})
}

func (r *Repository) listAPITokens(ctx context.Context, filter APITokenFilter) ([]APIToken, error) {
	query := r.db.bun.NewSelect().Model((*APIToken)(nil)).OrderExpr("created_at ASC")
	if filter.TenantID != nil {
		query = query.Where("tenant_id = ?", *filter.TenantID)
	}
	query = applyAPITokenFilters(query, filter)

	tokens := make([]APIToken, 0)
	if err := query.Scan(ctx, &tokens); err != nil {
		return nil, fmt.Errorf("list api tokens: %w", err)
	}
	return tokens, nil
}

// ListAPITokensPage returns API tokens with cursor pagination.
func (r *Repository) ListAPITokensPage(ctx context.Context, filter APITokenFilter, params PageParams) (PageResult[APIToken], error) {
	params = NormalizePageParams(params)
	cursor, err := parsePageCursor(params)
	if err != nil {
		return PageResult[APIToken]{}, err
	}

	query := r.db.bun.NewSelect().Model((*APIToken)(nil))
	if filter.TenantID != nil {
		query = query.Where("tenant_id = ?", *filter.TenantID)
	}
	query = applyAPITokenFilters(query, filter)
	query = paginateCreatedAtID(query, params, cursor)

	tokens := make([]APIToken, 0)
	if err := query.Scan(ctx, &tokens); err != nil {
		return PageResult[APIToken]{}, fmt.Errorf("list api tokens page: %w", err)
	}

	return buildPageResult(tokens, params.Limit, func(t APIToken) string { return t.CreatedAt }, func(t APIToken) string { return t.ID })
}

func applyAPITokenFilters(query *bun.SelectQuery, filter APITokenFilter) *bun.SelectQuery {
	if filter.AuthorityType != nil {
		query = query.Where("authority_type = ?", *filter.AuthorityType)
	}
	if filter.Name != nil {
		query = query.Where("LOWER(name) LIKE ?", "%"+strings.ToLower(*filter.Name)+"%")
	}
	if filter.Scope != nil {
		query = query.Where("scopes_json LIKE ?", "%\""+*filter.Scope+"\"%")
	}
	if filter.RevokedOnly {
		query = query.Where("revoked_at IS NOT NULL")
	} else if filter.ActiveOnly {
		query = query.Where("revoked_at IS NULL")
	}
	return query
}

// RevokeAPIToken marks a token revoked and records its audit event atomically.
func (r *Repository) RevokeAPIToken(ctx context.Context, tokenID string, revokedAt string, audit *AuditEvent) error {
	return r.WithTx(ctx, func(ctx context.Context, tx bun.Tx) error {
		result, err := tx.NewUpdate().
			Model((*APIToken)(nil)).
			Set("revoked_at = ?", revokedAt).
			Where("id = ?", tokenID).
			Where("revoked_at IS NULL").
			Exec(ctx)
		if err != nil {
			return fmt.Errorf("revoke api token: %w", err)
		}

		rows, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("revoke api token rows affected: %w", err)
		}
		if rows == 0 {
			return sql.ErrNoRows
		}
		if _, err := tx.NewInsert().Model(audit).Exec(ctx); err != nil {
			return fmt.Errorf("insert token revocation audit event: %w", err)
		}
		return nil
	})
}
