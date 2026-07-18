package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// GetWebAuthnUserHandle returns a user's opaque handle for one RP.
func (r *Repository) GetWebAuthnUserHandle(ctx context.Context, userID, rpID string) (*WebAuthnUserHandle, error) {
	handle := new(WebAuthnUserHandle)
	err := r.db.bun.NewSelect().Model(handle).
		Where("user_id = ?", userID).
		Where("rp_id = ?", rpID).
		Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select webauthn user handle: %w", err)
	}
	return handle, nil
}

// GetWebAuthnUserHandleByHandle resolves an opaque RP handle.
func (r *Repository) GetWebAuthnUserHandleByHandle(ctx context.Context, rpID string, value []byte) (*WebAuthnUserHandle, error) {
	handle := new(WebAuthnUserHandle)
	err := r.db.bun.NewSelect().Model(handle).
		Where("rp_id = ?", rpID).
		Where("handle = ?", value).
		Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select webauthn user handle by value: %w", err)
	}
	return handle, nil
}

// EnsureWebAuthnUserHandle inserts a handle unless the user already has one for the RP.
func (r *Repository) EnsureWebAuthnUserHandle(ctx context.Context, handle *WebAuthnUserHandle) (*WebAuthnUserHandle, error) {
	if _, err := r.db.bun.NewInsert().Model(handle).
		On("CONFLICT (user_id, rp_id) DO NOTHING").
		Exec(ctx); err != nil {
		return nil, fmt.Errorf("insert webauthn user handle: %w", err)
	}
	stored, err := r.GetWebAuthnUserHandle(ctx, handle.UserID, handle.RPID)
	if err != nil {
		return nil, err
	}
	if stored == nil {
		return nil, fmt.Errorf("webauthn user handle missing after insert")
	}
	return stored, nil
}

// ListPasskeysByUser returns one user's passkeys for an RP.
func (r *Repository) ListPasskeysByUser(ctx context.Context, userID, rpID string) ([]Passkey, error) {
	passkeys := make([]Passkey, 0)
	if err := r.db.bun.NewSelect().Model(&passkeys).
		Where("user_id = ?", userID).
		Where("rp_id = ?", rpID).
		OrderExpr("created_at ASC, id ASC").
		Scan(ctx); err != nil {
		return nil, fmt.Errorf("list user passkeys: %w", err)
	}
	return passkeys, nil
}

// GetPasskeyByIDForUser returns a passkey when it belongs to the user and RP.
func (r *Repository) GetPasskeyByIDForUser(ctx context.Context, passkeyID, userID, rpID string) (*Passkey, error) {
	passkey := new(Passkey)
	err := r.db.bun.NewSelect().Model(passkey).
		Where("id = ?", passkeyID).
		Where("user_id = ?", userID).
		Where("rp_id = ?", rpID).
		Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select user passkey: %w", err)
	}
	return passkey, nil
}

// CreatePasskey inserts a WebAuthn credential.
func (r *Repository) CreatePasskey(ctx context.Context, passkey *Passkey) error {
	if _, err := r.db.bun.NewInsert().Model(passkey).Exec(ctx); err != nil {
		return fmt.Errorf("insert passkey: %w", err)
	}
	return nil
}

// RenamePasskey changes a passkey name when it belongs to the user and RP.
func (r *Repository) RenamePasskey(ctx context.Context, passkeyID, userID, rpID, name string) error {
	result, err := r.db.bun.NewUpdate().Model((*Passkey)(nil)).
		Set("name = ?", name).
		Where("id = ?", passkeyID).
		Where("user_id = ?", userID).
		Where("rp_id = ?", rpID).
		Exec(ctx)
	if err != nil {
		return fmt.Errorf("rename passkey: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("passkey rename rows affected: %w", err)
	}
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// DeletePasskey removes a passkey when it belongs to the user and RP.
func (r *Repository) DeletePasskey(ctx context.Context, passkeyID, userID, rpID string) error {
	result, err := r.db.bun.NewDelete().Model((*Passkey)(nil)).
		Where("id = ?", passkeyID).
		Where("user_id = ?", userID).
		Where("rp_id = ?", rpID).
		Exec(ctx)
	if err != nil {
		return fmt.Errorf("delete passkey: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("passkey delete rows affected: %w", err)
	}
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// UpdatePasskeyCredential persists assertion-updated credential state.
func (r *Repository) UpdatePasskeyCredential(ctx context.Context, rpID string, credentialID, credentialJSON []byte, lastUsedAt string) error {
	result, err := r.db.bun.NewUpdate().Model((*Passkey)(nil)).
		Set("credential_json = ?", credentialJSON).
		Set("last_used_at = ?", lastUsedAt).
		Where("rp_id = ?", rpID).
		Where("credential_id = ?", credentialID).
		Exec(ctx)
	if err != nil {
		return fmt.Errorf("update passkey credential: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("passkey credential update rows affected: %w", err)
	}
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}
