package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/uptrace/bun"
)

// GetUserPassword returns a user's local password credential.
func (r *Repository) GetUserPassword(ctx context.Context, userID string) (*UserPassword, error) {
	password := new(UserPassword)
	err := r.db.bun.NewSelect().Model(password).Where("user_id = ?", userID).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select user password: %w", err)
	}
	return password, nil
}

// UpsertUserPassword creates or replaces a user's local password credential.
func (r *Repository) UpsertUserPassword(ctx context.Context, password *UserPassword) error {
	if _, err := r.db.bun.NewInsert().Model(password).
		On("CONFLICT (user_id) DO UPDATE").
		Set("password_hash = EXCLUDED.password_hash").
		Set("updated_at = EXCLUDED.updated_at").
		Exec(ctx); err != nil {
		return fmt.Errorf("upsert user password: %w", err)
	}
	return nil
}

// UpsertUserInvitation replaces any outstanding password link for a user.
func (r *Repository) UpsertUserInvitation(ctx context.Context, invitation *UserInvitation) error {
	if _, err := r.db.bun.NewInsert().Model(invitation).
		On("CONFLICT (user_id) DO UPDATE").
		Set("token_hash = EXCLUDED.token_hash").
		Set("expires_at = EXCLUDED.expires_at").
		Set("created_at = EXCLUDED.created_at").
		Exec(ctx); err != nil {
		return fmt.Errorf("upsert user invitation: %w", err)
	}
	return nil
}

// GetUserInvitationByTokenHash returns an invitation by its secret hash.
func (r *Repository) GetUserInvitationByTokenHash(ctx context.Context, tokenHash []byte) (*UserInvitation, error) {
	invitation := new(UserInvitation)
	err := r.db.bun.NewSelect().Model(invitation).Where("token_hash = ?", tokenHash).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select user invitation: %w", err)
	}
	return invitation, nil
}

// AcceptUserInvitation consumes a password link and stores the chosen password atomically.
func (r *Repository) AcceptUserInvitation(ctx context.Context, invitation *UserInvitation, password *UserPassword) error {
	return r.WithTx(ctx, func(ctx context.Context, tx bun.Tx) error {
		result, err := tx.NewDelete().Model((*UserInvitation)(nil)).
			Where("user_id = ?", invitation.UserID).
			Where("token_hash = ?", invitation.TokenHash).
			Exec(ctx)
		if err != nil {
			return fmt.Errorf("consume user invitation: %w", err)
		}
		rows, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("user invitation rows affected: %w", err)
		}
		if rows != 1 {
			return sql.ErrNoRows
		}

		if _, err := tx.NewInsert().Model(password).
			On("CONFLICT (user_id) DO UPDATE").
			Set("password_hash = EXCLUDED.password_hash").
			Set("updated_at = EXCLUDED.updated_at").
			Exec(ctx); err != nil {
			return fmt.Errorf("set invited user password: %w", err)
		}
		return nil
	})
}

// GetTOTPCredential returns a user's active authenticator credential.
func (r *Repository) GetTOTPCredential(ctx context.Context, userID string) (*TOTPCredential, error) {
	credential := new(TOTPCredential)
	err := r.db.bun.NewSelect().Model(credential).Where("user_id = ?", userID).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select totp credential: %w", err)
	}
	return credential, nil
}

// CountUnusedRecoveryCodes returns the number of unused recovery codes for a user.
func (r *Repository) CountUnusedRecoveryCodes(ctx context.Context, userID string) (int, error) {
	count, err := r.db.bun.NewSelect().Model((*RecoveryCode)(nil)).
		Where("user_id = ?", userID).
		Where("used_at IS NULL").
		Count(ctx)
	if err != nil {
		return 0, fmt.Errorf("count unused recovery codes: %w", err)
	}
	return count, nil
}

// CreateTOTPCredential enables TOTP and stores its initial recovery codes atomically.
func (r *Repository) CreateTOTPCredential(ctx context.Context, credential *TOTPCredential, codes []RecoveryCode) error {
	return r.WithTx(ctx, func(ctx context.Context, tx bun.Tx) error {
		if _, err := tx.NewInsert().Model(credential).Exec(ctx); err != nil {
			return fmt.Errorf("insert totp credential: %w", err)
		}
		if len(codes) > 0 {
			if _, err := tx.NewInsert().Model(&codes).Exec(ctx); err != nil {
				return fmt.Errorf("insert recovery codes: %w", err)
			}
		}
		return nil
	})
}

// ReplaceRecoveryCodes invalidates every prior code and stores a new set atomically.
func (r *Repository) ReplaceRecoveryCodes(ctx context.Context, userID string, codes []RecoveryCode) error {
	return r.WithTx(ctx, func(ctx context.Context, tx bun.Tx) error {
		if _, err := tx.NewDelete().Model((*RecoveryCode)(nil)).Where("user_id = ?", userID).Exec(ctx); err != nil {
			return fmt.Errorf("delete recovery codes: %w", err)
		}
		if len(codes) > 0 {
			if _, err := tx.NewInsert().Model(&codes).Exec(ctx); err != nil {
				return fmt.Errorf("insert recovery codes: %w", err)
			}
		}
		return nil
	})
}

// ConsumeRecoveryCode marks one matching recovery code as used.
func (r *Repository) ConsumeRecoveryCode(ctx context.Context, userID string, codeHash []byte, usedAt string) (bool, error) {
	result, err := r.db.bun.NewUpdate().Model((*RecoveryCode)(nil)).
		Set("used_at = ?", usedAt).
		Where("user_id = ?", userID).
		Where("code_hash = ?", codeHash).
		Where("used_at IS NULL").
		Exec(ctx)
	if err != nil {
		return false, fmt.Errorf("consume recovery code: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("recovery code rows affected: %w", err)
	}
	return rows == 1, nil
}

// DeleteTOTPCredential disables TOTP and removes all recovery codes atomically.
func (r *Repository) DeleteTOTPCredential(ctx context.Context, userID string) error {
	return r.WithTx(ctx, func(ctx context.Context, tx bun.Tx) error {
		result, err := tx.NewDelete().Model((*TOTPCredential)(nil)).Where("user_id = ?", userID).Exec(ctx)
		if err != nil {
			return fmt.Errorf("delete totp credential: %w", err)
		}
		rows, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("totp delete rows affected: %w", err)
		}
		if rows == 0 {
			return sql.ErrNoRows
		}
		if _, err := tx.NewDelete().Model((*RecoveryCode)(nil)).Where("user_id = ?", userID).Exec(ctx); err != nil {
			return fmt.Errorf("delete recovery codes: %w", err)
		}
		return nil
	})
}
