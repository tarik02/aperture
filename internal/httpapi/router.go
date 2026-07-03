package httpapi

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// NewRouter returns the HTTP API router with stage-0 routes only.
func NewRouter(logger *zap.Logger) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Recovery())

	router.GET("/health", func(c *gin.Context) {
		logger.Debug("health check")
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	return router
}
