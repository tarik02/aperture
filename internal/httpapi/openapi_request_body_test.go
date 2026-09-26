package httpapi

import (
	"regexp"
	"testing"

	generated "github.com/aperture/aperture/internal/httpapi/openapi"
)

var openAPIPathParam = regexp.MustCompile(`\{([^}]+)\}`)

// ginPath rewrites an OpenAPI path template to the gin route syntax that
// c.FullPath reports, so spec paths and route paths can be compared directly.
func ginPath(specPath string) string {
	return openAPIPathParam.ReplaceAllString(specPath, ":$1")
}

// The capture list is maintained by hand while the spec moves on its own, and a
// route missing from it is invisible: the route still serves, the strict wrapper
// still decodes, and only the gin handler behind it sees a drained body and
// answers invalid_request_body for every input. Adding a route with a body to
// the spec without adding it here has shipped before, so compare the two.
func TestOpenAPIRoutesWithRequestBodyMatchSpec(t *testing.T) {
	t.Parallel()

	spec, err := generated.GetSpec()
	if err != nil {
		t.Fatalf("load openapi spec: %v", err)
	}

	inSpec := make(map[string]map[string]struct{})
	for specPath, item := range spec.Paths.Map() {
		for method, operation := range item.Operations() {
			if operation.RequestBody == nil || isLiveSessionOperation(operation) {
				continue
			}
			// The strict wrapper hands multipart bodies to the handler as a reader, so
			// nothing re-reads them.
			if operation.RequestBody.Value.Content.Get("multipart/form-data") != nil {
				continue
			}
			if inSpec[method] == nil {
				inSpec[method] = make(map[string]struct{})
			}
			inSpec[method][ginPath(specPath)] = struct{}{}
		}
	}

	for method, paths := range inSpec {
		for path := range paths {
			if !openAPIRouteHasRequestBody(method, path) {
				t.Errorf("%s %s declares a request body in the spec but is missing from openAPIRoutesWithRequestBody", method, path)
			}
		}
	}

	// The reverse direction matters too: a stale entry buffers a body nothing
	// reads, and hides the route's removal from the spec.
	for method, paths := range openAPIRoutesWithRequestBody {
		for path := range paths {
			if _, ok := inSpec[method][path]; !ok {
				t.Errorf("%s %s is listed in openAPIRoutesWithRequestBody but declares no request body in the spec", method, path)
			}
		}
	}
}
