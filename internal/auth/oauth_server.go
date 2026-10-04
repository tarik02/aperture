package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/ids"
)

const (
	OAuthAccessTokenTTL  = time.Hour
	OAuthRefreshTokenTTL = 30 * 24 * time.Hour
	oauthCodeTTL         = 5 * time.Minute

	// oauthRefreshReuseGrace tolerates a client racing two refreshes with the
	// same token; reuse after this window is treated as token theft.
	oauthRefreshReuseGrace = 30 * time.Second

	OAuthClientKindRegistered       = "registered"
	OAuthClientKindMetadataDocument = "metadata_document"

	oauthAuthMethodNone              = "none"
	oauthAuthMethodClientSecretPost  = "client_secret_post"
	oauthAuthMethodClientSecretBasic = "client_secret_basic"

	OAuthGrantTypeAuthorizationCode = "authorization_code"
	OAuthGrantTypeRefreshToken      = "refresh_token"
)

// OAuthError is an OAuth 2.0 protocol error (RFC 6749 section 5.2).
type OAuthError struct {
	Code        string
	Description string
}

func (e *OAuthError) Error() string {
	return e.Code + ": " + e.Description
}

func oauthError(code, description string) *OAuthError {
	return &OAuthError{Code: code, Description: description}
}

// OAuthServer is the authorization server MCP clients use to obtain access
// tokens on behalf of a signed-in user.
type OAuthServer struct {
	auth           *Service
	repo           *db.Repository
	issuer         string
	metadataClient *http.Client
}

// NewOAuthServer constructs an authorization server issuing for externalBaseURL.
func NewOAuthServer(service *Service, repo *db.Repository, externalBaseURL string) *OAuthServer {
	return &OAuthServer{
		auth:           service,
		repo:           repo,
		issuer:         strings.TrimRight(externalBaseURL, "/"),
		metadataClient: newMetadataDocumentHTTPClient(),
	}
}

// Issuer returns the authorization server issuer identifier.
func (o *OAuthServer) Issuer() string {
	return o.issuer
}

// AuthorizationServerMetadata is the RFC 8414 metadata document.
type AuthorizationServerMetadata struct {
	Issuer                            string   `json:"issuer"`
	AuthorizationEndpoint             string   `json:"authorization_endpoint"`
	TokenEndpoint                     string   `json:"token_endpoint"`
	RegistrationEndpoint              string   `json:"registration_endpoint"`
	RevocationEndpoint                string   `json:"revocation_endpoint"`
	ScopesSupported                   []string `json:"scopes_supported"`
	ResponseTypesSupported            []string `json:"response_types_supported"`
	ResponseModesSupported            []string `json:"response_modes_supported"`
	GrantTypesSupported               []string `json:"grant_types_supported"`
	TokenEndpointAuthMethodsSupported []string `json:"token_endpoint_auth_methods_supported"`
	RevocationEndpointAuthMethods     []string `json:"revocation_endpoint_auth_methods_supported"`
	CodeChallengeMethodsSupported     []string `json:"code_challenge_methods_supported"`
	ClientIDMetadataDocumentSupported bool     `json:"client_id_metadata_document_supported"`
	AuthorizationResponseIssParameter bool     `json:"authorization_response_iss_parameter_supported"`
}

// ProtectedResourceMetadata is the RFC 9728 metadata document.
type ProtectedResourceMetadata struct {
	Resource               string   `json:"resource"`
	AuthorizationServers   []string `json:"authorization_servers"`
	ScopesSupported        []string `json:"scopes_supported"`
	BearerMethodsSupported []string `json:"bearer_methods_supported"`
	ResourceName           string   `json:"resource_name"`
}

// AuthorizationServerMetadata describes this authorization server.
func (o *OAuthServer) AuthorizationServerMetadata() AuthorizationServerMetadata {
	authMethods := []string{oauthAuthMethodNone, oauthAuthMethodClientSecretPost, oauthAuthMethodClientSecretBasic}
	return AuthorizationServerMetadata{
		Issuer:                            o.issuer,
		AuthorizationEndpoint:             o.issuer + "/oauth/authorize",
		TokenEndpoint:                     o.issuer + "/oauth/token",
		RegistrationEndpoint:              o.issuer + "/oauth/register",
		RevocationEndpoint:                o.issuer + "/oauth/revoke",
		ScopesSupported:                   oauthScopesSupported(),
		ResponseTypesSupported:            []string{"code"},
		ResponseModesSupported:            []string{"query"},
		GrantTypesSupported:               []string{OAuthGrantTypeAuthorizationCode, OAuthGrantTypeRefreshToken},
		TokenEndpointAuthMethodsSupported: authMethods,
		RevocationEndpointAuthMethods:     authMethods,
		CodeChallengeMethodsSupported:     []string{"S256"},
		ClientIDMetadataDocumentSupported: true,
		AuthorizationResponseIssParameter: true,
	}
}

// ProtectedResourceMetadata describes a resource protected by this server.
func (o *OAuthServer) ProtectedResourceMetadata(resource string) ProtectedResourceMetadata {
	return ProtectedResourceMetadata{
		Resource:               resource,
		AuthorizationServers:   []string{o.issuer},
		ScopesSupported:        oauthScopesSupported(),
		BearerMethodsSupported: []string{"header"},
		ResourceName:           "Aperture",
	}
}

func oauthScopesSupported() []string {
	return append(TenantScopes(), ScopeSystemAdmin)
}

// OAuthClientMetadata is the subset of RFC 7591 client metadata Aperture uses.
// It is shared by dynamic registration and client ID metadata documents.
type OAuthClientMetadata struct {
	RedirectURIs            []string `json:"redirect_uris"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method,omitempty"`
	GrantTypes              []string `json:"grant_types,omitempty"`
	ResponseTypes           []string `json:"response_types,omitempty"`
	ClientName              string   `json:"client_name,omitempty"`
	ClientURI               string   `json:"client_uri,omitempty"`
	LogoURI                 string   `json:"logo_uri,omitempty"`
	Scope                   string   `json:"scope,omitempty"`
}

// RegisteredOAuthClient is the result of dynamic client registration.
type RegisteredOAuthClient struct {
	ClientID     string
	ClientSecret string
	IssuedAt     time.Time
	Metadata     OAuthClientMetadata
}

// RegisterClient performs RFC 7591 dynamic client registration.
func (o *OAuthServer) RegisterClient(ctx context.Context, metadata OAuthClientMetadata) (RegisteredOAuthClient, error) {
	// RFC 7591 section 2 defaults the method to client_secret_basic.
	if metadata.TokenEndpointAuthMethod == "" {
		metadata.TokenEndpointAuthMethod = oauthAuthMethodClientSecretBasic
	}
	if !slices.Contains([]string{oauthAuthMethodNone, oauthAuthMethodClientSecretPost, oauthAuthMethodClientSecretBasic}, metadata.TokenEndpointAuthMethod) {
		return RegisteredOAuthClient{}, oauthError("invalid_client_metadata", "unsupported token_endpoint_auth_method")
	}
	normalized, err := normalizeClientMetadata(metadata)
	if err != nil {
		return RegisteredOAuthClient{}, err
	}

	clientID, err := ids.NewUUIDv7()
	if err != nil {
		return RegisteredOAuthClient{}, err
	}
	var secret string
	var secretHash *string
	if normalized.TokenEndpointAuthMethod != oauthAuthMethodNone {
		raw, hash, err := generateOAuthSecret(oauthClientSecretPrefix, clientID)
		if err != nil {
			return RegisteredOAuthClient{}, err
		}
		secret = raw
		secretHash = &hash
	}
	client, err := oauthClientRow(clientID, OAuthClientKindRegistered, normalized, secretHash)
	if err != nil {
		return RegisteredOAuthClient{}, err
	}
	if err := o.repo.CreateOAuthClient(ctx, client); err != nil {
		return RegisteredOAuthClient{}, err
	}
	issuedAt, err := time.Parse(time.RFC3339Nano, client.CreatedAt)
	if err != nil {
		return RegisteredOAuthClient{}, err
	}
	return RegisteredOAuthClient{ClientID: clientID, ClientSecret: secret, IssuedAt: issuedAt, Metadata: normalized}, nil
}

func normalizeClientMetadata(metadata OAuthClientMetadata) (OAuthClientMetadata, error) {
	if len(metadata.RedirectURIs) == 0 {
		return OAuthClientMetadata{}, oauthError("invalid_redirect_uri", "redirect_uris is required")
	}
	for _, redirectURI := range metadata.RedirectURIs {
		if err := validateRedirectURI(redirectURI); err != nil {
			return OAuthClientMetadata{}, oauthError("invalid_redirect_uri", err.Error())
		}
	}

	if len(metadata.GrantTypes) == 0 {
		metadata.GrantTypes = []string{OAuthGrantTypeAuthorizationCode}
	}
	if !slices.Contains(metadata.GrantTypes, OAuthGrantTypeAuthorizationCode) {
		return OAuthClientMetadata{}, oauthError("invalid_client_metadata", "grant_types must include authorization_code")
	}
	metadata.GrantTypes = slices.DeleteFunc(slices.Clone(metadata.GrantTypes), func(grantType string) bool {
		return grantType != OAuthGrantTypeAuthorizationCode && grantType != OAuthGrantTypeRefreshToken
	})

	if len(metadata.ResponseTypes) == 0 {
		metadata.ResponseTypes = []string{"code"}
	}
	if !slices.Equal(metadata.ResponseTypes, []string{"code"}) {
		return OAuthClientMetadata{}, oauthError("invalid_client_metadata", "response_types must be [\"code\"]")
	}

	metadata.ClientName = strings.TrimSpace(metadata.ClientName)
	if metadata.ClientName == "" {
		metadata.ClientName = "Unnamed client"
	}
	if !isWebURL(metadata.ClientURI) {
		metadata.ClientURI = ""
	}
	if !isWebURL(metadata.LogoURI) {
		metadata.LogoURI = ""
	}
	return metadata, nil
}

func oauthClientRow(clientID, kind string, metadata OAuthClientMetadata, secretHash *string) (*db.OAuthClient, error) {
	redirectURIs, err := json.Marshal(metadata.RedirectURIs)
	if err != nil {
		return nil, err
	}
	metadataJSON, err := json.Marshal(metadata)
	if err != nil {
		return nil, err
	}
	now := db.NowUTC()
	return &db.OAuthClient{
		ID:                      clientID,
		Kind:                    kind,
		ClientName:              metadata.ClientName,
		ClientURI:               optionalString(metadata.ClientURI),
		LogoURI:                 optionalString(metadata.LogoURI),
		RedirectURIsJSON:        string(redirectURIs),
		TokenEndpointAuthMethod: metadata.TokenEndpointAuthMethod,
		ClientSecretHash:        secretHash,
		MetadataJSON:            string(metadataJSON),
		CreatedAt:               now,
		UpdatedAt:               now,
	}, nil
}

func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func (o *OAuthServer) resolveClient(ctx context.Context, clientID string) (*db.OAuthClient, error) {
	if isMetadataDocumentClientID(clientID) {
		return o.metadataDocumentClient(ctx, clientID)
	}
	client, err := o.repo.GetOAuthClient(ctx, clientID)
	if err != nil {
		return nil, err
	}
	if client == nil {
		return nil, oauthError("invalid_client", "unknown client_id")
	}
	return client, nil
}

// OAuthAuthorizationRequest is a validated authorization request.
type OAuthAuthorizationRequest struct {
	Client          db.OAuthClient
	RedirectURI     string
	State           string
	CodeChallenge   string
	Resource        string
	RequestedScopes []string
}

// ParseAuthorizationRequest validates an authorization request. Errors about
// the client or redirect URI return a nil request and must be shown to the
// user; other errors return the request so the caller can redirect them back
// to the client with ErrorRedirectURL.
func (o *OAuthServer) ParseAuthorizationRequest(ctx context.Context, query url.Values) (*OAuthAuthorizationRequest, error) {
	clientID := query.Get("client_id")
	if clientID == "" {
		return nil, oauthError("invalid_request", "client_id is required")
	}
	client, err := o.resolveClient(ctx, clientID)
	if err != nil {
		return nil, err
	}
	var redirectURIs []string
	if err := json.Unmarshal([]byte(client.RedirectURIsJSON), &redirectURIs); err != nil {
		return nil, fmt.Errorf("decode client redirect uris: %w", err)
	}
	redirectURI := query.Get("redirect_uri")
	if redirectURI == "" {
		if len(redirectURIs) != 1 {
			return nil, oauthError("invalid_request", "redirect_uri is required")
		}
		redirectURI = redirectURIs[0]
	}
	if !slices.ContainsFunc(redirectURIs, func(registered string) bool { return redirectURIMatches(registered, redirectURI) }) {
		return nil, oauthError("invalid_request", "redirect_uri is not registered for this client")
	}

	request := &OAuthAuthorizationRequest{
		Client:      *client,
		RedirectURI: redirectURI,
		State:       query.Get("state"),
	}
	if query.Get("response_type") != "code" {
		return request, oauthError("unsupported_response_type", "response_type must be code")
	}
	request.CodeChallenge = query.Get("code_challenge")
	if request.CodeChallenge == "" || query.Get("code_challenge_method") != "S256" {
		return request, oauthError("invalid_request", "PKCE with code_challenge_method S256 is required")
	}
	if resource := query.Get("resource"); resource != "" {
		if !o.isOwnResource(resource) {
			return request, oauthError("invalid_target", "resource is not served by this authorization server")
		}
		request.Resource = resource
	}
	// Unknown scopes are ignored rather than rejected: clients often request
	// whatever they find in scopes_supported or generic scopes like "openid".
	known := oauthScopesSupported()
	for _, scope := range strings.Fields(query.Get("scope")) {
		if slices.Contains(known, scope) && !slices.Contains(request.RequestedScopes, scope) {
			request.RequestedScopes = append(request.RequestedScopes, scope)
		}
	}
	return request, nil
}

func (o *OAuthServer) isOwnResource(resource string) bool {
	parsed, err := url.Parse(resource)
	if err != nil || !parsed.IsAbs() || parsed.Fragment != "" {
		return false
	}
	return resource == o.issuer || strings.HasPrefix(resource, o.issuer+"/")
}

// ErrorRedirectURL returns the client redirect carrying an authorization error.
func (o *OAuthServer) ErrorRedirectURL(request *OAuthAuthorizationRequest, oauthErr *OAuthError) (string, error) {
	return o.redirectURL(request, url.Values{"error": {oauthErr.Code}, "error_description": {oauthErr.Description}})
}

func (o *OAuthServer) redirectURL(request *OAuthAuthorizationRequest, params url.Values) (string, error) {
	target, err := url.Parse(request.RedirectURI)
	if err != nil {
		return "", fmt.Errorf("parse redirect uri: %w", err)
	}
	query := target.Query()
	for key, values := range params {
		query[key] = values
	}
	if request.State != "" {
		query.Set("state", request.State)
	}
	query.Set("iss", o.issuer)
	target.RawQuery = query.Encode()
	return target.String(), nil
}

// OAuthConsent describes what a user is asked to authorize.
type OAuthConsent struct {
	Request *OAuthAuthorizationRequest
	User    *db.User
	Tenants []TenantAccess
}

// DescribeConsent validates an authorization request for the signed-in user.
func (o *OAuthServer) DescribeConsent(ctx context.Context, userID string, query url.Values) (OAuthConsent, error) {
	user, err := o.consentUser(ctx, userID)
	if err != nil {
		return OAuthConsent{}, err
	}
	request, err := o.ParseAuthorizationRequest(ctx, query)
	if err != nil {
		return OAuthConsent{}, err
	}
	tenants, err := o.auth.AccessibleTenants(ctx, user)
	if err != nil {
		return OAuthConsent{}, err
	}
	return OAuthConsent{Request: request, User: user, Tenants: tenants}, nil
}

func (o *OAuthServer) consentUser(ctx context.Context, userID string) (*db.User, error) {
	if userID == "" {
		return nil, ErrTokenMissing
	}
	user, err := o.auth.GetUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	if user.DisabledAt != nil {
		return nil, ErrUserDisabled
	}
	return user, nil
}

// OAuthConsentInput is the access a user chose to grant.
type OAuthConsentInput struct {
	SystemAdmin    bool
	TenantIDs      []string
	Scopes         []string
	ResourceMode   string
	ResourceGrants []ResourceGrant
}

type oauthConsentRecord struct {
	AuthorityType  string                 `json:"authorityType"`
	TenantIDs      []string               `json:"tenantIds"`
	Scopes         []string               `json:"scopes"`
	ResourceMode   string                 `json:"resourceMode"`
	ResourceGrants []oauthConsentResource `json:"resourceGrants"`
}

type oauthConsentResource struct {
	ResourceType string `json:"resourceType"`
	ResourceID   string `json:"resourceId"`
}

// Approve records the user's consent and returns the client redirect carrying an authorization code.
func (o *OAuthServer) Approve(ctx context.Context, userID string, query url.Values, input OAuthConsentInput) (string, error) {
	user, err := o.consentUser(ctx, userID)
	if err != nil {
		return "", err
	}
	request, err := o.ParseAuthorizationRequest(ctx, query)
	if err != nil {
		return "", err
	}
	consent, err := o.validateConsent(ctx, user, input)
	if err != nil {
		return "", err
	}
	consentJSON, err := json.Marshal(consent)
	if err != nil {
		return "", err
	}

	codeID, err := ids.NewUUIDv7()
	if err != nil {
		return "", err
	}
	rawCode, codeHash, err := generateOAuthSecret(oauthCodePrefix, codeID)
	if err != nil {
		return "", err
	}
	now := o.auth.now().UTC()
	code := &db.OAuthAuthorizationCode{
		ID:            codeID,
		CodeHash:      codeHash,
		ClientID:      request.Client.ID,
		UserID:        user.ID,
		RedirectURI:   request.RedirectURI,
		CodeChallenge: request.CodeChallenge,
		Resource:      optionalString(request.Resource),
		ConsentJSON:   string(consentJSON),
		CreatedAt:     now.Format(time.RFC3339Nano),
		ExpiresAt:     now.Add(oauthCodeTTL).Format(time.RFC3339Nano),
	}
	audit, err := o.auth.newAuditEvent(oauthUserActor(user.ID), AuditInput{
		Action:       "oauth_consent.granted",
		ResourceType: "oauth_client",
		ResourceID:   &request.Client.ID,
		Data: map[string]any{
			"authorityType":      consent.AuthorityType,
			"tenantIds":          consent.TenantIDs,
			"scopes":             consent.Scopes,
			"resourceMode":       consent.ResourceMode,
			"resourceGrantCount": len(consent.ResourceGrants),
		},
	})
	if err != nil {
		return "", err
	}
	if err := o.repo.CreateOAuthAuthorizationCode(ctx, code, audit); err != nil {
		return "", err
	}
	return o.redirectURL(request, url.Values{"code": {rawCode}})
}

// Deny returns the client redirect reporting that the user refused access.
func (o *OAuthServer) Deny(ctx context.Context, userID string, query url.Values) (string, error) {
	if _, err := o.consentUser(ctx, userID); err != nil {
		return "", err
	}
	request, err := o.ParseAuthorizationRequest(ctx, query)
	if err != nil {
		return "", err
	}
	return o.ErrorRedirectURL(request, oauthError("access_denied", "the user denied access"))
}

func (o *OAuthServer) validateConsent(ctx context.Context, user *db.User, input OAuthConsentInput) (oauthConsentRecord, error) {
	if input.SystemAdmin {
		if !user.IsSystemAdmin {
			return oauthConsentRecord{}, ErrScopeDenied
		}
		return oauthConsentRecord{
			AuthorityType:  AuthoritySystemAdmin,
			TenantIDs:      []string{},
			Scopes:         []string{ScopeSystemAdmin},
			ResourceMode:   ResourceModeAll,
			ResourceGrants: []oauthConsentResource{},
		}, nil
	}

	tenantIDs := make([]string, 0, len(input.TenantIDs))
	for _, tenantID := range input.TenantIDs {
		if !slices.Contains(tenantIDs, tenantID) {
			tenantIDs = append(tenantIDs, tenantID)
		}
	}
	if len(tenantIDs) == 0 {
		return oauthConsentRecord{}, ErrTenantRequired
	}
	accessible, err := o.auth.AccessibleTenants(ctx, user)
	if err != nil {
		return oauthConsentRecord{}, err
	}
	for _, tenantID := range tenantIDs {
		if !slices.ContainsFunc(accessible, func(access TenantAccess) bool { return access.Tenant.ID == tenantID }) {
			return oauthConsentRecord{}, ErrTenantForbidden
		}
	}
	if err := ValidateScopes(AuthorityTenant, input.Scopes); err != nil {
		return oauthConsentRecord{}, err
	}
	scopes := slices.Clone(input.Scopes)
	slices.Sort(scopes)

	resourceMode := input.ResourceMode
	if resourceMode == "" {
		resourceMode = ResourceModeAll
	}
	resources := []oauthConsentResource{}
	switch resourceMode {
	case ResourceModeAll:
		if len(input.ResourceGrants) != 0 {
			return oauthConsentRecord{}, ErrInvalidResourceScope
		}
	case ResourceModeAllowlist:
		grants, err := o.auth.normalizeResourceGrants(ctx, tenantIDs, input.ResourceGrants)
		if err != nil {
			return oauthConsentRecord{}, err
		}
		for _, grant := range grants {
			resources = append(resources, oauthConsentResource(grant))
		}
	default:
		return oauthConsentRecord{}, ErrInvalidResourceScope
	}

	return oauthConsentRecord{
		AuthorityType:  AuthorityTenant,
		TenantIDs:      tenantIDs,
		Scopes:         scopes,
		ResourceMode:   resourceMode,
		ResourceGrants: resources,
	}, nil
}

// OAuthTokenRequest is a token endpoint request after client credentials were extracted.
type OAuthTokenRequest struct {
	GrantType    string
	ClientID     string
	ClientSecret string
	Code         string
	RedirectURI  string
	CodeVerifier string
	RefreshToken string
	Resource     string
}

// OAuthTokenResponse is a successful token endpoint response.
type OAuthTokenResponse struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	RefreshToken string `json:"refresh_token"`
	Scope        string `json:"scope"`
}

// Token handles the token endpoint.
func (o *OAuthServer) Token(ctx context.Context, request OAuthTokenRequest) (OAuthTokenResponse, error) {
	client, err := o.authenticateClient(ctx, request.ClientID, request.ClientSecret)
	if err != nil {
		return OAuthTokenResponse{}, err
	}
	switch request.GrantType {
	case OAuthGrantTypeAuthorizationCode:
		return o.exchangeCode(ctx, client, request)
	case OAuthGrantTypeRefreshToken:
		return o.refresh(ctx, client, request)
	default:
		return OAuthTokenResponse{}, oauthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token")
	}
}

func (o *OAuthServer) authenticateClient(ctx context.Context, clientID, clientSecret string) (*db.OAuthClient, error) {
	if clientID == "" {
		return nil, oauthError("invalid_client", "client authentication is required")
	}
	// Metadata document clients were fetched during authorization; the token
	// endpoint must not trigger outbound requests.
	client, err := o.repo.GetOAuthClient(ctx, clientID)
	if err != nil {
		return nil, err
	}
	if client == nil {
		return nil, oauthError("invalid_client", "unknown client")
	}
	if client.ClientSecretHash != nil {
		secretClientID, secret, ok := parseOAuthSecret(clientSecret, oauthClientSecretPrefix)
		if !ok || secretClientID != client.ID || !ConstantTimeEqual(*client.ClientSecretHash, hashOAuthSecret(secret)) {
			return nil, oauthError("invalid_client", "client authentication failed")
		}
	}
	return client, nil
}

func (o *OAuthServer) exchangeCode(ctx context.Context, client *db.OAuthClient, request OAuthTokenRequest) (OAuthTokenResponse, error) {
	codeID, secret, ok := parseOAuthSecret(request.Code, oauthCodePrefix)
	if !ok {
		return OAuthTokenResponse{}, oauthError("invalid_grant", "invalid authorization code")
	}
	code, err := o.repo.GetOAuthAuthorizationCode(ctx, codeID)
	if err != nil {
		return OAuthTokenResponse{}, err
	}
	if code == nil || !ConstantTimeEqual(code.CodeHash, hashOAuthSecret(secret)) || code.ClientID != client.ID {
		return OAuthTokenResponse{}, oauthError("invalid_grant", "invalid authorization code")
	}
	if code.ConsumedAt != nil {
		// RFC 6749 section 4.1.2: a replayed code revokes what it issued.
		if code.GrantID != nil {
			if err := o.revokeGrantByID(ctx, *code.GrantID, "authorization_code_reuse"); err != nil {
				return OAuthTokenResponse{}, err
			}
		}
		return OAuthTokenResponse{}, oauthError("invalid_grant", "authorization code already used")
	}
	now := o.auth.now().UTC()
	if IsExpired(&code.ExpiresAt, now) {
		return OAuthTokenResponse{}, oauthError("invalid_grant", "authorization code expired")
	}
	if request.RedirectURI != "" && request.RedirectURI != code.RedirectURI {
		return OAuthTokenResponse{}, oauthError("invalid_grant", "redirect_uri does not match the authorization request")
	}
	if !verifyPKCE(request.CodeVerifier, code.CodeChallenge) {
		return OAuthTokenResponse{}, oauthError("invalid_grant", "code_verifier does not match code_challenge")
	}
	if request.Resource != "" && !o.isOwnResource(request.Resource) {
		return OAuthTokenResponse{}, oauthError("invalid_target", "resource is not served by this authorization server")
	}

	var consent oauthConsentRecord
	if err := json.Unmarshal([]byte(code.ConsentJSON), &consent); err != nil {
		return OAuthTokenResponse{}, fmt.Errorf("decode oauth consent: %w", err)
	}
	scopesJSON, err := MarshalScopesJSON(consent.Scopes)
	if err != nil {
		return OAuthTokenResponse{}, err
	}
	grantID, err := ids.NewUUIDv7()
	if err != nil {
		return OAuthTokenResponse{}, err
	}
	grant := &db.OAuthGrant{
		ID:             grantID,
		ClientID:       client.ID,
		UserID:         code.UserID,
		AuthorityType:  consent.AuthorityType,
		ScopesJSON:     scopesJSON,
		ResourceMode:   consent.ResourceMode,
		CreatedAt:      now.Format(time.RFC3339Nano),
		TenantIDs:      consent.TenantIDs,
		ResourceGrants: make([]db.OAuthGrantResourceGrant, 0, len(consent.ResourceGrants)),
	}
	for _, resource := range consent.ResourceGrants {
		grant.ResourceGrants = append(grant.ResourceGrants, db.OAuthGrantResourceGrant{GrantID: grantID, ResourceType: resource.ResourceType, ResourceID: resource.ResourceID})
	}
	if _, err := o.auth.oauthGrantPrincipal(ctx, grant); err != nil {
		return OAuthTokenResponse{}, oauthGrantError(err)
	}

	response, tokens, err := o.issueTokens(grant, consent.Scopes, now)
	if err != nil {
		return OAuthTokenResponse{}, err
	}
	audit, err := o.auth.newAuditEvent(oauthUserActor(code.UserID), AuditInput{
		Action:       "oauth_grant.created",
		ResourceType: "oauth_grant",
		ResourceID:   &grant.ID,
		Data:         map[string]any{"clientId": client.ID, "authorityType": grant.AuthorityType, "tenantIds": grant.TenantIDs, "resourceMode": grant.ResourceMode},
	})
	if err != nil {
		return OAuthTokenResponse{}, err
	}
	if err := o.repo.ExchangeOAuthAuthorizationCode(ctx, code.ID, now.Format(time.RFC3339Nano), grant, tokens, audit); err != nil {
		if errors.Is(err, db.ErrOAuthCodeConsumed) {
			return OAuthTokenResponse{}, oauthError("invalid_grant", "authorization code already used")
		}
		return OAuthTokenResponse{}, err
	}
	return response, nil
}

func (o *OAuthServer) refresh(ctx context.Context, client *db.OAuthClient, request OAuthTokenRequest) (OAuthTokenResponse, error) {
	tokenID, secret, ok := parseOAuthSecret(request.RefreshToken, oauthRefreshTokenPrefix)
	if !ok {
		return OAuthTokenResponse{}, oauthError("invalid_grant", "invalid refresh token")
	}
	token, err := o.repo.GetOAuthToken(ctx, tokenID)
	if err != nil {
		return OAuthTokenResponse{}, err
	}
	if token == nil || token.Kind != oauthTokenKindRefresh || !ConstantTimeEqual(token.TokenHash, hashOAuthSecret(secret)) {
		return OAuthTokenResponse{}, oauthError("invalid_grant", "invalid refresh token")
	}
	grant, err := o.repo.GetOAuthGrant(ctx, token.GrantID)
	if err != nil {
		return OAuthTokenResponse{}, err
	}
	if grant == nil || grant.ClientID != client.ID || IsRevoked(grant.RevokedAt) {
		return OAuthTokenResponse{}, oauthError("invalid_grant", "invalid refresh token")
	}
	now := o.auth.now().UTC()
	if token.RevokedAt != nil {
		revokedAt, err := time.Parse(time.RFC3339Nano, *token.RevokedAt)
		if err != nil || now.Sub(revokedAt) > oauthRefreshReuseGrace {
			if err := o.auth.revokeOAuthGrant(ctx, oauthUserActor(grant.UserID), grant, "refresh_token_reuse"); err != nil {
				return OAuthTokenResponse{}, err
			}
		}
		return OAuthTokenResponse{}, oauthError("invalid_grant", "refresh token already used")
	}
	if IsExpired(&token.ExpiresAt, now) {
		return OAuthTokenResponse{}, oauthError("invalid_grant", "refresh token expired")
	}
	if _, err := o.auth.oauthGrantPrincipal(ctx, grant); err != nil {
		return OAuthTokenResponse{}, oauthGrantError(err)
	}
	scopes, err := ParseScopesJSON(grant.ScopesJSON)
	if err != nil {
		return OAuthTokenResponse{}, err
	}

	response, tokens, err := o.issueTokens(grant, scopes, now)
	if err != nil {
		return OAuthTokenResponse{}, err
	}
	if err := o.repo.RotateOAuthRefreshToken(ctx, token.ID, now.Format(time.RFC3339Nano), tokens); err != nil {
		if errors.Is(err, db.ErrOAuthTokenRevoked) {
			return OAuthTokenResponse{}, oauthError("invalid_grant", "refresh token already used")
		}
		return OAuthTokenResponse{}, err
	}
	return response, nil
}

// oauthGrantError maps a grant that no longer authorizes the user to invalid_grant.
func oauthGrantError(err error) error {
	if errors.Is(err, ErrOAuthGrantInvalid) || errors.Is(err, ErrUserDisabled) || errors.Is(err, ErrInvalidAuthority) {
		return oauthError("invalid_grant", "the user no longer has the granted access")
	}
	return err
}

func (o *OAuthServer) issueTokens(grant *db.OAuthGrant, scopes []string, now time.Time) (OAuthTokenResponse, []db.OAuthToken, error) {
	accessID, err := ids.NewUUIDv7()
	if err != nil {
		return OAuthTokenResponse{}, nil, err
	}
	refreshID, err := ids.NewUUIDv7()
	if err != nil {
		return OAuthTokenResponse{}, nil, err
	}
	accessToken, accessHash, err := generateOAuthSecret(oauthAccessTokenPrefix, accessID)
	if err != nil {
		return OAuthTokenResponse{}, nil, err
	}
	refreshToken, refreshHash, err := generateOAuthSecret(oauthRefreshTokenPrefix, refreshID)
	if err != nil {
		return OAuthTokenResponse{}, nil, err
	}
	createdAt := now.Format(time.RFC3339Nano)
	tokens := []db.OAuthToken{
		{ID: accessID, GrantID: grant.ID, Kind: oauthTokenKindAccess, TokenHash: accessHash, CreatedAt: createdAt, ExpiresAt: now.Add(OAuthAccessTokenTTL).Format(time.RFC3339Nano)},
		{ID: refreshID, GrantID: grant.ID, Kind: oauthTokenKindRefresh, TokenHash: refreshHash, CreatedAt: createdAt, ExpiresAt: now.Add(OAuthRefreshTokenTTL).Format(time.RFC3339Nano)},
	}
	return OAuthTokenResponse{
		AccessToken:  accessToken,
		TokenType:    "Bearer",
		ExpiresIn:    int(OAuthAccessTokenTTL / time.Second),
		RefreshToken: refreshToken,
		Scope:        strings.Join(scopes, " "),
	}, tokens, nil
}

// RevokeToken implements RFC 7009. Revoking either token of a grant revokes
// the whole grant; unknown tokens are ignored as the RFC requires.
func (o *OAuthServer) RevokeToken(ctx context.Context, clientID, clientSecret, rawToken string) error {
	client, err := o.authenticateClient(ctx, clientID, clientSecret)
	if err != nil {
		return err
	}
	var tokenID, secret string
	var ok bool
	if strings.HasPrefix(rawToken, oauthAccessTokenPrefix) {
		tokenID, secret, ok = parseOAuthSecret(rawToken, oauthAccessTokenPrefix)
	} else {
		tokenID, secret, ok = parseOAuthSecret(rawToken, oauthRefreshTokenPrefix)
	}
	if !ok {
		return nil
	}
	token, err := o.repo.GetOAuthToken(ctx, tokenID)
	if err != nil {
		return err
	}
	if token == nil || !ConstantTimeEqual(token.TokenHash, hashOAuthSecret(secret)) {
		return nil
	}
	grant, err := o.repo.GetOAuthGrant(ctx, token.GrantID)
	if err != nil {
		return err
	}
	if grant == nil || grant.ClientID != client.ID {
		return nil
	}
	return o.auth.revokeOAuthGrant(ctx, oauthUserActor(grant.UserID), grant, "client_revocation")
}

func (o *OAuthServer) revokeGrantByID(ctx context.Context, grantID, reason string) error {
	grant, err := o.repo.GetOAuthGrant(ctx, grantID)
	if err != nil {
		return err
	}
	if grant == nil {
		return nil
	}
	return o.auth.revokeOAuthGrant(ctx, oauthUserActor(grant.UserID), grant, reason)
}

func verifyPKCE(verifier, challenge string) bool {
	// RFC 7636 section 4.1.
	if len(verifier) < 43 || len(verifier) > 128 {
		return false
	}
	sum := sha256.Sum256([]byte(verifier))
	return ConstantTimeEqual(base64.RawURLEncoding.EncodeToString(sum[:]), challenge)
}

func validateRedirectURI(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || !parsed.IsAbs() {
		return fmt.Errorf("redirect uri %q must be an absolute URI", raw)
	}
	if parsed.Fragment != "" {
		return fmt.Errorf("redirect uri %q must not contain a fragment", raw)
	}
	switch strings.ToLower(parsed.Scheme) {
	case "javascript", "data", "vbscript", "file":
		return fmt.Errorf("redirect uri %q uses a forbidden scheme", raw)
	case "http", "https":
		if parsed.Host == "" {
			return fmt.Errorf("redirect uri %q must have a host", raw)
		}
	}
	return nil
}

// redirectURIMatches compares redirect URIs exactly, except that loopback
// redirects may use any port because native clients bind an ephemeral one
// (RFC 8252 section 7.3).
func redirectURIMatches(registered, requested string) bool {
	if registered == requested {
		return true
	}
	registeredURL, err := url.Parse(registered)
	if err != nil {
		return false
	}
	requestedURL, err := url.Parse(requested)
	if err != nil {
		return false
	}
	return registeredURL.Scheme == "http" &&
		requestedURL.Scheme == "http" &&
		isLoopbackHost(registeredURL.Hostname()) &&
		registeredURL.Hostname() == requestedURL.Hostname() &&
		registeredURL.Path == requestedURL.Path &&
		registeredURL.RawQuery == requestedURL.RawQuery &&
		requestedURL.User == nil
}

func isLoopbackHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func isWebURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && (parsed.Scheme == "https" || parsed.Scheme == "http") && parsed.Host != ""
}
