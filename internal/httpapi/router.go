package httpapi

import (
	"io/fs"
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// NewRouter returns the HTTP API router. staticAssets may be nil to disable SPA
// fallback.
func NewRouter(logger *zap.Logger, server *Server, staticAssets fs.FS, cdpRouteBasePath string) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	if logger == nil {
		logger = zap.NewNop()
	}
	if server.Logger == nil {
		server.Logger = logger
	}
	router := gin.New()
	router.Use(gin.Recovery(), server.handoffInactiveAPI)
	router.GET("/docs", scalarAPIReference)
	router.GET("/openapi.json", openAPISpec)
	internal := router.Group("/internal")
	{
		internal.GET("/forward-auth/cdp/:sessionId", server.cdpForwardAuth)
		internal.GET("/forward-auth/live-session/:sessionId/:access", server.liveSessionForwardAuth)
		internal.GET("/session-events/:sessionId/upload/pending", server.requireLoopback, server.listPendingSessionUploads)
		internal.POST("/session-events/:sessionId/upload/prepare", server.requireLoopback, server.prepareSessionUpload)
		internal.POST("/session-events/:sessionId/upload/finalize", server.requireLoopback, server.finalizeSessionUpload)
		internal.POST("/session-events/:sessionId/upload/cancel", server.requireLoopback, server.cancelPendingSessionUpload)

		jobs := internal.Group("/jobs")
		jobs.Use(server.rejectInactiveInternalJob, server.requireLoopback, server.requireJobToken)
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
			sessions.POST("/bulk", server.requireSessionsRead, server.getSessionsBulk)
			sessions.GET("/:sessionId", server.requireSessionsRead, server.getSession)
			sessions.POST("", server.requireSessionsWrite, server.createSession)
			sessions.DELETE("/:sessionId", server.requireSessionsWrite, server.deleteSession)
			sessions.PUT("/:sessionId/tags", server.requireSessionsWrite, server.replaceSessionTags)
			sessions.POST("/:sessionId/suspend", server.requireSessionsWrite, server.suspendSession)
			sessions.POST("/:sessionId/reopen", server.requireSessionsWrite, server.reopenSession)
			sessions.POST("/:sessionId/cdp-token/rotate", server.requireSessionsWrite, server.rotateCDPToken)
			sessions.POST("/:sessionId/promote", server.requirePromotionScopes, server.promoteSession)
		}

		snapshots := api.Group("/snapshots")
		snapshots.Use(server.requireAuth)
		{
			snapshots.GET("", server.requireSnapshotsRead, server.listSnapshots)
			snapshots.PATCH("/:name", server.requireSnapshotsWrite, server.updateSnapshot)
			snapshots.DELETE("/:name", server.requireSnapshotsWrite, server.deleteSnapshot)
			snapshots.PUT("/:name/tags", server.requireSnapshotsWrite, server.replaceSnapshotTags)
			snapshots.POST("/:name/restore", server.requireSnapshotsWrite, server.restoreSnapshot)
		}

		api.GET("/events", server.requireAuth, server.requireSessionsRead, server.listEvents)

	}

	registerStaticFallback(router, staticAssets, cdpRouteBasePath, server)

	return router
}

func (s *Server) health(c *gin.Context) {
	if s.Logger != nil {
		s.Logger.Debug("health check")
	}

	state, color, role, err := s.deployRole()
	if err != nil {
		WriteInternalError(c, err)
		return
	}
	activeColor := state.ActiveColor
	if activeColor == "" {
		activeColor = color
	}

	c.JSON(http.StatusOK, healthResponse{
		Status:      "ok",
		Color:       color,
		Role:        role,
		Version:     s.DeployVersion,
		ActiveColor: activeColor,
	})
}
