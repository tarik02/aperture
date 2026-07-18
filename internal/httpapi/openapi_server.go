package httpapi

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/aperture/aperture/internal/auth"
	generated "github.com/aperture/aperture/internal/httpapi/openapi"
	"github.com/gin-gonic/gin"
)

const (
	openAPIRequestBodyKey     = "openapiRequestBody"
	maxOpenAPIRequestBodySize = 1 << 20
)

var errOpenAPIContext = errors.New("openapi handler context is not gin context")

type openAPIServer struct {
	server *Server
}

type openAPIPassthroughResponse struct{}

func registerOpenAPIRoutes(router *gin.Engine, server *Server) {
	routes := router.Group("")
	routes.Use(server.authorizeOpenAPIRoute, captureOpenAPIRequestBody)

	handler := generated.NewStrictHandlerWithOptions(
		openAPIServer{server: server},
		[]generated.StrictMiddlewareFunc{restoreOpenAPIRequestBody},
		generated.StrictGinServerOptions{
			RequestErrorHandlerFunc: func(c *gin.Context, _ error) {
				WriteError(c, errRequestDecode)
			},
			HandlerErrorFunc: func(c *gin.Context, err error) {
				WriteError(c, err)
			},
			ResponseErrorHandlerFunc: func(c *gin.Context, err error) {
				WriteInternalError(c, err)
			},
		},
	)
	generated.RegisterHandlersWithOptions(routes, handler, generated.GinServerOptions{
		ErrorHandler: func(c *gin.Context, err error, _ int) {
			WriteError(c, validationError(err.Error()))
		},
	})
}

func (s *Server) authorizeOpenAPIRoute(c *gin.Context) {
	if c.Request.Method == http.MethodGet && c.FullPath() == "/api/health" {
		c.Next()
		return
	}

	principal, err := s.authenticate(c)
	if err != nil {
		WriteError(c, err)
		c.Abort()
		return
	}
	c.Set("principal", principal)

	path := c.FullPath()
	switch {
	case path == "/api/auth/me":
	case path == "/api/browser/channels":
		if !s.requireScope(c, auth.ScopeSessionsRead) {
			return
		}
	case strings.HasPrefix(path, "/api/admin/"):
		if principal.AuthorityType != auth.AuthoritySystemAdmin || !auth.HasScope(principal.Scopes, auth.ScopeSystemAdmin) || auth.IsResourceRestricted(principal) {
			WriteError(c, auth.ErrScopeDenied)
			c.Abort()
			return
		}
	case path == "/api/tenant" || strings.HasPrefix(path, "/api/tenant/"):
		if principal.AuthorityType != auth.AuthorityTenant || !auth.HasScope(principal.Scopes, auth.ScopeTenantWrite) {
			WriteError(c, auth.ErrScopeDenied)
			c.Abort()
			return
		}
		if principal.TenantID == nil {
			WriteError(c, auth.ErrTenantNotFound)
			c.Abort()
			return
		}
		if path == "/api/tenant" && c.Request.Method != http.MethodGet && auth.IsResourceRestricted(principal) {
			WriteError(c, auth.ErrResourceAccessDenied)
			c.Abort()
			return
		}
	case path == "/api/sessions" && c.Request.Method == http.MethodGet,
		path == "/api/sessions/bulk",
		path == "/api/sessions/:sessionId" && c.Request.Method == http.MethodGet,
		path == "/api/events":
		if !s.requireSessionScope(c, auth.ScopeSessionsRead) {
			return
		}
	case path == "/api/sessions/:sessionId/promote":
		if !auth.HasScope(principal.Scopes, auth.ScopeSessionsWrite) || !auth.HasScope(principal.Scopes, auth.ScopeSnapshotsWrite) {
			WriteError(c, auth.ErrScopeDenied)
			c.Abort()
			return
		}
		tenantID, err := auth.ResolveTenantID(principal, selectedTenantID(c))
		if err != nil {
			WriteError(c, err)
			c.Abort()
			return
		}
		c.Set("tenantId", tenantID)
		if !auth.HasResourceAccess(principal, auth.ResourceTypeSession, c.Param("sessionId")) {
			WriteError(c, auth.ErrResourceAccessDenied)
			c.Abort()
			return
		}
	case strings.HasPrefix(path, "/api/sessions"):
		if !s.requireSessionScope(c, auth.ScopeSessionsWrite) {
			return
		}
	case path == "/api/snapshots" && c.Request.Method == http.MethodGet:
		if !s.requireSnapshotScope(c, auth.ScopeSnapshotsRead) {
			return
		}
	case strings.HasPrefix(path, "/api/snapshots"):
		if !s.requireSnapshotScope(c, auth.ScopeSnapshotsWrite) {
			return
		}
	}

	c.Next()
}

func captureOpenAPIRequestBody(c *gin.Context) {
	path := c.FullPath()
	hasBody := c.Request.Method == http.MethodPost && (path == "/api/admin/tenants" ||
		path == "/api/admin/users" ||
		path == "/api/admin/tokens" ||
		path == "/api/tenant/tokens" ||
		path == "/api/sessions" ||
		path == "/api/sessions/bulk" ||
		path == "/api/sessions/:sessionId/promote") ||
		c.Request.Method == http.MethodPatch && (path == "/api/admin/tenants/:tenantId" ||
			path == "/api/admin/users/:userId" ||
			path == "/api/tenant" ||
			path == "/api/snapshots/:name") ||
		c.Request.Method == http.MethodPut && (path == "/api/admin/tenants/:tenantId/memberships/:userId" ||
			path == "/api/sessions/:sessionId/tags" ||
			path == "/api/snapshots/:name/tags")
	if !hasBody {
		c.Next()
		return
	}

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxOpenAPIRequestBodySize)
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		WriteError(c, errRequestDecode)
		c.Abort()
		return
	}
	c.Set(openAPIRequestBodyKey, body)
	c.Request.Body = io.NopCloser(bytes.NewReader(body))
	c.Next()
}

func restoreOpenAPIRequestBody(next generated.StrictHandlerFunc, _ string) generated.StrictHandlerFunc {
	return func(c *gin.Context, request any) (any, error) {
		if body, ok := c.Get(openAPIRequestBodyKey); ok {
			c.Request.Body = io.NopCloser(bytes.NewReader(body.([]byte)))
		}
		return next(c, request)
	}
}

func (s openAPIServer) ListUsers(ctx context.Context, _ generated.ListUsersRequestObject) (generated.ListUsersResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.listUsers(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) CreateUser(ctx context.Context, _ generated.CreateUserRequestObject) (generated.CreateUserResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.createUser(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) GetUser(ctx context.Context, _ generated.GetUserRequestObject) (generated.GetUserResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.getUser(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) UpdateUser(ctx context.Context, _ generated.UpdateUserRequestObject) (generated.UpdateUserResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.updateUser(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) DisableUser(ctx context.Context, _ generated.DisableUserRequestObject) (generated.DisableUserResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.disableUser(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) RestoreUser(ctx context.Context, _ generated.RestoreUserRequestObject) (generated.RestoreUserResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.restoreUser(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) ListUserMemberships(ctx context.Context, _ generated.ListUserMembershipsRequestObject) (generated.ListUserMembershipsResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.listUserMemberships(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) ListTenantMemberships(ctx context.Context, _ generated.ListTenantMembershipsRequestObject) (generated.ListTenantMembershipsResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.listTenantMemberships(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) UpsertTenantMembership(ctx context.Context, _ generated.UpsertTenantMembershipRequestObject) (generated.UpsertTenantMembershipResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.upsertTenantMembership(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) DeleteTenantMembership(ctx context.Context, _ generated.DeleteTenantMembershipRequestObject) (generated.DeleteTenantMembershipResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.deleteTenantMembership(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) ListAuditEvents(ctx context.Context, _ generated.ListAuditEventsRequestObject) (generated.ListAuditEventsResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.listAuditEvents(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) ListTenants(ctx context.Context, _ generated.ListTenantsRequestObject) (generated.ListTenantsResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.listTenants(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) CreateTenant(ctx context.Context, _ generated.CreateTenantRequestObject) (generated.CreateTenantResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.createTenant(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) DeleteTenant(ctx context.Context, _ generated.DeleteTenantRequestObject) (generated.DeleteTenantResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.deleteTenant(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) UpdateTenant(ctx context.Context, _ generated.UpdateTenantRequestObject) (generated.UpdateTenantResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.updateTenant(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) RestoreTenant(ctx context.Context, _ generated.RestoreTenantRequestObject) (generated.RestoreTenantResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.restoreTenant(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) ListAdminTokens(ctx context.Context, _ generated.ListAdminTokensRequestObject) (generated.ListAdminTokensResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.listAdminTokens(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) CreateAdminToken(ctx context.Context, _ generated.CreateAdminTokenRequestObject) (generated.CreateAdminTokenResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.createAdminToken(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) RevokeAdminToken(ctx context.Context, _ generated.RevokeAdminTokenRequestObject) (generated.RevokeAdminTokenResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.revokeAdminToken(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) GetCurrentPrincipal(ctx context.Context, _ generated.GetCurrentPrincipalRequestObject) (generated.GetCurrentPrincipalResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.authMe(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) ListBrowserChannels(ctx context.Context, _ generated.ListBrowserChannelsRequestObject) (generated.ListBrowserChannelsResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.listBrowserChannels(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) ListEvents(ctx context.Context, _ generated.ListEventsRequestObject) (generated.ListEventsResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.listEvents(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) GetHealth(ctx context.Context, _ generated.GetHealthRequestObject) (generated.GetHealthResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.health(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) ListSessions(ctx context.Context, _ generated.ListSessionsRequestObject) (generated.ListSessionsResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.listSessions(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) CreateSession(ctx context.Context, _ generated.CreateSessionRequestObject) (generated.CreateSessionResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.createSession(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) GetSessionsBulk(ctx context.Context, _ generated.GetSessionsBulkRequestObject) (generated.GetSessionsBulkResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.getSessionsBulk(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) DeleteSession(ctx context.Context, _ generated.DeleteSessionRequestObject) (generated.DeleteSessionResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.deleteSession(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) GetSession(ctx context.Context, _ generated.GetSessionRequestObject) (generated.GetSessionResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.getSession(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) RotateSessionToken(ctx context.Context, _ generated.RotateSessionTokenRequestObject) (generated.RotateSessionTokenResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.rotateSessionToken(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) PromoteSession(ctx context.Context, _ generated.PromoteSessionRequestObject) (generated.PromoteSessionResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.promoteSession(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) ReopenSession(ctx context.Context, _ generated.ReopenSessionRequestObject) (generated.ReopenSessionResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.reopenSession(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) SuspendSession(ctx context.Context, _ generated.SuspendSessionRequestObject) (generated.SuspendSessionResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.suspendSession(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) ReplaceSessionTags(ctx context.Context, _ generated.ReplaceSessionTagsRequestObject) (generated.ReplaceSessionTagsResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.replaceSessionTags(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) ListSnapshots(ctx context.Context, _ generated.ListSnapshotsRequestObject) (generated.ListSnapshotsResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.listSnapshots(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) DeleteSnapshot(ctx context.Context, _ generated.DeleteSnapshotRequestObject) (generated.DeleteSnapshotResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.deleteSnapshot(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) UpdateSnapshot(ctx context.Context, _ generated.UpdateSnapshotRequestObject) (generated.UpdateSnapshotResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.updateSnapshot(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) RestoreSnapshot(ctx context.Context, _ generated.RestoreSnapshotRequestObject) (generated.RestoreSnapshotResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.restoreSnapshot(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) ReplaceSnapshotTags(ctx context.Context, _ generated.ReplaceSnapshotTagsRequestObject) (generated.ReplaceSnapshotTagsResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.replaceSnapshotTags(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) GetTenant(ctx context.Context, _ generated.GetTenantRequestObject) (generated.GetTenantResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.getTenantSelf(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) UpdateSelectedTenant(ctx context.Context, _ generated.UpdateSelectedTenantRequestObject) (generated.UpdateSelectedTenantResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.updateTenantSelf(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) ListTenantTokens(ctx context.Context, _ generated.ListTenantTokensRequestObject) (generated.ListTenantTokensResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.listTenantTokens(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) CreateTenantToken(ctx context.Context, _ generated.CreateTenantTokenRequestObject) (generated.CreateTenantTokenResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.createTenantToken(c)
	return openAPIPassthroughResponse{}, nil
}

func (s openAPIServer) RevokeTenantToken(ctx context.Context, _ generated.RevokeTenantTokenRequestObject) (generated.RevokeTenantTokenResponseObject, error) {
	c, ok := ctx.(*gin.Context)
	if !ok {
		return nil, errOpenAPIContext
	}
	s.server.revokeTenantToken(c)
	return openAPIPassthroughResponse{}, nil
}

func (openAPIPassthroughResponse) VisitListTenantsResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitCreateTenantResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitDeleteTenantResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitUpdateTenantResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitRestoreTenantResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitListUsersResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitCreateUserResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitGetUserResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitUpdateUserResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitDisableUserResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitRestoreUserResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitListUserMembershipsResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitListTenantMembershipsResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitUpsertTenantMembershipResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitDeleteTenantMembershipResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitListAuditEventsResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitListAdminTokensResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitCreateAdminTokenResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitRevokeAdminTokenResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitGetCurrentPrincipalResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitListBrowserChannelsResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitListEventsResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitGetHealthResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitListSessionsResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitCreateSessionResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitGetSessionsBulkResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitDeleteSessionResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitGetSessionResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitRotateSessionTokenResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitPromoteSessionResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitReopenSessionResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitSuspendSessionResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitReplaceSessionTagsResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitListSnapshotsResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitDeleteSnapshotResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitUpdateSnapshotResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitRestoreSnapshotResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitReplaceSnapshotTagsResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitGetTenantResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitUpdateSelectedTenantResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitListTenantTokensResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitCreateTenantTokenResponse(http.ResponseWriter) error {
	return nil
}

func (openAPIPassthroughResponse) VisitRevokeTenantTokenResponse(http.ResponseWriter) error {
	return nil
}
