package httpapi

import (
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/gin-gonic/gin"
)

func registerStaticFallback(router *gin.Engine, assets fs.FS, cdpRouteBasePath string, _ *Server) {
	router.NoRoute(func(c *gin.Context) {
		if assets == nil {
			c.Status(http.StatusNotFound)
			return
		}
		if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
			c.Status(http.StatusNotFound)
			return
		}

		requestPath := c.Request.URL.Path
		if tryServeStaticFile(c, assets, requestPath) {
			return
		}

		if !isSPAPath(requestPath) {
			c.Status(http.StatusNotFound)
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

func isSPAPath(requestPath string) bool {
	return requestPath == "/" || requestPath == "/-" || strings.HasPrefix(requestPath, "/-/") || requestPath == "/share" || strings.HasPrefix(requestPath, "/share/")
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
	defer func() { _ = file.Close() }()

	info, err := file.Stat()
	if err != nil || info.IsDir() {
		return false
	}

	c.FileFromFS(name, http.FS(assets))
	return true
}
