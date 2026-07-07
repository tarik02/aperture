package httpapi

import (
	"io/fs"
	"net/http"
	"strings"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/deploystate"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// NewRouter returns the HTTP API router. staticAssets may be nil to disable SPA
// fallback. cdpRouteBasePath reserves CDP paths from SPA fallback.
func NewRouter(logger *zap.Logger, server *Server, staticAssets fs.FS, cdpRouteBasePath string) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	if logger == nil {
		logger = zap.NewNop()
	}
	if server.Logger == nil {
		server.Logger = logger
	}
	router := gin.New()
	router.Use(gin.Recovery())
	internal := router.Group("/internal")
	{
		internal.GET("/forward-auth/cdp/:sessionId", server.cdpForwardAuth)
		internal.GET("/forward-auth/live-session/:sessionId/:access", server.liveSessionForwardAuth)

		jobs := internal.Group("/jobs")
		jobs.Use(server.requireLoopback, server.requireJobToken)
		{
			jobs.POST("/gc", server.runGCJob)
		}
	}

	api := router.Group("/api")
	{
		api.GET("/health", server.health)

		authRoutes := api.Group("/auth")
		authRoutes.Use(server.requireAuth)
		{
			authRoutes.GET("/me", server.authMe)
		}

		browser := api.Group("/browser")
		browser.Use(server.requireAuth, server.requireSessionsReadScope)
		{
			browser.GET("/channels", server.listBrowserChannels)
		}

		admin := api.Group("/admin")
		admin.Use(server.requireAuth, server.requireSystemAdmin)
		{
			admin.POST("/tenants", server.createTenant)
			admin.GET("/tenants", server.listTenants)
			admin.PATCH("/tenants/:tenantId", server.updateTenant)
			admin.DELETE("/tenants/:tenantId", server.deleteTenant)
			admin.POST("/tenants/:tenantId/restore", server.restoreTenant)

			admin.POST("/tokens", server.createAdminToken)
			admin.GET("/tokens", server.listAdminTokens)
			admin.POST("/tokens/:tokenId/revoke", server.revokeAdminToken)
		}

		tenant := api.Group("/tenant")
		tenant.Use(server.requireAuth, server.requireTenantWrite)
		{
			tenant.GET("", server.getTenantSelf)
			tenant.PATCH("", server.updateTenantSelf)
			tenant.POST("/tokens", server.createTenantToken)
			tenant.GET("/tokens", server.listTenantTokens)
			tenant.POST("/tokens/:tokenId/revoke", server.revokeTenantToken)
		}

		sessions := api.Group("/sessions")
		sessions.Use(server.requireAuth)
		{
			sessions.GET("", server.requireSessionsRead, server.listSessions)
			sessions.POST("", server.requireSessionsWrite, server.createSession)
			sessions.DELETE("/:sessionId", server.requireSessionsWrite, server.deleteSession)
			sessions.PUT("/:sessionId/tags", server.requireSessionsWrite, server.replaceSessionTags)
			sessions.POST("/:sessionId/reopen", server.requireSessionsWrite, server.reopenSession)
			sessions.POST("/:sessionId/cdp-token/rotate", server.requireSessionsWrite, server.rotateCDPToken)
			sessions.POST("/:sessionId/promote", server.requirePromotionScopes, server.promoteSession)
		}

		snapshots := api.Group("/snapshots")
		snapshots.Use(server.requireAuth)
		{
			snapshots.GET("", server.requireSnapshotsRead, server.listSnapshots)
			snapshots.DELETE("/:name", server.requireSnapshotsWrite, server.deleteSnapshot)
			snapshots.PUT("/:name/tags", server.requireSnapshotsWrite, server.replaceSnapshotTags)
			snapshots.POST("/:name/restore", server.requireSnapshotsWrite, server.restoreSnapshot)
		}

		api.GET("/events", server.requireAuth, server.requireSessionsRead, server.listEvents)

	}

	liveSessions := router.Group("/sessions")
	{
		liveSessions.Any("/:sessionId/cdp", server.proxyLiveCDPDiscovery)
		liveSessions.Any("/:sessionId/cdp/*path", server.proxyLiveCDPDiscovery)
	}

	registerStaticFallback(router, staticAssets, cdpRouteBasePath, server)

	return router
}

func (s *Server) health(c *gin.Context) {
	if s.Logger != nil {
		s.Logger.Debug("health check")
	}

	color := strings.ToLower(strings.TrimSpace(s.DeployColor))
	if color == "" {
		color = config.DeployColorBlue
	}

	role := deploystate.RoleActive
	activeColor := color
	if s.Deploy != nil {
		state, err := s.Deploy.Load()
		if err != nil {
			WriteInternalError(c, err)
			return
		}
		role = deploystate.Role(state, color)
		activeColor = state.ActiveColor
	}

	c.JSON(http.StatusOK, healthResponse{
		Status:      "ok",
		Color:       color,
		Role:        role,
		Version:     s.DeployVersion,
		ActiveColor: activeColor,
	})
}
