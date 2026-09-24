package browser

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
)

// The session daemon polls this route to decide when a session is usable, so the
// wrapper must serve /json/version for the owner role by proxying to Chromium.
func TestWrapperServesCDPVersionForOwnerRole(t *testing.T) {
	t.Parallel()

	chromium := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/json/version" {
			t.Errorf("chromium path = %q, want /json/version", req.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"Browser":"Chrome/151.0.0.0"}`))
	}))
	defer chromium.Close()

	parsed, err := url.Parse(chromium.URL)
	if err != nil {
		t.Fatalf("parse chromium url: %v", err)
	}
	cdpPort, err := strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatalf("parse chromium port: %v", err)
	}

	runtime := newWrapperRuntime(RuntimeEnvValues{SessionID: "session", CDPPort: cdpPort}, "")

	request := httptest.NewRequest(http.MethodGet, "/json/version", nil)
	request.Header.Set("X-Aperture-Collaboration-Role", "owner")
	recorder := httptest.NewRecorder()
	runtime.handleCDPDiscovery(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if body := recorder.Body.String(); body == "" {
		t.Fatal("expected the Chromium version payload to be proxied")
	}
}
