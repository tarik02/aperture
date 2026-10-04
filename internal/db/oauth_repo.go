package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/uptrace/bun"
)

// ErrOAuthCodeConsumed indicates an authorization code was already exchanged.
var ErrOAuthCodeConsumed = errors.New("oauth authorization code already consumed")

// ErrOAuthTokenRevoked indicates a refresh token was already rotated or revoked.
var ErrOAuthTokenRevoked = errors.New("oauth token already revoked")

// CreateOAuthClient inserts a dynamically registered client.
func (r *Repository) CreateOAuthClient(ctx context.Context, client *OAuthClient) error {
	if _, err := r.db.bun.NewInsert().Model(client).Exec(ctx); err != nil {
		return fmt.Errorf("insert oauth client: %w", err)
	}
	return nil
}

// UpsertOAuthClient stores the latest fetched metadata for a client.
func (r *Repository) UpsertOAuthClient(ctx context.Context, client *OAuthClient) error {
	_, err := r.db.bun.NewInsert().
		Model(client).
		On("CONFLICT (id) DO UPDATE").
		Set("client_name = EXCLUDED.client_name").
		Set("client_uri = EXCLUDED.client_uri").
		Set("logo_uri = EXCLUDED.logo_uri").
		Set("redirect_uris_json = EXCLUDED.redirect_uris_json").
		Set("token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method").
		Set("metadata_json = EXCLUDED.metadata_json").
		Set("updated_at = EXCLUDED.updated_at").
		Exec(ctx)
	if err != nil {
		return fmt.Errorf("upsert oauth client: %w", err)
	}
	return nil
}

// GetOAuthClient returns a client by id.
func (r *Repository) GetOAuthClient(ctx context.Context, clientID string) (*OAuthClient, error) {
	client := new(OAuthClient)
	err := r.db.bun.NewSelect().Model(client).Where("id = ?", clientID).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select oauth client: %w", err)
	}
	return client, nil
}

// ListOAuthClients returns clients by id.
func (r *Repository) ListOAuthClients(ctx context.Context, clientIDs []string) (map[string]OAuthClient, error) {
	result := make(map[string]OAuthClient, len(clientIDs))
	if len(clientIDs) == 0 {
		return result, nil
	}
	clients := make([]OAuthClient, 0, len(clientIDs))
	if err := r.db.bun.NewSelect().Model(&clients).Where("id IN (?)", bun.List(clientIDs)).Scan(ctx); err != nil {
		return nil, fmt.Errorf("list oauth clients: %w", err)
	}
	for _, client := range clients {
		result[client.ID] = client
	}
	return result, nil
}

// CreateOAuthAuthorizationCode inserts an authorization code and its audit event.
func (r *Repository) CreateOAuthAuthorizationCode(ctx context.Context, code *OAuthAuthorizationCode, audit *AuditEvent) error {
	return r.WithTx(ctx, func(ctx context.Context, tx bun.Tx) error {
		if _, err := tx.NewInsert().Model(code).Exec(ctx); err != nil {
			return fmt.Errorf("insert oauth authorization code: %w", err)
		}
		if _, err := tx.NewInsert().Model(audit).Exec(ctx); err != nil {
			return fmt.Errorf("insert oauth consent audit event: %w", err)
		}
		return nil
	})
}

// GetOAuthAuthorizationCode returns an authorization code by id.
func (r *Repository) GetOAuthAuthorizationCode(ctx context.Context, codeID string) (*OAuthAuthorizationCode, error) {
	code := new(OAuthAuthorizationCode)
	err := r.db.bun.NewSelect().Model(code).Where("id = ?", codeID).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select oauth authorization code: %w", err)
	}
	return code, nil
}

// ExchangeOAuthAuthorizationCode consumes a code and creates its grant and first tokens atomically.
func (r *Repository) ExchangeOAuthAuthorizationCode(ctx context.Context, codeID, consumedAt string, grant *OAuthGrant, tokens []OAuthToken, audit *AuditEvent) error {
	return r.WithTx(ctx, func(ctx context.Context, tx bun.Tx) error {
		result, err := tx.NewUpdate().
			Model((*OAuthAuthorizationCode)(nil)).
			Set("consumed_at = ?", consumedAt).
			Set("grant_id = ?", grant.ID).
			Where("id = ?", codeID).
			Where("consumed_at IS NULL").
			Exec(ctx)
		if err != nil {
			return fmt.Errorf("consume oauth authorization code: %w", err)
		}
		rows, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("oauth authorization code rows affected: %w", err)
		}
		if rows == 0 {
			return ErrOAuthCodeConsumed
		}

		if _, err := tx.NewInsert().Model(grant).Exec(ctx); err != nil {
			return fmt.Errorf("insert oauth grant: %w", err)
		}
		if len(grant.TenantIDs) > 0 {
			tenants := make([]OAuthGrantTenant, 0, len(grant.TenantIDs))
			for _, tenantID := range grant.TenantIDs {
				tenants = append(tenants, OAuthGrantTenant{GrantID: grant.ID, TenantID: tenantID})
			}
			if _, err := tx.NewInsert().Model(&tenants).Exec(ctx); err != nil {
				return fmt.Errorf("insert oauth grant tenants: %w", err)
			}
		}
		if len(grant.ResourceGrants) > 0 {
			if _, err := tx.NewInsert().Model(&grant.ResourceGrants).Exec(ctx); err != nil {
				return fmt.Errorf("insert oauth grant resources: %w", err)
			}
		}
		if _, err := tx.NewInsert().Model(&tokens).Exec(ctx); err != nil {
			return fmt.Errorf("insert oauth tokens: %w", err)
		}
		if _, err := tx.NewInsert().Model(audit).Exec(ctx); err != nil {
			return fmt.Errorf("insert oauth grant audit event: %w", err)
		}
		return nil
	})
}

// GetOAuthGrant returns a grant with its tenants and resource grants.
func (r *Repository) GetOAuthGrant(ctx context.Context, grantID string) (*OAuthGrant, error) {
	grant := new(OAuthGrant)
	err := r.db.bun.NewSelect().Model(grant).Where("id = ?", grantID).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select oauth grant: %w", err)
	}
	grants := []OAuthGrant{*grant}
	if err := r.populateOAuthGrants(ctx, grants); err != nil {
		return nil, err
	}
	return &grants[0], nil
}

// ListActiveOAuthGrantsByUser returns a user's unrevoked grants, newest first.
func (r *Repository) ListActiveOAuthGrantsByUser(ctx context.Context, userID string) ([]OAuthGrant, error) {
	grants := make([]OAuthGrant, 0)
	if err := r.db.bun.NewSelect().
		Model(&grants).
		Where("user_id = ?", userID).
		Where("revoked_at IS NULL").
		OrderExpr("created_at DESC, id DESC").
		Scan(ctx); err != nil {
		return nil, fmt.Errorf("list oauth grants: %w", err)
	}
	if err := r.populateOAuthGrants(ctx, grants); err != nil {
		return nil, err
	}
	return grants, nil
}

func (r *Repository) populateOAuthGrants(ctx context.Context, grants []OAuthGrant) error {
	if len(grants) == 0 {
		return nil
	}
	grantIDs := make([]string, 0, len(grants))
	for _, grant := range grants {
		grantIDs = append(grantIDs, grant.ID)
	}

	tenants := make([]OAuthGrantTenant, 0)
	if err := r.db.bun.NewSelect().
		Model(&tenants).
		Where("grant_id IN (?)", bun.List(grantIDs)).
		OrderExpr("grant_id ASC, tenant_id ASC").
		Scan(ctx); err != nil {
		return fmt.Errorf("list oauth grant tenants: %w", err)
	}
	resources := make([]OAuthGrantResourceGrant, 0)
	if err := r.db.bun.NewSelect().
		Model(&resources).
		Where("grant_id IN (?)", bun.List(grantIDs)).
		OrderExpr("grant_id ASC, resource_type ASC, resource_id ASC").
		Scan(ctx); err != nil {
		return fmt.Errorf("list oauth grant resources: %w", err)
	}

	indexByID := make(map[string]int, len(grants))
	for i := range grants {
		indexByID[grants[i].ID] = i
		grants[i].TenantIDs = []string{}
		grants[i].ResourceGrants = []OAuthGrantResourceGrant{}
	}
	for _, tenant := range tenants {
		grant := &grants[indexByID[tenant.GrantID]]
		grant.TenantIDs = append(grant.TenantIDs, tenant.TenantID)
	}
	for _, resource := range resources {
		grant := &grants[indexByID[resource.GrantID]]
		grant.ResourceGrants = append(grant.ResourceGrants, resource)
	}
	return nil
}

// RevokeOAuthGrant revokes a grant and every token issued under it.
func (r *Repository) RevokeOAuthGrant(ctx context.Context, grantID, revokedAt string, audit *AuditEvent) error {
	return r.WithTx(ctx, func(ctx context.Context, tx bun.Tx) error {
		result, err := tx.NewUpdate().
			Model((*OAuthGrant)(nil)).
			Set("revoked_at = ?", revokedAt).
			Where("id = ?", grantID).
			Where("revoked_at IS NULL").
			Exec(ctx)
		if err != nil {
			return fmt.Errorf("revoke oauth grant: %w", err)
		}
		rows, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("revoke oauth grant rows affected: %w", err)
		}
		if rows == 0 {
			return sql.ErrNoRows
		}
		if _, err := tx.NewUpdate().
			Model((*OAuthToken)(nil)).
			Set("revoked_at = ?", revokedAt).
			Where("grant_id = ?", grantID).
			Where("revoked_at IS NULL").
			Exec(ctx); err != nil {
			return fmt.Errorf("revoke oauth grant tokens: %w", err)
		}
		if _, err := tx.NewInsert().Model(audit).Exec(ctx); err != nil {
			return fmt.Errorf("insert oauth grant revocation audit event: %w", err)
		}
		return nil
	})
}

// TouchOAuthGrant records when a grant was last used.
func (r *Repository) TouchOAuthGrant(ctx context.Context, grantID, usedAt string) error {
	if _, err := r.db.bun.NewUpdate().
		Model((*OAuthGrant)(nil)).
		Set("last_used_at = ?", usedAt).
		Where("id = ?", grantID).
		Exec(ctx); err != nil {
		return fmt.Errorf("touch oauth grant: %w", err)
	}
	return nil
}

// GetOAuthToken returns an access or refresh token by id.
func (r *Repository) GetOAuthToken(ctx context.Context, tokenID string) (*OAuthToken, error) {
	token := new(OAuthToken)
	err := r.db.bun.NewSelect().Model(token).Where("id = ?", tokenID).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select oauth token: %w", err)
	}
	return token, nil
}

// RotateOAuthRefreshToken revokes a refresh token and inserts its replacements atomically.
func (r *Repository) RotateOAuthRefreshToken(ctx context.Context, refreshTokenID, revokedAt string, tokens []OAuthToken) error {
	return r.WithTx(ctx, func(ctx context.Context, tx bun.Tx) error {
		result, err := tx.NewUpdate().
			Model((*OAuthToken)(nil)).
			Set("revoked_at = ?", revokedAt).
			Where("id = ?", refreshTokenID).
			Where("kind = 'refresh'").
			Where("revoked_at IS NULL").
			Exec(ctx)
		if err != nil {
			return fmt.Errorf("rotate oauth refresh token: %w", err)
		}
		rows, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("rotate oauth refresh token rows affected: %w", err)
		}
		if rows == 0 {
			return ErrOAuthTokenRevoked
		}
		if _, err := tx.NewInsert().Model(&tokens).Exec(ctx); err != nil {
			return fmt.Errorf("insert rotated oauth tokens: %w", err)
		}
		return nil
	})
}
