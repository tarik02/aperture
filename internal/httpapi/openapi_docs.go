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

	for _, pathItem := range spec.Paths.Map() {
		for _, operation := range pathItem.Operations() {
			auth, ok := operation.Extensions["x-aperture-auth"].(map[string]any)
			if !ok {
				continue
			}

			badges := make([]map[string]string, 0)
			if public, _ := auth["public"].(bool); public {
				badges = append(badges, map[string]string{"name": "public", "color": "green"})
			}
			if scopes, ok := auth["requiredScopes"].([]any); ok {
				for _, value := range scopes {
					if scope, ok := value.(string); ok {
						badges = append(badges, map[string]string{"name": scope, "color": "blue"})
					}
				}
			}
			if scopes, ok := auth["conditionalScopes"].([]any); ok {
				for _, value := range scopes {
					conditionalScope, ok := value.(map[string]any)
					if !ok {
						continue
					}
					if scope, ok := conditionalScope["scope"].(string); ok {
						badges = append(badges, map[string]string{"name": scope + " (conditional)", "color": "orange"})
					}
				}
			}
			if len(badges) > 0 {
				operation.Extensions["x-badges"] = badges
			}
		}
	}

	c.JSON(http.StatusOK, spec)
}

func scalarAPIReference(c *gin.Context) {
	c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(scalarAPIReferenceHTML))
}
