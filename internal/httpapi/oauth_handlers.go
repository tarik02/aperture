package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/db"
	"github.com/gin-gonic/gin"
)

const maxOAuthRequestBodySize = 64 << 10

func registerOAuthRoutes(router *gin.Engine, server *Server) {
	// Browser-based MCP clients call these directly and preflight them.
	public := []struct {
		method, path string
		handler      gin.HandlerFunc
	}{
		{http.MethodGet, "/.well-known/oauth-authorization-server", server.oauthAuthorizationServerMetadata},
		{http.MethodGet, "/.well-known/oauth-protected-resource", server.oauthProtectedResourceMetadata},
		{http.MethodGet, "/.well-known/oauth-protected-resource/mcp", server.oauthProtectedResourceMetadata},
		{http.MethodGet, "/.well-known/oauth-protected-resource/sessions/:sessionId/mcp", server.oauthProtectedResourceMetadata},
		{http.MethodPost, "/oauth/register", server.oauthRegister},
		{http.MethodPost, "/oauth/token", server.oauthToken},
		{http.MethodPost, "/oauth/revoke", server.oauthRevoke},
	}
	for _, route := range public {
		router.Handle(route.method, route.path, oauthCORS, route.handler)
		router.OPTIONS(route.path, oauthCORS)
	}

	router.GET("/oauth/authorize", server.oauthAuthorize)

	router.GET("/auth/oauth/authorization", server.getOAuthAuthorization)
	router.POST("/auth/oauth/authorization/approve", server.approveOAuthAuthorization)
	router.POST("/auth/oauth/authorization/deny", server.denyOAuthAuthorization)
	router.GET("/auth/oauth/grants", server.listOAuthGrants)
	router.DELETE("/auth/oauth/grants/:grantId", server.revokeOAuthGrant)
}

// oauthEnabled reports whether MCP clients can obtain tokens through OAuth.
// Consent needs a signed-in user, so it requires browser sessions.
func (s *Server) oauthEnabled() bool {
	return s.OAuth != nil && s.WebAuth != nil && s.Config.MCPEnabled
}

// oauthCORS opens the endpoints browser-based MCP clients call directly. They
// carry no cookies, so any origin may use them.
func oauthCORS(c *gin.Context) {
	c.Header("Access-Control-Allow-Origin", "*")
	c.Header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version")
	if c.Request.Method == http.MethodOptions {
		c.AbortWithStatus(http.StatusNoContent)
	}
}

// mcpResourceMetadataURL is advertised in WWW-Authenticate so clients can
// discover the authorization server (RFC 9728 section 5.1).
func (s *Server) mcpResourceMetadataURL(r *http.Request) string {
	return s.OAuth.Issuer() + "/.well-known/oauth-protected-resource" + r.URL.Path
}

func (s *Server) oauthAuthorizationServerMetadata(c *gin.Context) {
	c.JSON(http.StatusOK, s.OAuth.AuthorizationServerMetadata())
}

func (s *Server) oauthProtectedResourceMetadata(c *gin.Context) {
	resourcePath := strings.TrimPrefix(c.Request.URL.Path, "/.well-known/oauth-protected-resource")
	if resourcePath == "" {
		resourcePath = "/mcp"
	}
	c.JSON(http.StatusOK, s.OAuth.ProtectedResourceMetadata(s.OAuth.Issuer()+resourcePath))
}

type oauthErrorBody struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description,omitempty"`
}

// writeOAuthError writes an RFC 6749 section 5.2 error response.
func writeOAuthError(c *gin.Context, err error) {
	var oauthErr *auth.OAuthError
	if !errors.As(err, &oauthErr) {
		WriteInternalError(c, err)
		return
	}
	status := http.StatusBadRequest
	if oauthErr.Code == "invalid_client" {
		status = http.StatusUnauthorized
		if strings.HasPrefix(c.GetHeader("Authorization"), "Basic ") {
			c.Header("WWW-Authenticate", `Basic realm="aperture"`)
		}
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(status, oauthErrorBody{Error: oauthErr.Code, ErrorDescription: oauthErr.Description})
}

func (s *Server) oauthAuthorize(c *gin.Context) {
	request, err := s.OAuth.ParseAuthorizationRequest(c.Request.Context(), c.Request.URL.Query())
	if err != nil {
		var oauthErr *auth.OAuthError
		if !errors.As(err, &oauthErr) {
			WriteInternalError(c, err)
			return
		}
		if request == nil {
			// Without a trusted redirect URI the error can only be shown here.
			c.String(http.StatusBadRequest, "Authorization request rejected: %s", oauthErr.Description)
			return
		}
		redirectURL, err := s.OAuth.ErrorRedirectURL(request, oauthErr)
		if err != nil {
			WriteInternalError(c, err)
			return
		}
		c.Redirect(http.StatusFound, redirectURL)
		return
	}
	c.Redirect(http.StatusFound, "/oauth/consent?"+c.Request.URL.RawQuery)
}

func (s *Server) oauthRegister(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxOAuthRequestBodySize)
	var metadata auth.OAuthClientMetadata
	if err := json.NewDecoder(c.Request.Body).Decode(&metadata); err != nil {
		writeOAuthError(c, &auth.OAuthError{Code: "invalid_client_metadata", Description: "request body must be a JSON client metadata object"})
		return
	}
	registration, err := s.OAuth.RegisterClient(c.Request.Context(), metadata)
	if err != nil {
		writeOAuthError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, registration)
}

func (s *Server) oauthToken(c *gin.Context) {
	clientID, clientSecret, ok := parseOAuthForm(c)
	if !ok {
		return
	}
	form := c.Request.PostForm
	response, err := s.OAuth.Token(c.Request.Context(), auth.OAuthTokenRequest{
		GrantType:    form.Get("grant_type"),
		ClientID:     clientID,
		ClientSecret: clientSecret,
		Code:         form.Get("code"),
		RedirectURI:  form.Get("redirect_uri"),
		CodeVerifier: form.Get("code_verifier"),
		RefreshToken: form.Get("refresh_token"),
		Resource:     form.Get("resource"),
	})
	if err != nil {
		writeOAuthError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("Pragma", "no-cache")
	c.JSON(http.StatusOK, response)
}

func (s *Server) oauthRevoke(c *gin.Context) {
	clientID, clientSecret, ok := parseOAuthForm(c)
	if !ok {
		return
	}
	if err := s.OAuth.RevokeToken(c.Request.Context(), clientID, clientSecret, c.Request.PostForm.Get("token")); err != nil {
		writeOAuthError(c, err)
		return
	}
	c.Status(http.StatusOK)
}

// parseOAuthForm parses a form-encoded token or revocation request and returns
// its client credentials, writing the error response when it fails.
func parseOAuthForm(c *gin.Context) (string, string, bool) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxOAuthRequestBodySize)
	if err := c.Request.ParseForm(); err != nil {
		writeOAuthError(c, &auth.OAuthError{Code: "invalid_request", Description: "request body must be form encoded"})
		return "", "", false
	}
	clientID, clientSecret, err := oauthClientCredentials(c.Request)
	if err != nil {
		writeOAuthError(c, err)
		return "", "", false
	}
	return clientID, clientSecret, true
}

// oauthClientCredentials reads client_secret_basic or client_secret_post
// credentials, or a bare client_id for public clients.
func oauthClientCredentials(r *http.Request) (string, string, error) {
	header := r.Header.Get("Authorization")
	encoded, ok := strings.CutPrefix(header, "Basic ")
	if !ok {
		return r.PostForm.Get("client_id"), r.PostForm.Get("client_secret"), nil
	}
	invalid := &auth.OAuthError{Code: "invalid_client", Description: "malformed basic authorization"}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return "", "", invalid
	}
	rawID, rawSecret, ok := strings.Cut(string(decoded), ":")
	if !ok {
		return "", "", invalid
	}
	// RFC 6749 section 2.3.1 form-encodes both parts before joining them.
	clientID, err := url.QueryUnescape(rawID)
	if err != nil {
		return "", "", invalid
	}
	clientSecret, err := url.QueryUnescape(rawSecret)
	if err != nil {
		return "", "", invalid
	}
	return clientID, clientSecret, nil
}

type oauthClientResponse struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	URI     *string `json:"uri"`
	LogoURI *string `json:"logoUri"`
	Kind    string  `json:"kind"`
}

type oauthConsentUserResponse struct {
	ID            string `json:"id"`
	DisplayName   string `json:"displayName"`
	IsSystemAdmin bool   `json:"isSystemAdmin"`
}

type oauthConsentTenantResponse struct {
	ID          string   `json:"id"`
	DisplayName string   `json:"displayName"`
	Scopes      []string `json:"scopes"`
}

type oauthAuthorizationResponse struct {
	Client              oauthClientResponse          `json:"client"`
	RedirectURI         string                       `json:"redirectUri"`
	RequestedScopes     []string                     `json:"requestedScopes"`
	User                oauthConsentUserResponse     `json:"user"`
	Tenants             []oauthConsentTenantResponse `json:"tenants"`
	AvailableScopes     []string                     `json:"availableScopes"`
	CanGrantSystemAdmin bool                         `json:"canGrantSystemAdmin"`
}

// oauthDecisionRequest is the consent page's answer; deny uses only Query.
type oauthDecisionRequest struct {
	Query          string               `json:"query"`
	SystemAdmin    bool                 `json:"systemAdmin"`
	TenantIDs      []string             `json:"tenantIds"`
	Scopes         []string             `json:"scopes"`
	ResourceMode   string               `json:"resourceMode"`
	ResourceGrants []auth.ResourceGrant `json:"resourceGrants"`
}

func (r oauthDecisionRequest) Validate() error {
	if r.Query == "" {
		return validationError("query is required")
	}
	return nil
}

func bindOAuthDecision(c *gin.Context) (oauthDecisionRequest, url.Values, bool) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxOpenAPIRequestBodySize)
	var request oauthDecisionRequest
	if err := bindJSON(c, &request); err != nil {
		WriteError(c, err)
		return request, nil, false
	}
	query, err := url.ParseQuery(request.Query)
	if err != nil {
		WriteError(c, validationError("query is not a valid query string"))
		return request, nil, false
	}
	return request, query, true
}

type oauthRedirectResponse struct {
	RedirectURL string `json:"redirectUrl"`
}

// writeOAuthConsentError reports an invalid authorization request to the
// consent page, which shows it instead of redirecting.
func writeOAuthConsentError(c *gin.Context, err error) {
	var oauthErr *auth.OAuthError
	if errors.As(err, &oauthErr) {
		c.JSON(http.StatusBadRequest, errorBody{Error: apiErrorDetail{Code: "invalid_request", Message: oauthErr.Description}})
		return
	}
	WriteError(c, err)
}

func (s *Server) getOAuthAuthorization(c *gin.Context) {
	consent, err := s.OAuth.DescribeConsent(c.Request.Context(), s.WebAuth.AuthenticatedUserID(c.Request.Context()), c.Request.URL.Query())
	if err != nil {
		writeOAuthConsentError(c, err)
		return
	}
	response := oauthAuthorizationResponse{
		Client:              toOAuthClientResponse(consent.Request.Client),
		RedirectURI:         consent.Request.RedirectURI,
		RequestedScopes:     consent.Request.RequestedScopes,
		User:                oauthConsentUserResponse{ID: consent.User.ID, DisplayName: consent.User.DisplayName, IsSystemAdmin: consent.User.IsSystemAdmin},
		Tenants:             make([]oauthConsentTenantResponse, 0, len(consent.Tenants)),
		AvailableScopes:     auth.TenantScopes(),
		CanGrantSystemAdmin: consent.User.IsSystemAdmin,
	}
	if response.RequestedScopes == nil {
		response.RequestedScopes = []string{}
	}
	for _, access := range consent.Tenants {
		response.Tenants = append(response.Tenants, oauthConsentTenantResponse{ID: access.Tenant.ID, DisplayName: access.Tenant.DisplayName, Scopes: access.Scopes})
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, response)
}

func (s *Server) approveOAuthAuthorization(c *gin.Context) {
	request, query, ok := bindOAuthDecision(c)
	if !ok {
		return
	}
	redirectURL, err := s.OAuth.Approve(c.Request.Context(), s.WebAuth.AuthenticatedUserID(c.Request.Context()), query, auth.OAuthConsentInput{
		SystemAdmin:    request.SystemAdmin,
		TenantIDs:      request.TenantIDs,
		Scopes:         request.Scopes,
		ResourceMode:   request.ResourceMode,
		ResourceGrants: request.ResourceGrants,
	})
	if err != nil {
		writeOAuthConsentError(c, err)
		return
	}
	c.JSON(http.StatusOK, oauthRedirectResponse{RedirectURL: redirectURL})
}

func (s *Server) denyOAuthAuthorization(c *gin.Context) {
	_, query, ok := bindOAuthDecision(c)
	if !ok {
		return
	}
	redirectURL, err := s.OAuth.Deny(c.Request.Context(), s.WebAuth.AuthenticatedUserID(c.Request.Context()), query)
	if err != nil {
		writeOAuthConsentError(c, err)
		return
	}
	c.JSON(http.StatusOK, oauthRedirectResponse{RedirectURL: redirectURL})
}

type oauthGrantTenantResponse struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}

type oauthGrantResponse struct {
	ID             string                     `json:"id"`
	Client         oauthClientResponse        `json:"client"`
	AuthorityType  string                     `json:"authorityType"`
	Tenants        []oauthGrantTenantResponse `json:"tenants"`
	Scopes         []string                   `json:"scopes"`
	ResourceMode   string                     `json:"resourceMode"`
	ResourceGrants []auth.ResourceGrant       `json:"resourceGrants"`
	CreatedAt      string                     `json:"createdAt"`
	LastUsedAt     *string                    `json:"lastUsedAt"`
}

type oauthGrantsResponse struct {
	Grants []oauthGrantResponse `json:"grants"`
}

func (s *Server) listOAuthGrants(c *gin.Context) {
	userID := s.WebAuth.AuthenticatedUserID(c.Request.Context())
	if userID == "" {
		WriteError(c, auth.ErrTokenMissing)
		return
	}
	grants, err := s.Auth.ListUserOAuthGrants(c.Request.Context(), userID)
	if err != nil {
		WriteError(c, err)
		return
	}
	response := oauthGrantsResponse{Grants: make([]oauthGrantResponse, 0, len(grants))}
	for _, item := range grants {
		grant := oauthGrantResponse{
			ID:             item.Grant.ID,
			Client:         toOAuthClientResponse(item.Client),
			AuthorityType:  item.Grant.AuthorityType,
			Tenants:        make([]oauthGrantTenantResponse, 0, len(item.Grant.TenantIDs)),
			Scopes:         item.Scopes,
			ResourceMode:   item.Grant.ResourceMode,
			ResourceGrants: make([]auth.ResourceGrant, 0, len(item.Grant.ResourceGrants)),
			CreatedAt:      item.Grant.CreatedAt,
			LastUsedAt:     item.Grant.LastUsedAt,
		}
		for _, tenantID := range item.Grant.TenantIDs {
			displayName := tenantID
			if tenant, err := s.Auth.GetTenant(c.Request.Context(), tenantID); err == nil {
				displayName = tenant.DisplayName
			} else if !errors.Is(err, auth.ErrTenantNotFound) {
				WriteError(c, err)
				return
			}
			grant.Tenants = append(grant.Tenants, oauthGrantTenantResponse{ID: tenantID, DisplayName: displayName})
		}
		for _, resource := range item.Grant.ResourceGrants {
			grant.ResourceGrants = append(grant.ResourceGrants, auth.ResourceGrant{ResourceType: resource.ResourceType, ResourceID: resource.ResourceID})
		}
		response.Grants = append(response.Grants, grant)
	}
	c.JSON(http.StatusOK, response)
}

func (s *Server) revokeOAuthGrant(c *gin.Context) {
	userID := s.WebAuth.AuthenticatedUserID(c.Request.Context())
	if userID == "" {
		WriteError(c, auth.ErrTokenMissing)
		return
	}
	if err := s.Auth.RevokeUserOAuthGrant(c.Request.Context(), userID, c.Param("grantId")); err != nil {
		WriteError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func toOAuthClientResponse(client db.OAuthClient) oauthClientResponse {
	return oauthClientResponse{ID: client.ID, Name: client.ClientName, URI: client.ClientURI, LogoURI: client.LogoURI, Kind: client.Kind}
}

// oauthBearerChallenge is sent with 401 responses from the MCP endpoint.
func (s *Server) oauthBearerChallenge(r *http.Request) string {
	return `Bearer resource_metadata="` + s.mcpResourceMetadataURL(r) + `"`
}
