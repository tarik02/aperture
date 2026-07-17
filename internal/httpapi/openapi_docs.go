package httpapi

import (
	"net/http"

	generated "github.com/aperture/aperture/internal/httpapi/openapi"
	"github.com/gin-gonic/gin"
)

const scalarAPIReferenceHTML = `<!doctype html>
<html>
<head>
  <title>Aperture API Reference</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <div id="app"></div>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.62.9"></script>
  <script>Scalar.createApiReference('#app', {url: '/openapi.json', theme: 'purple'})</script>
</body>
</html>`

func openAPISpec(c *gin.Context) {
	spec, err := generated.GetSpec()
	if err != nil {
		c.JSON(http.StatusInternalServerError, internalErrorBody{Error: "openapi specification unavailable"})
		return
	}
	c.JSON(http.StatusOK, spec)
}

func scalarAPIReference(c *gin.Context) {
	c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(scalarAPIReferenceHTML))
}
