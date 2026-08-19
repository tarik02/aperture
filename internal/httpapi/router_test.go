package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/db"
	"go.uber.org/zap"
)

type testEnv struct {
	service  *auth.Service
	repo     *db.Repository
	router   http.Handler
	admin    string
	tenant   string
	tenantID string
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()

	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "aperture.db")
	database, err := db.Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := database.Migrate(ctx); err != nil {
		t.Fatalf("migrate database: %v", err)
	}

	repo := db.NewRepository(database)
	service := auth.NewService(repo)
	server := &Server{Auth: service}
	router := NewRouter(zap.NewNop(), server, nil, "")

	adminCreated, err := service.Bootstrap(ctx, auth.BootstrapInput{Name: "admin"})
	if err != nil {
		t.Fatalf("bootstrap admin token: %v", err)
	}

	tenantRow, err := service.CreateTenant(ctx, auth.CreateTenantInput{DisplayName: "acme"})
	if err != nil {
		t.Fatalf("create tenant: %v", err)
	}

	tenantCreated, err := service.CreateToken(ctx, auth.CreateTokenInput{
		AuthorityType: auth.AuthorityTenant,
		TenantID:      &tenantRow.ID,
		Name:          "tenant-admin",
		Scopes:        []string{auth.ScopeTenantWrite, auth.ScopeSessionsRead},
	})
	if err != nil {
		t.Fatalf("create tenant token: %v", err)
	}

	return &testEnv{
		service:  service,
		repo:     repo,
		router:   router,
		admin:    adminCreated.Raw,
		tenant:   tenantCreated.Raw,
		tenantID: tenantRow.ID,
	}
}

func (env *testEnv) do(t *testing.T, method, path, token string, tenantHeader string, body any) *httptest.ResponseRecorder {
	t.Helper()

	var payload []byte
	if body != nil {
		var err error
		payload, err = json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
	}

	req := httptest.NewRequest(method, path, bytes.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+token)
	if tenantHeader != "" {
		req.Header.Set(auth.TenantHeader, tenantHeader)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	rec := httptest.NewRecorder()
	env.router.ServeHTTP(rec, req)
	return rec
}

func TestHealthEndpoint(t *testing.T) {
	t.Parallel()

	router := NewRouter(zap.NewNop(), &Server{Auth: auth.NewService(nil)}, nil, "")
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var body healthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Status != "ok" {
		t.Fatalf("status field = %q, want ok", body.Status)
	}
	if body.Color != "blue" {
		t.Fatalf("color = %q, want blue", body.Color)
	}
	if body.Role != "active" {
		t.Fatalf("role = %q, want active", body.Role)
	}
	if body.ActiveColor != "blue" {
		t.Fatalf("active color = %q, want blue", body.ActiveColor)
	}
}

func TestAdminTenantEndpointsRequireSystemAdmin(t *testing.T) {
	t.Parallel()

	env := newTestEnv(t)
	rec := env.do(t, http.MethodGet, "/api/admin/tenants", env.tenant, "", nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("tenant token on /admin/tenants status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestAdminCreateAndListTenants(t *testing.T) {
	t.Parallel()

	env := newTestEnv(t)

	createRec := env.do(t, http.MethodPost, "/api/admin/tenants", env.admin, "", map[string]string{
		"displayName": "widgets",
	})
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create tenant status = %d, body = %s", createRec.Code, createRec.Body.String())
	}

	listRec := env.do(t, http.MethodGet, "/api/admin/tenants", env.admin, "", nil)
	if listRec.Code != http.StatusOK {
		t.Fatalf("list tenants status = %d, body = %s", listRec.Code, listRec.Body.String())
	}
}

func TestTenantSelfEndpoints(t *testing.T) {
	t.Parallel()

	env := newTestEnv(t)

	getRec := env.do(t, http.MethodGet, "/api/tenant", env.tenant, "", nil)
	if getRec.Code != http.StatusOK {
		t.Fatalf("get tenant self status = %d, body = %s", getRec.Code, getRec.Body.String())
	}

	patchRec := env.do(t, http.MethodPatch, "/api/tenant", env.tenant, "", map[string]string{
		"displayName": "acme-renamed",
	})
	if patchRec.Code != http.StatusOK {
		t.Fatalf("patch tenant self status = %d, body = %s", patchRec.Code, patchRec.Body.String())
	}
}

func TestSystemAdminRequiresTenantHeaderOnTenantRoutes(t *testing.T) {
	t.Parallel()

	env := newTestEnv(t)

	rec := env.do(t, http.MethodGet, "/api/tenant", env.admin, env.tenantID, nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("admin on /tenant status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestTenantTokenManagement(t *testing.T) {
	t.Parallel()

	env := newTestEnv(t)

	createRec := env.do(t, http.MethodPost, "/api/tenant/tokens", env.tenant, "", map[string]any{
		"name":   "operator",
		"scopes": []string{auth.ScopeSessionsRead},
	})
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create tenant token status = %d, body = %s", createRec.Code, createRec.Body.String())
	}

	var created createTokenResponse
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create token response: %v", err)
	}
	if created.RawToken == "" {
		t.Fatal("expected raw token in response")
	}

	listRec := env.do(t, http.MethodGet, "/api/tenant/tokens", env.tenant, "", nil)
	if listRec.Code != http.StatusOK {
		t.Fatalf("list tenant tokens status = %d, body = %s", listRec.Code, listRec.Body.String())
	}

	revokeRec := env.do(t, http.MethodPost, "/api/tenant/tokens/"+created.Token.ID+"/revoke", env.tenant, "", nil)
	if revokeRec.Code != http.StatusNoContent {
		t.Fatalf("revoke tenant token status = %d, body = %s", revokeRec.Code, revokeRec.Body.String())
	}
}

func TestMissingAuthReturnsUnauthorized(t *testing.T) {
	t.Parallel()

	env := newTestEnv(t)
	req := httptest.NewRequest(http.MethodGet, "/api/admin/tenants", nil)
	rec := httptest.NewRecorder()
	env.router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}
