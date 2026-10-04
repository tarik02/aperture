package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/aperture/aperture/internal/auth"
	"github.com/gin-gonic/gin"
)

const maxOAuthRequestBodySize = 64 << 10

func registerOAuthRoutes(router *gin.Engine, server *Server) {
	router.GET("/.well-known/oauth-authorization-server", server.oauthCORS, server.oauthAuthorizationServerMetadata)
	router.GET("/.well-known/oauth-protected-resource", server.oauthCORS, server.oauthProtectedResourceMetadata)
	router.GET("/.well-known/oauth-protected-resource/mcp", server.oauthCORS, server.oauthProtectedResourceMetadata)
	router.GET("/.well-known/oauth-protected-resource/sessions/:sessionId/mcp", server.oauthCORS, server.oauthProtectedResourceMetadata)
	router.OPTIONS("/.well-known/oauth-authorization-server", server.oauthCORS)
	router.OPTIONS("/.well-known/oauth-protected-resource", server.oauthCORS)
	router.OPTIONS("/.well-known/oauth-protected-resource/mcp", server.oauthCORS)
	router.OPTIONS("/.well-known/oauth-protected-resource/sessions/:sessionId/mcp", server.oauthCORS)

	router.GET("/oauth/authorize", server.oauthAuthorize)
	router.POST("/oauth/register", server.oauthCORS, server.oauthRegister)
	router.POST("/oauth/token", server.oauthCORS, server.oauthToken)
	router.POST("/oauth/revoke", server.oauthCORS, server.oauthRevoke)
	router.OPTIONS("/oauth/register", server.oauthCORS)
	router.OPTIONS("/oauth/token", server.oauthCORS)
	router.OPTIONS("/oauth/revoke", server.oauthCORS)

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
func (s *Server) oauthCORS(c *gin.Context) {
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

type oauthRegistrationResponse struct {
	auth.OAuthClientMetadata
	ClientID              string `json:"client_id"`
	ClientSecret          string `json:"client_secret,omitempty"`
	ClientIDIssuedAt      int64  `json:"client_id_issued_at"`
	ClientSecretExpiresAt *int64 `json:"client_secret_expires_at,omitempty"`
}

func (s *Server) oauthRegister(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxOAuthRequestBodySize)
	var metadata auth.OAuthClientMetadata
	if err := json.NewDecoder(c.Request.Body).Decode(&metadata); err != nil {
		writeOAuthError(c, &auth.OAuthError{Code: "invalid_client_metadata", Description: "request body must be a JSON client metadata object"})
		return
	}
	registered, err := s.OAuth.RegisterClient(c.Request.Context(), metadata)
	if err != nil {
		writeOAuthError(c, err)
		return
	}
	response := oauthRegistrationResponse{
		OAuthClientMetadata: registered.Metadata,
		ClientID:            registered.ClientID,
		ClientSecret:        registered.ClientSecret,
		ClientIDIssuedAt:    registered.IssuedAt.Unix(),
	}
	if registered.ClientSecret != "" {
		// RFC 7591 section 3.2.1: zero means the secret never expires.
		response.ClientSecretExpiresAt = new(int64(0))
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, response)
}

func (s *Server) oauthToken(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxOAuthRequestBodySize)
	if err := c.Request.ParseForm(); err != nil {
		writeOAuthError(c, &auth.OAuthError{Code: "invalid_request", Description: "request body must be form encoded"})
		return
	}
	clientID, clientSecret, err := oauthClientCredentials(c.Request)
	if err != nil {
		writeOAuthError(c, err)
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
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxOAuthRequestBodySize)
	if err := c.Request.ParseForm(); err != nil {
		writeOAuthError(c, &auth.OAuthError{Code: "invalid_request", Description: "request body must be form encoded"})
		return
	}
	clientID, clientSecret, err := oauthClientCredentials(c.Request)
	if err != nil {
		writeOAuthError(c, err)
		return
	}
	if err := s.OAuth.RevokeToken(c.Request.Context(), clientID, clientSecret, c.Request.PostForm.Get("token")); err != nil {
		writeOAuthError(c, err)
		return
	}
	c.Status(http.StatusOK)
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

type oauthResourceGrantRequest struct {
	ResourceType string `json:"resourceType"`
	ResourceID   string `json:"resourceId"`
}

type oauthApproveRequest struct {
	Query          string                      `json:"query"`
	SystemAdmin    bool                        `json:"systemAdmin"`
	TenantIDs      []string                    `json:"tenantIds"`
	Scopes         []string                    `json:"scopes"`
	ResourceMode   string                      `json:"resourceMode"`
	ResourceGrants []oauthResourceGrantRequest `json:"resourceGrants"`
}

func (r oauthApproveRequest) Validate() error {
	if r.Query == "" {
		return validationError("query is required")
	}
	return nil
}

type oauthDenyRequest struct {
	Query string `json:"query"`
}

func (r oauthDenyRequest) Validate() error {
	if r.Query == "" {
		return validationError("query is required")
	}
	return nil
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
		Client:              toOAuthClientResponse(consent.Request.Client.ID, consent.Request.Client.ClientName, consent.Request.Client.ClientURI, consent.Request.Client.LogoURI, consent.Request.Client.Kind),
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
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxOpenAPIRequestBodySize)
	var request oauthApproveRequest
	if err := bindJSON(c, &request); err != nil {
		WriteError(c, err)
		return
	}
	query, err := url.ParseQuery(request.Query)
	if err != nil {
		WriteError(c, validationError("query is not a valid query string"))
		return
	}
	grants := make([]auth.ResourceGrant, 0, len(request.ResourceGrants))
	for _, grant := range request.ResourceGrants {
		grants = append(grants, auth.ResourceGrant{ResourceType: grant.ResourceType, ResourceID: grant.ResourceID})
	}
	redirectURL, err := s.OAuth.Approve(c.Request.Context(), s.WebAuth.AuthenticatedUserID(c.Request.Context()), query, auth.OAuthConsentInput{
		SystemAdmin:    request.SystemAdmin,
		TenantIDs:      request.TenantIDs,
		Scopes:         request.Scopes,
		ResourceMode:   request.ResourceMode,
		ResourceGrants: grants,
	})
	if err != nil {
		writeOAuthConsentError(c, err)
		return
	}
	c.JSON(http.StatusOK, oauthRedirectResponse{RedirectURL: redirectURL})
}

func (s *Server) denyOAuthAuthorization(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxOpenAPIRequestBodySize)
	var request oauthDenyRequest
	if err := bindJSON(c, &request); err != nil {
		WriteError(c, err)
		return
	}
	query, err := url.ParseQuery(request.Query)
	if err != nil {
		WriteError(c, validationError("query is not a valid query string"))
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
	ID             string                      `json:"id"`
	Client         oauthClientResponse         `json:"client"`
	AuthorityType  string                      `json:"authorityType"`
	Tenants        []oauthGrantTenantResponse  `json:"tenants"`
	Scopes         []string                    `json:"scopes"`
	ResourceMode   string                      `json:"resourceMode"`
	ResourceGrants []oauthResourceGrantRequest `json:"resourceGrants"`
	CreatedAt      string                      `json:"createdAt"`
	LastUsedAt     *string                     `json:"lastUsedAt"`
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
			Client:         toOAuthClientResponse(item.Client.ID, item.Client.ClientName, item.Client.ClientURI, item.Client.LogoURI, item.Client.Kind),
			AuthorityType:  item.Grant.AuthorityType,
			Tenants:        make([]oauthGrantTenantResponse, 0, len(item.Grant.TenantIDs)),
			Scopes:         item.Scopes,
			ResourceMode:   item.Grant.ResourceMode,
			ResourceGrants: make([]oauthResourceGrantRequest, 0, len(item.Grant.ResourceGrants)),
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
			grant.ResourceGrants = append(grant.ResourceGrants, oauthResourceGrantRequest{ResourceType: resource.ResourceType, ResourceID: resource.ResourceID})
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
	principal, err := s.WebAuth.Authenticate(c.Request.Context(), "")
	if err != nil {
		WriteError(c, err)
		return
	}
	if err := s.Auth.RevokeUserOAuthGrant(c.Request.Context(), principal, c.Param("grantId")); err != nil {
		WriteError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func toOAuthClientResponse(id, name string, uri, logoURI *string, kind string) oauthClientResponse {
	return oauthClientResponse{ID: id, Name: name, URI: uri, LogoURI: logoURI, Kind: kind}
}

// oauthBearerChallenge is sent with 401 responses from the MCP endpoint.
func (s *Server) oauthBearerChallenge(r *http.Request) string {
	return `Bearer resource_metadata="` + s.mcpResourceMetadataURL(r) + `"`
}
