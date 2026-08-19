package auth

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/ids"
	"github.com/go-webauthn/webauthn/protocol"
	webauthnlib "github.com/go-webauthn/webauthn/webauthn"
)

const (
	webSessionPasskeyLoginKey            = "passkey_login"
	webSessionPasskeyRegistrationKey     = "passkey_registration"
	webSessionPasskeyRegistrationNameKey = "passkey_registration_name"
)

type webAuthnUser struct {
	user        db.User
	handle      []byte
	credentials []webauthnlib.Credential
}

func (u *webAuthnUser) WebAuthnID() []byte {
	return u.handle
}

func (u *webAuthnUser) WebAuthnName() string {
	if u.user.Email != nil {
		return *u.user.Email
	}
	return u.user.DisplayName
}

func (u *webAuthnUser) WebAuthnDisplayName() string {
	return u.user.DisplayName
}

func (u *webAuthnUser) WebAuthnCredentials() []webauthnlib.Credential {
	return u.credentials
}

// BeginPasskeyLogin starts a discoverable passkey assertion.
func (s *WebService) BeginPasskeyLogin(ctx context.Context) (*protocol.CredentialAssertion, error) {
	if err := s.sessions.RenewToken(ctx); err != nil {
		return nil, fmt.Errorf("renew passkey login session: %w", err)
	}
	options, session, err := s.passkeys.BeginDiscoverableLogin(
		webauthnlib.WithUserVerification(protocol.VerificationRequired),
	)
	if err != nil {
		return nil, fmt.Errorf("begin passkey login: %w", err)
	}
	encoded, err := json.Marshal(session)
	if err != nil {
		return nil, fmt.Errorf("encode passkey login session: %w", err)
	}
	s.sessions.Put(ctx, webSessionPasskeyLoginKey, encoded)
	return options, nil
}

// CompletePasskeyLogin validates an assertion and establishes a browser session.
func (s *WebService) CompletePasskeyLogin(ctx context.Context, request *http.Request) (*db.User, error) {
	encoded := s.sessions.PopBytes(ctx, webSessionPasskeyLoginKey)
	if len(encoded) == 0 {
		return nil, ErrPasskeyFlowInvalid
	}
	var session webauthnlib.SessionData
	if err := json.Unmarshal(encoded, &session); err != nil {
		return nil, ErrPasskeyFlowInvalid
	}
	authenticated, credential, err := s.passkeys.FinishPasskeyLogin(
		func(_ []byte, userHandle []byte) (webauthnlib.User, error) {
			return s.webAuthnUserByHandle(ctx, userHandle)
		},
		session,
		request,
	)
	if err != nil {
		if errors.Is(err, ErrUserDisabled) {
			return nil, ErrUserDisabled
		}
		return nil, fmt.Errorf("%w: %v", ErrPasskeyAuthentication, err)
	}
	user, ok := authenticated.(*webAuthnUser)
	if !ok {
		return nil, fmt.Errorf("unexpected passkey user type")
	}
	credentialJSON, err := json.Marshal(credential)
	if err != nil {
		return nil, fmt.Errorf("encode asserted passkey: %w", err)
	}
	if err := s.auth.repo.UpdatePasskeyCredential(ctx, s.passkeyRPID, credential.ID, credentialJSON, db.NowUTC()); err != nil {
		return nil, err
	}
	if err := s.establishAuthenticatedSession(ctx, &user.user, AuthMethodPasskey); err != nil {
		return nil, err
	}
	return &user.user, nil
}

// BeginPasskeyRegistration starts registration for the authenticated user.
func (s *WebService) BeginPasskeyRegistration(ctx context.Context, name string) (*protocol.CredentialCreation, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, ErrPasskeyNameInvalid
	}
	user, _, err := s.authenticatedWebUser(ctx)
	if err != nil {
		return nil, err
	}
	handle, err := s.auth.repo.GetWebAuthnUserHandle(ctx, user.ID, s.passkeyRPID)
	if err != nil {
		return nil, err
	}
	if handle == nil {
		value := make([]byte, 32)
		if _, err := rand.Read(value); err != nil {
			return nil, fmt.Errorf("generate webauthn user handle: %w", err)
		}
		handle, err = s.auth.repo.EnsureWebAuthnUserHandle(ctx, &db.WebAuthnUserHandle{
			UserID:    user.ID,
			RPID:      s.passkeyRPID,
			Handle:    value,
			CreatedAt: db.NowUTC(),
		})
		if err != nil {
			return nil, err
		}
	}
	webUser, err := s.webAuthnUserForHandle(ctx, user, handle.Handle)
	if err != nil {
		return nil, err
	}
	exclusions := make([]protocol.CredentialDescriptor, 0, len(webUser.credentials))
	for index := range webUser.credentials {
		exclusions = append(exclusions, webUser.credentials[index].Descriptor())
	}
	options, session, err := s.passkeys.BeginRegistration(
		webUser,
		webauthnlib.WithExclusions(exclusions),
		webauthnlib.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			RequireResidentKey: s.passkeys.Config.AuthenticatorSelection.RequireResidentKey,
			ResidentKey:        protocol.ResidentKeyRequirementRequired,
			UserVerification:   protocol.VerificationRequired,
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("begin passkey registration: %w", err)
	}
	encoded, err := json.Marshal(session)
	if err != nil {
		return nil, fmt.Errorf("encode passkey registration session: %w", err)
	}
	s.sessions.Put(ctx, webSessionPasskeyRegistrationKey, encoded)
	s.sessions.Put(ctx, webSessionPasskeyRegistrationNameKey, name)
	return options, nil
}

// CompletePasskeyRegistration verifies and stores a new credential.
func (s *WebService) CompletePasskeyRegistration(ctx context.Context, request *http.Request) (*db.Passkey, error) {
	user, authMethod, err := s.authenticatedWebUser(ctx)
	if err != nil {
		return nil, err
	}
	encoded := s.sessions.PopBytes(ctx, webSessionPasskeyRegistrationKey)
	name := s.sessions.PopString(ctx, webSessionPasskeyRegistrationNameKey)
	if len(encoded) == 0 || name == "" {
		return nil, ErrPasskeyFlowInvalid
	}
	var session webauthnlib.SessionData
	if err := json.Unmarshal(encoded, &session); err != nil {
		return nil, ErrPasskeyFlowInvalid
	}
	handle, err := s.auth.repo.GetWebAuthnUserHandle(ctx, user.ID, s.passkeyRPID)
	if err != nil {
		return nil, err
	}
	if handle == nil {
		return nil, ErrPasskeyFlowInvalid
	}
	webUser, err := s.webAuthnUserForHandle(ctx, user, handle.Handle)
	if err != nil {
		return nil, err
	}
	credential, err := s.passkeys.FinishRegistration(webUser, session, request)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrPasskeyFlowInvalid, err)
	}
	credentialJSON, err := json.Marshal(credential)
	if err != nil {
		return nil, fmt.Errorf("encode registered passkey: %w", err)
	}
	passkeyID, err := ids.NewUUIDv7()
	if err != nil {
		return nil, err
	}
	passkey := &db.Passkey{
		ID:             passkeyID,
		UserID:         user.ID,
		RPID:           s.passkeyRPID,
		Name:           name,
		CredentialID:   credential.ID,
		CredentialJSON: credentialJSON,
		CreatedAt:      db.NowUTC(),
	}
	if err := s.auth.repo.CreatePasskey(ctx, passkey); err != nil {
		if isUniqueViolation(err) {
			return nil, ErrPasskeyExists
		}
		return nil, err
	}
	principal := Principal{Type: PrincipalTypeUser, ID: user.ID, UserID: &user.ID, AuthMethod: authMethod, Name: user.DisplayName}
	if err := s.auth.RecordAudit(ctx, principal, AuditInput{
		Action:       "passkey.registered",
		ResourceType: "passkey",
		ResourceID:   &passkey.ID,
		Data:         map[string]any{"name": passkey.Name},
	}); err != nil {
		return nil, err
	}
	return passkey, nil
}

// ListPasskeys returns passkeys owned by the authenticated user for this RP.
func (s *WebService) ListPasskeys(ctx context.Context) ([]db.Passkey, error) {
	user, _, err := s.authenticatedWebUser(ctx)
	if err != nil {
		return nil, err
	}
	return s.auth.repo.ListPasskeysByUser(ctx, user.ID, s.passkeyRPID)
}

// RenamePasskey changes the display name of an owned passkey.
func (s *WebService) RenamePasskey(ctx context.Context, passkeyID, name string) (*db.Passkey, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, ErrPasskeyNameInvalid
	}
	user, authMethod, err := s.authenticatedWebUser(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.auth.repo.RenamePasskey(ctx, passkeyID, user.ID, s.passkeyRPID, name); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrPasskeyNotFound
		}
		return nil, err
	}
	passkey, err := s.auth.repo.GetPasskeyByIDForUser(ctx, passkeyID, user.ID, s.passkeyRPID)
	if err != nil {
		return nil, err
	}
	if passkey == nil {
		return nil, ErrPasskeyNotFound
	}
	principal := Principal{Type: PrincipalTypeUser, ID: user.ID, UserID: &user.ID, AuthMethod: authMethod, Name: user.DisplayName}
	if err := s.auth.RecordAudit(ctx, principal, AuditInput{
		Action:       "passkey.renamed",
		ResourceType: "passkey",
		ResourceID:   &passkey.ID,
		Data:         map[string]any{"name": passkey.Name},
	}); err != nil {
		return nil, err
	}
	return passkey, nil
}

// DeletePasskey removes an owned passkey.
func (s *WebService) DeletePasskey(ctx context.Context, passkeyID string) error {
	user, authMethod, err := s.authenticatedWebUser(ctx)
	if err != nil {
		return err
	}
	if err := s.auth.repo.DeletePasskey(ctx, passkeyID, user.ID, s.passkeyRPID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrPasskeyNotFound
		}
		return err
	}
	principal := Principal{Type: PrincipalTypeUser, ID: user.ID, UserID: &user.ID, AuthMethod: authMethod, Name: user.DisplayName}
	return s.auth.RecordAudit(ctx, principal, AuditInput{
		Action:       "passkey.deleted",
		ResourceType: "passkey",
		ResourceID:   &passkeyID,
	})
}

func (s *WebService) authenticatedWebUser(ctx context.Context) (*db.User, string, error) {
	userID := s.sessions.GetString(ctx, webSessionUserIDKey)
	if userID == "" {
		return nil, "", ErrTokenMissing
	}
	user, err := s.auth.GetUser(ctx, userID)
	if err != nil {
		return nil, "", err
	}
	if user.DisabledAt != nil {
		return nil, "", ErrUserDisabled
	}
	return user, s.sessions.GetString(ctx, webSessionAuthMethodKey), nil
}

func (s *WebService) webAuthnUserByHandle(ctx context.Context, value []byte) (*webAuthnUser, error) {
	handle, err := s.auth.repo.GetWebAuthnUserHandleByHandle(ctx, s.passkeyRPID, value)
	if err != nil {
		return nil, err
	}
	if handle == nil {
		return nil, ErrPasskeyAuthentication
	}
	user, err := s.auth.GetUser(ctx, handle.UserID)
	if err != nil {
		return nil, err
	}
	if user.DisabledAt != nil {
		return nil, ErrUserDisabled
	}
	return s.webAuthnUserForHandle(ctx, user, handle.Handle)
}

func (s *WebService) webAuthnUserForHandle(ctx context.Context, user *db.User, handle []byte) (*webAuthnUser, error) {
	rows, err := s.auth.repo.ListPasskeysByUser(ctx, user.ID, s.passkeyRPID)
	if err != nil {
		return nil, err
	}
	credentials := make([]webauthnlib.Credential, 0, len(rows))
	for _, row := range rows {
		var credential webauthnlib.Credential
		if err := json.Unmarshal(row.CredentialJSON, &credential); err != nil {
			return nil, fmt.Errorf("decode passkey %s: %w", row.ID, err)
		}
		if !bytes.Equal(credential.ID, row.CredentialID) {
			return nil, fmt.Errorf("passkey %s credential id mismatch", row.ID)
		}
		credentials = append(credentials, credential)
	}
	return &webAuthnUser{user: *user, handle: handle, credentials: credentials}, nil
}
