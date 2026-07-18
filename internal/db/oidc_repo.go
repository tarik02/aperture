package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// GetOIDCIdentity returns one provider subject mapping.
func (r *Repository) GetOIDCIdentity(ctx context.Context, providerID, subject string) (*OIDCIdentity, error) {
	identity := new(OIDCIdentity)
	err := r.db.bun.NewSelect().Model(identity).
		Where("provider_id = ?", providerID).
		Where("subject = ?", subject).
		Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select oidc identity: %w", err)
	}
	return identity, nil
}

// CreateOIDCIdentity inserts a provider subject mapping.
func (r *Repository) CreateOIDCIdentity(ctx context.Context, identity *OIDCIdentity) error {
	if _, err := r.db.bun.NewInsert().Model(identity).Exec(ctx); err != nil {
		return fmt.Errorf("insert oidc identity: %w", err)
	}
	return nil
}

// TouchOIDCIdentity updates login metadata.
func (r *Repository) TouchOIDCIdentity(ctx context.Context, providerID, subject string, email *string, lastLoginAt string) error {
	result, err := r.db.bun.NewUpdate().Model((*OIDCIdentity)(nil)).
		Set("email = ?", email).
		Set("last_login_at = ?", lastLoginAt).
		Where("provider_id = ?", providerID).
		Where("subject = ?", subject).
		Exec(ctx)
	if err != nil {
		return fmt.Errorf("touch oidc identity: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("oidc identity update rows affected: %w", err)
	}
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}
