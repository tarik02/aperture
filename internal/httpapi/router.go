package httpapi

import (
	"io/fs"
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// NewRouter returns the HTTP API router. staticAssets may be nil to disable SPA
// fallback.
func NewRouter(logger *zap.Logger, server *Server, staticAssets fs.FS, cdpRouteBasePath string) http.Handler {
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
	server.initMCPHandler()
	router.Any("/mcp", server.mcp)
	router.Any("/sessions/:sessionId/mcp", server.mcp)
	router.GET("/sessions/:sessionId/files/*relativePath", server.sessionFile)
	router.GET("/auth/providers", server.listOIDCProviders)
	if server.WebAuth != nil {
		router.GET("/auth/oidc/:providerId/login", server.beginOIDC)
		router.GET("/auth/oidc/:providerId/callback", server.completeOIDC)
		router.POST("/auth/passkeys/login/options", server.beginPasskeyLogin)
		router.POST("/auth/passkeys/login/finish", server.completePasskeyLogin)
		router.GET("/auth/passkeys", server.listPasskeys)
		router.POST("/auth/passkeys/registration/options", server.beginPasskeyRegistration)
		router.POST("/auth/passkeys/registration/finish", server.completePasskeyRegistration)
		router.PATCH("/auth/passkeys/:passkeyId", server.renamePasskey)
		router.DELETE("/auth/passkeys/:passkeyId", server.deletePasskey)
		router.POST("/auth/logout", server.logoutWebSession)
	}
	internal := router.Group("/internal")
	{
		internal.GET("/forward-auth/cdp/:sessionId", server.sessionTokenForwardAuth)
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

	registerOpenAPIRoutes(router, server)

	registerStaticFallback(router, staticAssets, cdpRouteBasePath, server)

	if server.WebAuth != nil {
		return server.WebAuth.LoadAndSave(router)
	}
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
