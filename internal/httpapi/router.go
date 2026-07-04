package httpapi

import (
	"io/fs"
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// NewRouter returns the HTTP API router. staticAssets may be nil to disable SPA
// fallback. cdpRouteBasePath reserves CDP paths from SPA fallback.
func NewRouter(logger *zap.Logger, server *Server, staticAssets fs.FS, cdpRouteBasePath string) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Recovery())

	internal := router.Group("/internal")
	{
		internal.GET("/forward-auth/cdp/:sessionId", server.cdpForwardAuth)

		jobs := internal.Group("/jobs")
		jobs.Use(server.requireLoopback, server.requireJobToken)
		{
			jobs.POST("/gc", server.runGCJob)
		}
	}

	api := router.Group("/api")
	{
		api.GET("/health", func(c *gin.Context) {
			logger.Debug("health check")
			c.JSON(http.StatusOK, gin.H{"status": "ok"})
		})

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

		cdp := api.Group("/cdp")
		cdp.Use(server.requireAuth, server.requireSessionsWrite)
		{
			cdp.Any("/:sessionId", server.proxyAPICDP)
			cdp.Any("/:sessionId/*path", server.proxyAPICDP)
		}
	}

	registerStaticFallback(router, staticAssets, cdpRouteBasePath)

	return router
}
