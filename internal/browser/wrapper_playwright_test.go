package browser

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestPlaywrightCallWaitsForItsTurnOnlyAsLongAsItsContext(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		backend := newPlaywrightMCPBackend(RuntimeEnvValues{})
		// Another call has the session.
		if err := backend.acquire(context.Background()); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		started := time.Now()
		result, err := backend.Call(ctx, "browser_evaluate", map[string]any{})
		if result != nil || !errors.Is(err, context.DeadlineExceeded) || time.Since(started) != 2*time.Second {
			t.Fatalf("result %v, error %v after %v", result, err, time.Since(started))
		}
		// The call that was running keeps its turn, and the waiter left no trace.
		if len(backend.slot) != 1 {
			t.Fatal("the waiter took the session's turn")
		}
		backend.release()
		if err := backend.acquire(context.Background()); err != nil {
			t.Fatal(err)
		}
		backend.release()
	})
}

// newTestPlaywrightSession connects the backend to an in-memory MCP server with
// a tool that never answers and one that does.
func newTestPlaywrightSession(t *testing.T) (*playwrightMCPBackend, *mcp.ServerSession) {
	t.Helper()
	server := mcp.NewServer(&mcp.Implementation{Name: "fake-playwright", Version: "1"}, nil)
	type empty struct{}
	mcp.AddTool(server, &mcp.Tool{Name: "hang"}, func(ctx context.Context, _ *mcp.CallToolRequest, _ empty) (*mcp.CallToolResult, empty, error) {
		<-ctx.Done()
		return nil, empty{}, ctx.Err()
	})
	mcp.AddTool(server, &mcp.Tool{Name: "ok"}, func(context.Context, *mcp.CallToolRequest, empty) (*mcp.CallToolResult, empty, error) {
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "fine"}}}, empty{}, nil
	})
	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	serverSession, err := server.Connect(context.Background(), serverTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	session, err := client.Connect(context.Background(), clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	backend := newPlaywrightMCPBackend(RuntimeEnvValues{})
	backend.session = session
	t.Cleanup(func() { _ = session.Close() })
	return backend, serverSession
}

func TestPlaywrightCallKeepsItsSessionWhenTheCallersContextEnds(t *testing.T) {
	backend, _ := newTestPlaywrightSession(t)
	session := backend.session
	// A call that runs out its context, like a pointer tool's timeoutMs, and one
	// that is cancelled.
	timeoutCtx, cancelTimeout := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancelTimeout()
	if _, err := backend.Call(timeoutCtx, "hang", map[string]any{}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error %v", err)
	}
	cancelCtx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	if _, err := backend.Call(cancelCtx, "hang", map[string]any{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("error %v", err)
	}
	if backend.session != session {
		t.Fatal("the session was torn down for the caller's context")
	}
	// The next call is served by the same session.
	result, err := backend.Call(context.Background(), "ok", map[string]any{})
	if err != nil || playwrightResultText(result) != "fine" {
		t.Fatalf("result %v, error %v", result, err)
	}
	if backend.session != session || len(backend.slot) != 0 {
		t.Fatal("the session changed")
	}
}

func TestPlaywrightCallResetsItsSessionOnTransportErrors(t *testing.T) {
	backend, serverSession := newTestPlaywrightSession(t)
	if err := serverSession.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := backend.Call(context.Background(), "ok", map[string]any{}); err == nil {
		t.Fatal("a call on a closed connection succeeded")
	}
	if backend.session != nil {
		t.Fatal("the session of a broken connection was kept")
	}
}
