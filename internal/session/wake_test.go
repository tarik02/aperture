package session

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"testing"

	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/traefik"
)

func createSuspendedSession(t *testing.T, service *Service, repo *db.Repository) (*db.Session, string) {
	t.Helper()
	ctx := context.Background()
	tenantID := createTenant(t, repo)
	created, err := service.Create(ctx, CreateInput{TenantID: tenantID, BrowserChannel: "chromium"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := service.Suspend(ctx, tenantID, created.Session.ID); err != nil {
		t.Fatalf("Suspend() error = %v", err)
	}
	return loadSession(t, repo, created.Session.ID), created.SessionToken
}

func loadSession(t *testing.T, repo *db.Repository, sessionID string) *db.Session {
	t.Helper()
	sessionRow, err := repo.GetSessionByID(context.Background(), sessionID)
	if err != nil || sessionRow == nil {
		t.Fatalf("load session %s: %v", sessionID, err)
	}
	return sessionRow
}

// The edge proxy routes a CDP request to the wrapper port it knew before ForwardAuth woke the
// session, so a session suspended right after it started must wake on the same ports.
func TestTokenWakeKeepsPortsOfFreshlySuspendedSession(t *testing.T) {
	t.Parallel()

	service, _, repo, _, _ := newTestService(t)
	suspended, sessionToken := createSuspendedSession(t, service, repo)

	if err := service.ValidateSessionTokenForwardAuth(context.Background(), suspended.ID, "Bearer "+sessionToken); err != nil {
		t.Fatalf("ValidateSessionTokenForwardAuth() error = %v", err)
	}

	woken := loadSession(t, repo, suspended.ID)
	if woken.Status != db.SessionStatusRunning {
		t.Fatalf("status = %q, want running", woken.Status)
	}
	if *woken.CurrentCDPPort != *suspended.CurrentCDPPort || *woken.CurrentWrapperPort != *suspended.CurrentWrapperPort {
		t.Fatalf("ports = %d/%d, want the kept %d/%d", *woken.CurrentCDPPort, *woken.CurrentWrapperPort, *suspended.CurrentCDPPort, *suspended.CurrentWrapperPort)
	}
}

// Not parallel: every test service hands out ports from the same range, and this test holds one.
func TestTokenWakeOnNewPortsAsksForRetry(t *testing.T) {
	service, _, repo, _, _ := newTestService(t)
	suspended, sessionToken := createSuspendedSession(t, service, repo)

	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *suspended.CurrentWrapperPort))
	if err != nil {
		t.Skipf("wrapper port %d is taken: %v", *suspended.CurrentWrapperPort, err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	err = service.ValidateSessionTokenForwardAuth(context.Background(), suspended.ID, "Bearer "+sessionToken)
	if !errors.Is(err, ErrEndpointMoved) {
		t.Fatalf("ValidateSessionTokenForwardAuth() error = %v, want ErrEndpointMoved", err)
	}

	woken := loadSession(t, repo, suspended.ID)
	if woken.Status != db.SessionStatusRunning {
		t.Fatalf("status = %q, want running", woken.Status)
	}
	if *woken.CurrentWrapperPort == *suspended.CurrentWrapperPort {
		t.Fatalf("wrapper port = %d, want a new one", *woken.CurrentWrapperPort)
	}
	if err := service.ValidateSessionTokenForwardAuth(context.Background(), suspended.ID, "Bearer "+sessionToken); err != nil {
		t.Fatalf("retry error = %v", err)
	}
}

func TestTokenWakeWithoutOverlayFailsSession(t *testing.T) {
	t.Parallel()

	service, _, repo, _, _ := newTestService(t)
	suspended, sessionToken := createSuspendedSession(t, service, repo)
	if err := os.RemoveAll(suspended.UpperPath); err != nil {
		t.Fatalf("remove overlay: %v", err)
	}

	err := service.ValidateSessionTokenForwardAuth(context.Background(), suspended.ID, "Bearer "+sessionToken)
	if !errors.Is(err, ErrOverlayMissing) {
		t.Fatalf("ValidateSessionTokenForwardAuth() error = %v, want ErrOverlayMissing", err)
	}
	if status := loadSession(t, repo, suspended.ID).Status; status != db.SessionStatusFailed {
		t.Fatalf("status = %q, want failed", status)
	}

	err = service.ValidateSessionTokenForwardAuth(context.Background(), suspended.ID, "Bearer "+sessionToken)
	if !errors.Is(err, ErrNotRunning) {
		t.Fatalf("second request error = %v, want ErrNotRunning", err)
	}
}

func TestReconcileStartupFailsSuspendedSessionWithoutOverlay(t *testing.T) {
	t.Parallel()

	service, _, repo, _, _ := newTestService(t)
	suspended, _ := createSuspendedSession(t, service, repo)
	if err := os.RemoveAll(suspended.UpperPath); err != nil {
		t.Fatalf("remove overlay: %v", err)
	}

	if err := service.ReconcileStartup(context.Background()); err != nil {
		t.Fatalf("ReconcileStartup() error = %v", err)
	}
	if status := loadSession(t, repo, suspended.ID).Status; status != db.SessionStatusFailed {
		t.Fatalf("status = %q, want failed", status)
	}
}

// A restart clears the runtime directory; a suspended session must keep a routable endpoint so its
// next data-plane request can wake it.
func TestReconcileStartupKeepsSuspendedSessionRoutableWithoutRuntimeEnv(t *testing.T) {
	t.Parallel()

	service, _, repo, _, _ := newTestService(t)
	suspended, sessionToken := createSuspendedSession(t, service, repo)
	if err := os.Remove(*suspended.RuntimeEnvPath); err != nil {
		t.Fatalf("remove runtime env: %v", err)
	}

	if err := service.ReconcileStartup(context.Background()); err != nil {
		t.Fatalf("ReconcileStartup() error = %v", err)
	}
	restarted := loadSession(t, repo, suspended.ID)
	if restarted.Status != db.SessionStatusSuspended {
		t.Fatalf("status = %q, want suspended", restarted.Status)
	}
	if routes := traefik.RunningSessionsFromDB([]db.Session{*restarted}); len(routes) != 1 {
		t.Fatalf("routes = %#v, want one for the suspended session", routes)
	}

	if err := service.ValidateSessionTokenForwardAuth(context.Background(), suspended.ID, "Bearer "+sessionToken); err != nil {
		t.Fatalf("ValidateSessionTokenForwardAuth() error = %v", err)
	}
	if status := loadSession(t, repo, suspended.ID).Status; status != db.SessionStatusRunning {
		t.Fatalf("status = %q, want running", status)
	}
}
