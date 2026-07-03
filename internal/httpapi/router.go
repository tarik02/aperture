package httpapi

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// NewRouter returns the HTTP API router.
func NewRouter(logger *zap.Logger, server *Server) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Recovery())

	router.GET("/health", func(c *gin.Context) {
		logger.Debug("health check")
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	admin := router.Group("/admin")
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

	tenant := router.Group("/tenant")
	tenant.Use(server.requireAuth, server.requireTenantWrite)
	{
		tenant.GET("", server.getTenantSelf)
		tenant.PATCH("", server.updateTenantSelf)
		tenant.POST("/tokens", server.createTenantToken)
		tenant.GET("/tokens", server.listTenantTokens)
		tenant.POST("/tokens/:tokenId/revoke", server.revokeTenantToken)
	}

	return router
}
