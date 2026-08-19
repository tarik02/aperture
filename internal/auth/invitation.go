package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/alexedwards/argon2id"
	"github.com/aperture/aperture/internal/db"
)

const invitationLifetime = 7 * 24 * time.Hour

// CreatedUserInvitation is returned once when a password link is created.
type CreatedUserInvitation struct {
	Token     string
	ExpiresAt time.Time
}

// CreateUserInvitation creates or replaces a user's outstanding password link.
func (s *Service) CreateUserInvitation(ctx context.Context, userID string) (CreatedUserInvitation, error) {
	user, err := s.GetUser(ctx, userID)
	if err != nil {
		return CreatedUserInvitation{}, err
	}
	if user.DisabledAt != nil || user.Email == nil {
		return CreatedUserInvitation{}, ErrInvitationUnavailable
	}

	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return CreatedUserInvitation{}, fmt.Errorf("generate user invitation: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	tokenHash := sha256.Sum256([]byte(token))
	now := s.now().UTC()
	expiresAt := now.Add(invitationLifetime)
	if err := s.repo.UpsertUserInvitation(ctx, &db.UserInvitation{
		UserID:    user.ID,
		TokenHash: tokenHash[:],
		ExpiresAt: expiresAt.Format(time.RFC3339Nano),
		CreatedAt: now.Format(time.RFC3339Nano),
	}); err != nil {
		return CreatedUserInvitation{}, err
	}
	return CreatedUserInvitation{Token: token, ExpiresAt: expiresAt}, nil
}

// UserInvitationAvailable reports whether a setup link can be created for a user.
func (s *Service) UserInvitationAvailable(ctx context.Context, userID string) (bool, error) {
	user, err := s.GetUser(ctx, userID)
	if err != nil {
		return false, err
	}
	return s.userInvitationAvailable(ctx, user)
}

func (s *Service) userInvitationAvailable(ctx context.Context, user *db.User) (bool, error) {
	if user.DisabledAt != nil || user.Email == nil {
		return false, nil
	}
	existingPassword, err := s.repo.GetUserPassword(ctx, user.ID)
	if err != nil {
		return false, err
	}
	return existingPassword == nil, nil
}

// AcceptUserInvitation consumes a password link and stores the chosen password.
func (s *Service) AcceptUserInvitation(ctx context.Context, token, password string) (*db.User, error) {
	passwordLength := utf8.RuneCountInString(password)
	if passwordLength < passwordMinLength || passwordLength > passwordMaxLength {
		return nil, ErrPasswordInvalid
	}
	tokenHash := sha256.Sum256([]byte(token))
	invitation, err := s.repo.GetUserInvitationByTokenHash(ctx, tokenHash[:])
	if err != nil {
		return nil, err
	}
	if invitation == nil {
		return nil, ErrInvitationInvalid
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, invitation.ExpiresAt)
	if err != nil {
		return nil, fmt.Errorf("parse user invitation expiry: %w", err)
	}
	if !s.now().UTC().Before(expiresAt) {
		return nil, ErrInvitationInvalid
	}
	user, err := s.GetUser(ctx, invitation.UserID)
	if err != nil {
		return nil, err
	}
	if user.DisabledAt != nil || user.Email == nil {
		return nil, ErrInvitationInvalid
	}
	passwordHash, err := argon2id.CreateHash(password, passwordHashParams)
	if err != nil {
		return nil, fmt.Errorf("hash password: %w", err)
	}
	now := s.now().UTC().Format(time.RFC3339Nano)
	if err := s.repo.AcceptUserInvitation(ctx, invitation, &db.UserPassword{
		UserID:       user.ID,
		PasswordHash: passwordHash,
		CreatedAt:    now,
		UpdatedAt:    now,
	}); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrInvitationInvalid
		}
		return nil, err
	}
	return user, nil
}
