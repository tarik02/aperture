package auth

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base32"
	"encoding/base64"
	"errors"
	"fmt"
	"image/png"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/alexedwards/argon2id"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/ids"
	"github.com/pquerna/otp/totp"
)

const (
	passwordMinLength = 12
	passwordMaxLength = 1024
	recoveryCodeCount = 10
	recoveryCodeBytes = 10

	webSessionPasswordMFAUserIDKey    = "password_mfa_user_id"
	webSessionPasswordMFAExpiresAtKey = "password_mfa_expires_at"
	webSessionTOTPSecretKey           = "totp_enrollment_secret"
	webSessionTOTPExpiresAtKey        = "totp_enrollment_expires_at"
)

var passwordHashParams = &argon2id.Params{
	Memory:      64 * 1024,
	Iterations:  3,
	Parallelism: 2,
	SaltLength:  16,
	KeyLength:   32,
}

// PasswordLoginResult reports whether the client must complete MFA.
type PasswordLoginResult struct {
	MFARequired bool
}

// SecurityStatus describes local credentials for the authenticated user.
type SecurityStatus struct {
	HasPassword            bool
	TOTPEnabled            bool
	RecoveryCodesRemaining int
}

// TOTPEnrollment contains an authenticator secret and rendered QR code.
type TOTPEnrollment struct {
	Secret        string
	OTPAuthURL    string
	QRCodeDataURL string
}

// LoginWithPassword validates an email and password and either establishes a session or starts MFA.
func (s *WebService) LoginWithPassword(ctx context.Context, email, password string) (PasswordLoginResult, error) {
	user, err := s.auth.repo.GetUserByEmail(ctx, strings.ToLower(strings.TrimSpace(email)))
	if err != nil {
		return PasswordLoginResult{}, err
	}

	passwordHash := s.passwordDummyHash
	var credential *db.UserPassword
	if user != nil {
		credential, err = s.auth.repo.GetUserPassword(ctx, user.ID)
		if err != nil {
			return PasswordLoginResult{}, err
		}
		if credential != nil {
			passwordHash = credential.PasswordHash
		}
	}

	match, err := argon2id.ComparePasswordAndHash(password, passwordHash)
	if err != nil {
		return PasswordLoginResult{}, fmt.Errorf("verify password hash: %w", err)
	}
	if !match || user == nil || credential == nil {
		return PasswordLoginResult{}, ErrPasswordAuthentication
	}
	if user.DisabledAt != nil {
		return PasswordLoginResult{}, ErrUserDisabled
	}

	totpCredential, err := s.auth.repo.GetTOTPCredential(ctx, user.ID)
	if err != nil {
		return PasswordLoginResult{}, err
	}
	if totpCredential == nil {
		if err := s.establishAuthenticatedSession(ctx, user, AuthMethodPassword); err != nil {
			return PasswordLoginResult{}, err
		}
		return PasswordLoginResult{}, nil
	}

	if err := s.sessions.RenewToken(ctx); err != nil {
		return PasswordLoginResult{}, fmt.Errorf("renew password mfa session: %w", err)
	}
	if err := s.sessions.Clear(ctx); err != nil {
		return PasswordLoginResult{}, fmt.Errorf("clear password login session: %w", err)
	}
	s.sessions.Put(ctx, webSessionPasswordMFAUserIDKey, user.ID)
	s.sessions.Put(ctx, webSessionPasswordMFAExpiresAtKey, time.Now().UTC().Add(5*time.Minute).Format(time.RFC3339Nano))
	return PasswordLoginResult{MFARequired: true}, nil
}

// CompletePasswordMFA verifies TOTP or a recovery code and establishes a session.
func (s *WebService) CompletePasswordMFA(ctx context.Context, code string) error {
	userID := s.sessions.GetString(ctx, webSessionPasswordMFAUserIDKey)
	expiresAt, err := time.Parse(time.RFC3339Nano, s.sessions.GetString(ctx, webSessionPasswordMFAExpiresAtKey))
	if userID == "" || err != nil || !time.Now().UTC().Before(expiresAt) {
		return ErrMFAFlowInvalid
	}
	user, err := s.auth.GetUser(ctx, userID)
	if err != nil {
		return err
	}
	if user.DisabledAt != nil {
		return ErrUserDisabled
	}
	method, err := s.verifySecondFactor(ctx, user.ID, code)
	if err != nil {
		return err
	}
	if method == "recovery_code" {
		principal := Principal{Type: PrincipalTypeUser, ID: user.ID, UserID: &user.ID, AuthMethod: AuthMethodPassword, Name: user.DisplayName}
		if err := s.auth.RecordAudit(ctx, principal, AuditInput{
			Action:       "recovery_code.used",
			ResourceType: "user",
			ResourceID:   &user.ID,
		}); err != nil {
			return err
		}
	}
	return s.establishAuthenticatedSession(ctx, user, AuthMethodPassword)
}

// GetSecurityStatus returns local authentication state for the authenticated user.
func (s *WebService) GetSecurityStatus(ctx context.Context) (SecurityStatus, error) {
	user, _, err := s.authenticatedWebUser(ctx)
	if err != nil {
		return SecurityStatus{}, err
	}
	password, err := s.auth.repo.GetUserPassword(ctx, user.ID)
	if err != nil {
		return SecurityStatus{}, err
	}
	totpCredential, err := s.auth.repo.GetTOTPCredential(ctx, user.ID)
	if err != nil {
		return SecurityStatus{}, err
	}
	remaining := 0
	if totpCredential != nil {
		remaining, err = s.auth.repo.CountUnusedRecoveryCodes(ctx, user.ID)
		if err != nil {
			return SecurityStatus{}, err
		}
	}
	return SecurityStatus{
		HasPassword:            password != nil,
		TOTPEnabled:            totpCredential != nil,
		RecoveryCodesRemaining: remaining,
	}, nil
}

// SetPassword creates or changes the authenticated user's password.
func (s *WebService) SetPassword(ctx context.Context, currentPassword, newPassword string) error {
	passwordLength := utf8.RuneCountInString(newPassword)
	if passwordLength < passwordMinLength || passwordLength > passwordMaxLength {
		return ErrPasswordInvalid
	}
	user, authMethod, err := s.authenticatedWebUser(ctx)
	if err != nil {
		return err
	}
	if user.Email == nil {
		return ErrPasswordEmailRequired
	}
	existing, err := s.auth.repo.GetUserPassword(ctx, user.ID)
	if err != nil {
		return err
	}
	action := "password.set"
	createdAt := db.NowUTC()
	if existing != nil {
		action = "password.changed"
		createdAt = existing.CreatedAt
		if currentPassword == "" {
			return ErrCurrentPasswordMissing
		}
		match, err := argon2id.ComparePasswordAndHash(currentPassword, existing.PasswordHash)
		if err != nil {
			return fmt.Errorf("verify current password hash: %w", err)
		}
		if !match {
			return ErrCurrentPasswordInvalid
		}
	}
	passwordHash, err := argon2id.CreateHash(newPassword, passwordHashParams)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}
	now := db.NowUTC()
	if err := s.auth.repo.UpsertUserPassword(ctx, &db.UserPassword{
		UserID:       user.ID,
		PasswordHash: passwordHash,
		CreatedAt:    createdAt,
		UpdatedAt:    now,
	}); err != nil {
		return err
	}
	principal := Principal{Type: PrincipalTypeUser, ID: user.ID, UserID: &user.ID, AuthMethod: authMethod, Name: user.DisplayName}
	return s.auth.RecordAudit(ctx, principal, AuditInput{Action: action, ResourceType: "user", ResourceID: &user.ID})
}

// BeginTOTPEnrollment generates a new authenticator secret for the authenticated user.
func (s *WebService) BeginTOTPEnrollment(ctx context.Context) (TOTPEnrollment, error) {
	user, _, err := s.authenticatedWebUser(ctx)
	if err != nil {
		return TOTPEnrollment{}, err
	}
	existing, err := s.auth.repo.GetTOTPCredential(ctx, user.ID)
	if err != nil {
		return TOTPEnrollment{}, err
	}
	if existing != nil {
		return TOTPEnrollment{}, ErrTOTPAlreadyEnabled
	}
	accountName := user.DisplayName
	if user.Email != nil {
		accountName = *user.Email
	}
	key, err := totp.Generate(totp.GenerateOpts{Issuer: "Aperture", AccountName: accountName})
	if err != nil {
		return TOTPEnrollment{}, fmt.Errorf("generate totp secret: %w", err)
	}
	image, err := key.Image(256, 256)
	if err != nil {
		return TOTPEnrollment{}, fmt.Errorf("render totp qr code: %w", err)
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image); err != nil {
		return TOTPEnrollment{}, fmt.Errorf("encode totp qr code: %w", err)
	}
	s.sessions.Put(ctx, webSessionTOTPSecretKey, key.Secret())
	s.sessions.Put(ctx, webSessionTOTPExpiresAtKey, time.Now().UTC().Add(10*time.Minute).Format(time.RFC3339Nano))
	return TOTPEnrollment{
		Secret:        key.Secret(),
		OTPAuthURL:    key.URL(),
		QRCodeDataURL: "data:image/png;base64," + base64.StdEncoding.EncodeToString(encoded.Bytes()),
	}, nil
}

// CompleteTOTPEnrollment verifies the first code and returns new recovery codes once.
func (s *WebService) CompleteTOTPEnrollment(ctx context.Context, code string) ([]string, error) {
	user, authMethod, err := s.authenticatedWebUser(ctx)
	if err != nil {
		return nil, err
	}
	secret := s.sessions.GetString(ctx, webSessionTOTPSecretKey)
	expiresAt, err := time.Parse(time.RFC3339Nano, s.sessions.GetString(ctx, webSessionTOTPExpiresAtKey))
	if secret == "" || err != nil || !time.Now().UTC().Before(expiresAt) {
		return nil, ErrMFAFlowInvalid
	}
	if !totp.Validate(strings.TrimSpace(code), secret) {
		return nil, ErrMFACodeInvalid
	}
	plainCodes, storedCodes, err := generateRecoveryCodes(user.ID)
	if err != nil {
		return nil, err
	}
	now := db.NowUTC()
	if err := s.auth.repo.CreateTOTPCredential(ctx, &db.TOTPCredential{
		UserID:    user.ID,
		Secret:    secret,
		CreatedAt: now,
		UpdatedAt: now,
	}, storedCodes); err != nil {
		if isUniqueViolation(err) {
			return nil, ErrTOTPAlreadyEnabled
		}
		return nil, err
	}
	s.sessions.Remove(ctx, webSessionTOTPSecretKey)
	s.sessions.Remove(ctx, webSessionTOTPExpiresAtKey)
	principal := Principal{Type: PrincipalTypeUser, ID: user.ID, UserID: &user.ID, AuthMethod: authMethod, Name: user.DisplayName}
	if err := s.auth.RecordAudit(ctx, principal, AuditInput{Action: "totp.enabled", ResourceType: "user", ResourceID: &user.ID}); err != nil {
		return nil, err
	}
	return plainCodes, nil
}

// RegenerateRecoveryCodes replaces every existing recovery code after MFA verification.
func (s *WebService) RegenerateRecoveryCodes(ctx context.Context, code string) ([]string, error) {
	user, authMethod, err := s.authenticatedWebUser(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := s.verifySecondFactor(ctx, user.ID, code); err != nil {
		return nil, err
	}
	plainCodes, storedCodes, err := generateRecoveryCodes(user.ID)
	if err != nil {
		return nil, err
	}
	if err := s.auth.repo.ReplaceRecoveryCodes(ctx, user.ID, storedCodes); err != nil {
		return nil, err
	}
	principal := Principal{Type: PrincipalTypeUser, ID: user.ID, UserID: &user.ID, AuthMethod: authMethod, Name: user.DisplayName}
	if err := s.auth.RecordAudit(ctx, principal, AuditInput{Action: "recovery_codes.regenerated", ResourceType: "user", ResourceID: &user.ID}); err != nil {
		return nil, err
	}
	return plainCodes, nil
}

// DisableTOTP removes the authenticator and recovery codes after MFA verification.
func (s *WebService) DisableTOTP(ctx context.Context, code string) error {
	user, authMethod, err := s.authenticatedWebUser(ctx)
	if err != nil {
		return err
	}
	if _, err := s.verifySecondFactor(ctx, user.ID, code); err != nil {
		return err
	}
	if err := s.auth.repo.DeleteTOTPCredential(ctx, user.ID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrTOTPNotEnabled
		}
		return err
	}
	principal := Principal{Type: PrincipalTypeUser, ID: user.ID, UserID: &user.ID, AuthMethod: authMethod, Name: user.DisplayName}
	return s.auth.RecordAudit(ctx, principal, AuditInput{Action: "totp.disabled", ResourceType: "user", ResourceID: &user.ID})
}

func (s *WebService) verifySecondFactor(ctx context.Context, userID, code string) (string, error) {
	credential, err := s.auth.repo.GetTOTPCredential(ctx, userID)
	if err != nil {
		return "", err
	}
	if credential == nil {
		return "", ErrTOTPNotEnabled
	}
	if totp.Validate(strings.TrimSpace(code), credential.Secret) {
		return "totp", nil
	}
	codeHash := hashRecoveryCode(code)
	consumed, err := s.auth.repo.ConsumeRecoveryCode(ctx, userID, codeHash[:], db.NowUTC())
	if err != nil {
		return "", err
	}
	if !consumed {
		return "", ErrMFACodeInvalid
	}
	return "recovery_code", nil
}

func generateRecoveryCodes(userID string) ([]string, []db.RecoveryCode, error) {
	plainCodes := make([]string, 0, recoveryCodeCount)
	storedCodes := make([]db.RecoveryCode, 0, recoveryCodeCount)
	now := db.NowUTC()
	encoding := base32.StdEncoding.WithPadding(base32.NoPadding)
	for range recoveryCodeCount {
		value := make([]byte, recoveryCodeBytes)
		if _, err := rand.Read(value); err != nil {
			return nil, nil, fmt.Errorf("generate recovery code: %w", err)
		}
		canonical := encoding.EncodeToString(value)
		display := strings.Join([]string{canonical[0:4], canonical[4:8], canonical[8:12], canonical[12:16]}, "-")
		codeID, err := ids.NewUUIDv7()
		if err != nil {
			return nil, nil, err
		}
		hash := sha256.Sum256([]byte(canonical))
		plainCodes = append(plainCodes, display)
		storedCodes = append(storedCodes, db.RecoveryCode{
			ID:        codeID,
			UserID:    userID,
			CodeHash:  hash[:],
			CreatedAt: now,
		})
	}
	return plainCodes, storedCodes, nil
}

func hashRecoveryCode(code string) [sha256.Size]byte {
	canonical := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(code), "-", ""))
	return sha256.Sum256([]byte(canonical))
}
