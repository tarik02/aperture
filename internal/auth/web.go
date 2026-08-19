package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/alexedwards/scs/v2"
	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

const (
	webSessionUserIDKey       = "user_id"
	webSessionAuthMethodKey   = "auth_method"
	webSessionOIDCProviderKey = "oidc_provider"
	webSessionOIDCStateKey    = "oidc_state"
	webSessionOIDCNonceKey    = "oidc_nonce"
	webSessionReturnToKey     = "return_to"
)

type oidcProvider struct {
	id            string
	displayName   string
	autoProvision bool
	oauth         oauth2.Config
	verifier      *oidc.IDTokenVerifier
}

// OIDCProvider describes a provider exposed to the login UI.
type OIDCProvider struct {
	ID          string
	DisplayName string
}

// WebService owns browser sessions and OIDC providers.
type WebService struct {
	auth      *Service
	sessions  *scs.SessionManager
	providers map[string]*oidcProvider
	public    []OIDCProvider
}

// NewWebService initializes configured OIDC providers and durable browser sessions.
func NewWebService(ctx context.Context, cfg config.Config, authService *Service, database *sql.DB) (*WebService, error) {
	if len(cfg.OIDCProviders) == 0 {
		return nil, nil
	}

	baseURL := strings.TrimRight(cfg.ExternalBaseURL, "/")
	providers := make(map[string]*oidcProvider, len(cfg.OIDCProviders))
	public := make([]OIDCProvider, 0, len(cfg.OIDCProviders))
	for _, providerConfig := range cfg.OIDCProviders {
		provider, err := oidc.NewProvider(ctx, providerConfig.IssuerURL)
		if err != nil {
			return nil, fmt.Errorf("initialize oidc provider %s: %w", providerConfig.ID, err)
		}
		scopes := slices.Clone(providerConfig.Scopes)
		if len(scopes) == 0 {
			scopes = []string{oidc.ScopeOpenID, "profile", "email"}
		} else if !slices.Contains(scopes, oidc.ScopeOpenID) {
			scopes = append([]string{oidc.ScopeOpenID}, scopes...)
		}
		providers[providerConfig.ID] = &oidcProvider{
			id:            providerConfig.ID,
			displayName:   providerConfig.DisplayName,
			autoProvision: providerConfig.AutoProvision,
			oauth: oauth2.Config{
				ClientID:     providerConfig.ClientID,
				ClientSecret: providerConfig.ClientSecret,
				Endpoint:     provider.Endpoint(),
				RedirectURL:  baseURL + "/auth/oidc/" + url.PathEscape(providerConfig.ID) + "/callback",
				Scopes:       scopes,
			},
			verifier: provider.Verifier(&oidc.Config{ClientID: providerConfig.ClientID}),
		}
		public = append(public, OIDCProvider{ID: providerConfig.ID, DisplayName: providerConfig.DisplayName})
	}

	base, err := url.Parse(cfg.ExternalBaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse external base url: %w", err)
	}
	sessions := scs.New()
	sessions.Store = &webSessionStore{db: database}
	sessions.Lifetime = cfg.WebSessionLifetime
	sessions.IdleTimeout = cfg.WebSessionIdleTimeout
	sessions.HashTokenInStore = true
	sessions.Cookie.Name = "aperture_session"
	sessions.Cookie.Path = "/"
	sessions.Cookie.HttpOnly = true
	sessions.Cookie.SameSite = http.SameSiteLaxMode
	sessions.Cookie.Secure = base.Scheme == "https"
	sessions.Cookie.Persist = true

	return &WebService{auth: authService, sessions: sessions, providers: providers, public: public}, nil
}

// LoadAndSave loads browser session state around next.
func (s *WebService) LoadAndSave(next http.Handler) http.Handler {
	return s.sessions.LoadAndSave(next)
}

// Providers returns configured login providers in config order.
func (s *WebService) Providers() []OIDCProvider {
	return slices.Clone(s.public)
}

// BeginOIDC stores flow state and returns the provider authorization URL.
func (s *WebService) BeginOIDC(ctx context.Context, providerID, returnTo string) (string, error) {
	provider := s.providers[providerID]
	if provider == nil {
		return "", ErrOIDCProviderNotFound
	}
	state, err := randomWebValue()
	if err != nil {
		return "", err
	}
	nonce, err := randomWebValue()
	if err != nil {
		return "", err
	}
	if err := s.sessions.RenewToken(ctx); err != nil {
		return "", fmt.Errorf("renew oidc flow session: %w", err)
	}
	s.sessions.Put(ctx, webSessionOIDCProviderKey, providerID)
	s.sessions.Put(ctx, webSessionOIDCStateKey, state)
	s.sessions.Put(ctx, webSessionOIDCNonceKey, nonce)
	s.sessions.Put(ctx, webSessionReturnToKey, safeReturnTo(returnTo))
	return provider.oauth.AuthCodeURL(state, oidc.Nonce(nonce)), nil
}

// CompleteOIDC verifies the callback, authenticates the user, and establishes a browser session.
func (s *WebService) CompleteOIDC(ctx context.Context, providerID, state, code string) (*db.User, string, error) {
	provider := s.providers[providerID]
	if provider == nil {
		return nil, "", ErrOIDCProviderNotFound
	}
	if providerID != s.sessions.GetString(ctx, webSessionOIDCProviderKey) ||
		subtle.ConstantTimeCompare([]byte(state), []byte(s.sessions.GetString(ctx, webSessionOIDCStateKey))) != 1 {
		return nil, "", ErrOIDCFlowInvalid
	}

	token, err := provider.oauth.Exchange(ctx, code)
	if err != nil {
		return nil, "", fmt.Errorf("%w: exchange code", ErrOIDCAuthentication)
	}
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok {
		return nil, "", fmt.Errorf("%w: id token missing", ErrOIDCAuthentication)
	}
	idToken, err := provider.verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return nil, "", fmt.Errorf("%w: verify id token", ErrOIDCAuthentication)
	}
	if subtle.ConstantTimeCompare([]byte(idToken.Nonce), []byte(s.sessions.GetString(ctx, webSessionOIDCNonceKey))) != 1 {
		return nil, "", ErrOIDCFlowInvalid
	}

	var claims struct {
		Email             string `json:"email"`
		EmailVerified     bool   `json:"email_verified"`
		Name              string `json:"name"`
		PreferredUsername string `json:"preferred_username"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return nil, "", fmt.Errorf("%w: decode claims", ErrOIDCAuthentication)
	}
	var email *string
	if claims.EmailVerified && strings.TrimSpace(claims.Email) != "" {
		normalized := strings.ToLower(strings.TrimSpace(claims.Email))
		email = &normalized
	}
	displayName := strings.TrimSpace(claims.Name)
	if displayName == "" {
		displayName = strings.TrimSpace(claims.PreferredUsername)
	}
	user, err := s.auth.ResolveOIDCUser(ctx, ResolveOIDCUserInput{
		ProviderID:    provider.id,
		Subject:       idToken.Subject,
		Email:         email,
		DisplayName:   displayName,
		AutoProvision: provider.autoProvision,
	})
	if err != nil {
		return nil, "", err
	}
	returnTo := safeReturnTo(s.sessions.GetString(ctx, webSessionReturnToKey))
	principal := Principal{Type: PrincipalTypeUser, ID: user.ID, UserID: &user.ID, AuthMethod: AuthMethodOIDC, Name: user.DisplayName}
	if err := s.auth.RecordAudit(ctx, principal, AuditInput{Action: "user.logged_in", ResourceType: "user", ResourceID: &user.ID}); err != nil {
		return nil, "", err
	}
	if err := s.sessions.RenewToken(ctx); err != nil {
		return nil, "", fmt.Errorf("renew authenticated web session: %w", err)
	}
	if err := s.sessions.Clear(ctx); err != nil {
		return nil, "", fmt.Errorf("clear oidc flow session: %w", err)
	}
	s.sessions.Put(ctx, webSessionUserIDKey, user.ID)
	s.sessions.Put(ctx, webSessionAuthMethodKey, AuthMethodOIDC)
	return user, returnTo, nil
}

// Authenticate resolves the user stored in the current browser session.
func (s *WebService) Authenticate(ctx context.Context, selectedTenantID string) (Principal, error) {
	userID := s.sessions.GetString(ctx, webSessionUserIDKey)
	if userID == "" {
		return Principal{}, ErrTokenMissing
	}
	authMethod := s.sessions.GetString(ctx, webSessionAuthMethodKey)
	return s.auth.AuthenticateUser(ctx, userID, selectedTenantID, authMethod)
}

// Logout destroys the current browser session and returns its user id.
func (s *WebService) Logout(ctx context.Context) (string, error) {
	userID := s.sessions.GetString(ctx, webSessionUserIDKey)
	if err := s.sessions.Destroy(ctx); err != nil {
		return "", fmt.Errorf("destroy web session: %w", err)
	}
	return userID, nil
}

func randomWebValue() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate oidc flow value: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func safeReturnTo(raw string) string {
	if strings.HasPrefix(raw, "/") && !strings.HasPrefix(raw, "//") {
		return raw
	}
	return "/"
}
