package auth

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/db"
)

func newTestService(t *testing.T) (*Service, *db.Repository) {
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
	service := NewService(repo)
	service.now = func() time.Time {
		return time.Date(2026, 7, 4, 0, 0, 0, 0, time.UTC)
	}
	return service, repo
}

func TestBootstrapCreatesSystemAdminTokenOnce(t *testing.T) {
	t.Parallel()

	service, repo := newTestService(t)
	ctx := context.Background()

	created, err := service.Bootstrap(ctx, BootstrapInput{Name: "bootstrap"})
	if err != nil {
		t.Fatalf("Bootstrap() error = %v", err)
	}
	if created.Raw == "" {
		t.Fatal("expected raw bootstrap token")
	}

	count, err := repo.CountAPITokens(ctx)
	if err != nil {
		t.Fatalf("CountAPITokens() error = %v", err)
	}
	if count != 1 {
		t.Fatalf("token count = %d, want 1", count)
	}

	if _, err := service.Bootstrap(ctx, BootstrapInput{}); !errors.Is(err, ErrBootstrapNotEmpty) {
		t.Fatalf("second bootstrap error = %v, want ErrBootstrapNotEmpty", err)
	}
}

func TestBootstrapIsAtomicUnderConcurrency(t *testing.T) {
	t.Parallel()

	service, repo := newTestService(t)
	ctx := context.Background()

	const workers = 8
	var wg sync.WaitGroup
	results := make(chan error, workers)

	wg.Add(workers)
	for i := range workers {
		go func(n int) {
			defer wg.Done()
			_, err := service.Bootstrap(ctx, BootstrapInput{Name: fmt.Sprintf("bootstrap-%d", n)})
			results <- err
		}(i)
	}
	wg.Wait()
	close(results)

	successes := 0
	notEmpty := 0
	for err := range results {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrBootstrapNotEmpty):
			notEmpty++
		default:
			t.Fatalf("unexpected bootstrap error: %v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("successful bootstraps = %d, want 1", successes)
	}
	if notEmpty != workers-1 {
		t.Fatalf("bootstrap-not-empty results = %d, want %d", notEmpty, workers-1)
	}

	count, err := repo.CountAPITokens(ctx)
	if err != nil {
		t.Fatalf("CountAPITokens() error = %v", err)
	}
	if count != 1 {
		t.Fatalf("token count = %d, want 1", count)
	}
}

func TestAuthenticateRejectsExpiredAndRevokedTokens(t *testing.T) {
	t.Parallel()

	service, _ := newTestService(t)
	ctx := context.Background()

	created, err := service.Bootstrap(ctx, BootstrapInput{Name: "bootstrap"})
	if err != nil {
		t.Fatalf("Bootstrap() error = %v", err)
	}

	if _, err := service.Authenticate(ctx, created.Raw); err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}

	if err := service.RevokeToken(ctx, created.Token.ID, nil); err != nil {
		t.Fatalf("RevokeToken() error = %v", err)
	}
	if _, err := service.Authenticate(ctx, created.Raw); !errors.Is(err, ErrTokenRevoked) {
		t.Fatalf("Authenticate() after revoke error = %v, want ErrTokenRevoked", err)
	}
}

func TestDeleteTenantRevokesTenantTokens(t *testing.T) {
	t.Parallel()

	service, repo := newTestService(t)
	ctx := context.Background()

	tenant, err := service.CreateTenant(ctx, CreateTenantInput{DisplayName: "acme"})
	if err != nil {
		t.Fatalf("CreateTenant() error = %v", err)
	}

	created, err := service.CreateToken(ctx, CreateTokenInput{
		AuthorityType: AuthorityTenant,
		TenantID:      &tenant.ID,
		Name:          "tenant-admin",
		Scopes:        []string{ScopeTenantWrite},
	})
	if err != nil {
		t.Fatalf("CreateToken() error = %v", err)
	}

	if _, err := service.DeleteTenant(ctx, tenant.ID); err != nil {
		t.Fatalf("DeleteTenant() error = %v", err)
	}

	row, err := repo.GetAPITokenByID(ctx, created.Token.ID)
	if err != nil {
		t.Fatalf("GetAPITokenByID() error = %v", err)
	}
	if row.RevokedAt == nil {
		t.Fatal("expected tenant token to be revoked on tenant deletion")
	}

	if _, err := service.Authenticate(ctx, created.Raw); !errors.Is(err, ErrTokenRevoked) {
		t.Fatalf("Authenticate() after tenant delete error = %v, want ErrTokenRevoked", err)
	}
}

func TestRestoreTenantDoesNotUnrevokeTokens(t *testing.T) {
	t.Parallel()

	service, repo := newTestService(t)
	ctx := context.Background()

	tenant, err := service.CreateTenant(ctx, CreateTenantInput{DisplayName: "restore-me"})
	if err != nil {
		t.Fatalf("CreateTenant() error = %v", err)
	}

	created, err := service.CreateToken(ctx, CreateTokenInput{
		AuthorityType: AuthorityTenant,
		TenantID:      &tenant.ID,
		Name:          "old-token",
		Scopes:        []string{ScopeTenantWrite},
	})
	if err != nil {
		t.Fatalf("CreateToken() error = %v", err)
	}

	if _, err := service.DeleteTenant(ctx, tenant.ID); err != nil {
		t.Fatalf("DeleteTenant() error = %v", err)
	}
	if _, err := service.RestoreTenant(ctx, tenant.ID); err != nil {
		t.Fatalf("RestoreTenant() error = %v", err)
	}

	row, err := repo.GetAPITokenByID(ctx, created.Token.ID)
	if err != nil {
		t.Fatalf("GetAPITokenByID() error = %v", err)
	}
	if row.RevokedAt == nil {
		t.Fatal("expected old tenant token to remain revoked after restore")
	}
}
