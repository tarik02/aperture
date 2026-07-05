package httpapi

import (
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/gin-gonic/gin"
)

func registerStaticFallback(router *gin.Engine, assets fs.FS, cdpRouteBasePath string) {
	if assets == nil {
		return
	}

	cdpBase := normalizedCDPRouteBase(cdpRouteBasePath)
	router.NoRoute(func(c *gin.Context) {
		if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
			c.Status(http.StatusNotFound)
			return
		}

		requestPath := c.Request.URL.Path
		if isReservedSPAPath(requestPath, cdpBase) {
			c.Status(http.StatusNotFound)
			return
		}

		if tryServeStaticFile(c, assets, requestPath) {
			return
		}

		indexHTML, err := fs.ReadFile(assets, "index.html")
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}

		c.Data(http.StatusOK, "text/html; charset=utf-8", indexHTML)
	})
}

func normalizedCDPRouteBase(cdpRouteBasePath string) string {
	base := strings.TrimRight(strings.TrimSpace(cdpRouteBasePath), "/")
	if base == "" {
		return "/cdp"
	}
	return base
}

func isReservedSPAPath(requestPath, cdpBase string) bool {
	if requestPath == "/api" || strings.HasPrefix(requestPath, "/api/") {
		return true
	}
	if requestPath == "/internal" || strings.HasPrefix(requestPath, "/internal/") {
		return true
	}
	if requestPath == cdpBase || strings.HasPrefix(requestPath, cdpBase+"/") {
		return true
	}
	return false
}

func tryServeStaticFile(c *gin.Context, assets fs.FS, requestPath string) bool {
	name := strings.TrimPrefix(path.Clean(requestPath), "/")
	if name == "" || strings.Contains(name, "..") {
		return false
	}

	file, err := assets.Open(name)
	if err != nil {
		return false
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil || info.IsDir() {
		return false
	}

	c.FileFromFS(name, http.FS(assets))
	return true
}
