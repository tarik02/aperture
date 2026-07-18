package httpapi

import (
	"net/http"
	"strconv"

	generated "github.com/aperture/aperture/internal/httpapi/openapi"
	"github.com/getkin/kin-openapi/openapi3"
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

	errorStatuses := spec.Components.Schemas["ErrorCode"].Value.Extensions["x-aperture-http-status"].(map[string]any)
	for _, pathItem := range spec.Paths.Map() {
		for _, operation := range pathItem.Operations() {
			auth, ok := operation.Extensions["x-aperture-auth"].(map[string]any)
			badges := make([]map[string]string, 0)
			public, _ := auth["public"].(bool)
			if public {
				badges = append(badges, map[string]string{"name": "public"})
			}
			if scopes, scopesOK := auth["requiredScopes"].([]any); scopesOK {
				for _, value := range scopes {
					if scope, scopeOK := value.(string); scopeOK {
						badges = append(badges, map[string]string{"name": scope})
					}
				}
			}
			if scopes, scopesOK := auth["conditionalScopes"].([]any); scopesOK {
				for _, value := range scopes {
					conditionalScope, scopeOK := value.(map[string]any)
					if !scopeOK {
						continue
					}
					if scope, scopeOK := conditionalScope["scope"].(string); scopeOK {
						badges = append(badges, map[string]string{"name": scope + " (conditional)"})
					}
				}
			}
			if len(badges) > 0 {
				operation.Extensions["x-badges"] = badges
			}

			errorCodes := make([]string, 0)
			seenErrorCodes := make(map[string]struct{})
			addErrorCodes := func(codes ...string) {
				for _, code := range codes {
					if _, exists := seenErrorCodes[code]; exists {
						continue
					}
					seenErrorCodes[code] = struct{}{}
					errorCodes = append(errorCodes, code)
				}
			}
			if operationErrors, errorsOK := operation.Extensions["x-aperture-errors"].([]any); errorsOK {
				for _, value := range operationErrors {
					addErrorCodes(value.(string))
				}
			}
			if ok && !public {
				addErrorCodes(
					"authentication_required",
					"invalid_authentication_token",
					"authentication_token_expired",
					"authentication_token_revoked",
				)
				if scopes, scopesOK := auth["requiredScopes"].([]any); scopesOK && len(scopes) > 0 {
					addErrorCodes("insufficient_scope")
				} else if authorityTypes, authorityTypesOK := auth["authorityTypes"].([]any); authorityTypesOK && len(authorityTypes) == 1 {
					addErrorCodes("insufficient_scope")
				}
				switch auth["tenantResolution"] {
				case "token_tenant":
					addErrorCodes("tenant_not_found")
				case "token_tenant_or_required_header":
					addErrorCodes("tenant_selection_required", "tenant_selection_not_permitted")
				}
				addErrorCodes("internal_error")
			}
			if len(errorCodes) == 0 {
				continue
			}

			codesByStatus := make(map[int][]string)
			for _, code := range errorCodes {
				status := int(errorStatuses[code].(float64))
				codesByStatus[status] = append(codesByStatus[status], code)
			}
			documentedErrors := make(map[string][]string, len(codesByStatus))
			for status, codes := range codesByStatus {
				documentedErrors[strconv.Itoa(status)] = codes
			}
			operation.Extensions["x-aperture-errors"] = documentedErrors
			operation.Responses.Delete("default")
			for status, codes := range codesByStatus {
				enum := make([]any, len(codes))
				for index, code := range codes {
					enum[index] = code
				}
				codeSchema := openapi3.NewStringSchema().WithEnum(enum...)
				codeSchema.Description = "Stable error code returned by this operation."
				codeSchema.Example = codes[0]
				messageSchema := openapi3.NewStringSchema()
				messageSchema.Description = "Human-readable error context."
				errorSchema := openapi3.NewObjectSchema().
					WithRequired([]string{"error"}).
					WithProperty("error", openapi3.NewObjectSchema().
						WithRequired([]string{"code", "message"}).
						WithProperty("code", codeSchema).
						WithProperty("message", messageSchema))
				operation.Responses.Set(strconv.Itoa(status), &openapi3.ResponseRef{Value: openapi3.NewResponse().
					WithDescription(http.StatusText(status)).
					WithJSONSchema(errorSchema)})
			}
		}
	}

	c.JSON(http.StatusOK, spec)
}

func scalarAPIReference(c *gin.Context) {
	c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(scalarAPIReferenceHTML))
}
