package systemd

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/aperture/aperture/internal/config"
)

type fakeRunner struct {
	mu      sync.Mutex
	calls   [][]string
	outputs map[string]string
	errors  map[string]error
}

func (f *fakeRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	call := append([]string{name}, args...)
	f.calls = append(f.calls, call)

	key := strings.Join(call, "\x00")
	if err, ok := f.errors[key]; ok {
		return nil, err
	}
	if out, ok := f.outputs[key]; ok {
		return []byte(out), nil
	}
	return []byte("active\n"), nil
}

func testAdapter(t *testing.T) *UserAdapter {
	t.Helper()

	adapter, err := NewUserAdapter(config.Config{
		SystemdBrowserUnitName: "browser-session@.service",
	})
	if err != nil {
		t.Fatalf("NewUserAdapter() error = %v", err)
	}
	return adapter
}

func TestUnitNameUsesConfiguredTemplate(t *testing.T) {
	t.Parallel()

	adapter := testAdapter(t)
	sessionID := "018f1234-0000-7000-8000-000000000001"

	unit, err := adapter.UnitName(sessionID)
	if err != nil {
		t.Fatalf("UnitName() error = %v", err)
	}
	if unit != "browser-session@"+sessionID+".service" {
		t.Fatalf("unit = %q", unit)
	}
}

func TestUnitNameRejectsInvalidSessionID(t *testing.T) {
	t.Parallel()

	adapter := testAdapter(t)
	if _, err := adapter.UnitName("bad"); err == nil {
		t.Fatal("expected invalid session id error")
	}
}

func TestStartStopShowUseSystemctlUser(t *testing.T) {
	t.Parallel()

	adapter := testAdapter(t)
	sessionID := "018f1234-0000-7000-8000-000000000002"
	runner := &fakeRunner{
		outputs: map[string]string{
			"systemctl\x00--user\x00show\x00browser-session@" + sessionID + ".service": "ActiveState=active\n",
		},
	}

	ctx := context.Background()
	if err := adapter.Start(ctx, runner, sessionID); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if err := adapter.Stop(ctx, runner, sessionID); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	if out, err := adapter.Show(ctx, runner, sessionID); err != nil {
		t.Fatalf("Show() error = %v", err)
	} else if !strings.Contains(string(out), "ActiveState=active") {
		t.Fatalf("show output = %q", out)
	}

	wantCalls := [][]string{
		{"systemctl", "--user", "start", "browser-session@" + sessionID + ".service"},
		{"systemctl", "--user", "stop", "browser-session@" + sessionID + ".service"},
		{"systemctl", "--user", "show", "browser-session@" + sessionID + ".service"},
	}
	if len(runner.calls) != len(wantCalls) {
		t.Fatalf("calls = %#v, want %#v", runner.calls, wantCalls)
	}
	for i := range wantCalls {
		if strings.Join(runner.calls[i], "|") != strings.Join(wantCalls[i], "|") {
			t.Fatalf("call[%d] = %#v, want %#v", i, runner.calls[i], wantCalls[i])
		}
	}
}

func TestIsActiveReturnsFalseForInactiveUnit(t *testing.T) {
	t.Parallel()

	adapter := testAdapter(t)
	sessionID := "018f1234-0000-7000-8000-000000000003"
	runner := &fakeRunner{
		errors: map[string]error{
			"systemctl\x00--user\x00is-active\x00browser-session@" + sessionID + ".service": &CommandError{ExitCode: 3},
		},
	}

	active, err := adapter.IsActive(context.Background(), runner, sessionID)
	if err != nil {
		t.Fatalf("IsActive() error = %v", err)
	}
	if active {
		t.Fatal("expected inactive unit")
	}
}

func TestStartWrapsCommandError(t *testing.T) {
	t.Parallel()

	adapter := testAdapter(t)
	sessionID := "018f1234-0000-7000-8000-000000000004"
	runner := &fakeRunner{
		errors: map[string]error{
			"systemctl\x00--user\x00start\x00browser-session@" + sessionID + ".service": fmt.Errorf("boom"),
		},
	}

	err := adapter.Start(context.Background(), runner, sessionID)
	if err == nil {
		t.Fatal("expected start error")
	}
	var cmdErr *CommandError
	if !errors.As(err, &cmdErr) {
		t.Fatalf("expected CommandError, got %T", err)
	}
	if cmdErr.Operation != "start" {
		t.Fatalf("operation = %q", cmdErr.Operation)
	}
}
