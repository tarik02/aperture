package auth

import (
	"context"
	"fmt"
	"strings"

	"github.com/aperture/aperture/internal/db"
)

// ResolveOIDCUserInput describes verified OIDC identity claims.
type ResolveOIDCUserInput struct {
	ProviderID   string
	Subject      string
	Email        *string
	DisplayName  string
	AutoProvision bool
}

// ResolveOIDCUser maps a verified provider subject to an active user.
func (s *Service) ResolveOIDCUser(ctx context.Context, input ResolveOIDCUserInput) (*db.User, error) {
	identity, err := s.repo.GetOIDCIdentity(ctx, input.ProviderID, input.Subject)
	if err != nil {
		return nil, err
	}
	now := db.NowUTC()
	if identity != nil {
		if err := s.repo.TouchOIDCIdentity(ctx, input.ProviderID, input.Subject, input.Email, now); err != nil {
			return nil, err
		}
		user, err := s.GetUser(ctx, identity.UserID)
		if err != nil {
			return nil, err
		}
		if user.DisabledAt != nil {
			return nil, ErrUserDisabled
		}
		return user, nil
	}

	var user *db.User
	if input.Email != nil {
		user, err = s.repo.GetUserByEmail(ctx, *input.Email)
		if err != nil {
			return nil, err
		}
	}
	if user == nil {
		if !input.AutoProvision {
			return nil, ErrIdentityNotProvisioned
		}
		displayName := strings.TrimSpace(input.DisplayName)
		if displayName == "" && input.Email != nil {
			displayName = *input.Email
		}
		if displayName == "" {
			displayName = input.Subject
		}
		user, err = s.CreateUser(ctx, CreateUserInput{Email: input.Email, DisplayName: displayName})
		if err != nil {
			return nil, err
		}
	}
	if user.DisabledAt != nil {
		return nil, ErrUserDisabled
	}

	identity = &db.OIDCIdentity{
		ProviderID:  input.ProviderID,
		Subject:     input.Subject,
		UserID:      user.ID,
		Email:       input.Email,
		CreatedAt:   now,
		LastLoginAt: now,
	}
	if err := s.repo.CreateOIDCIdentity(ctx, identity); err != nil {
		return nil, fmt.Errorf("link oidc identity: %w", err)
	}
	return user, nil
}
