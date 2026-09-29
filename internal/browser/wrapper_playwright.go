package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/playwrightmcp"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const playwrightCallRequestMaxBytes = 16 << 20

type playwrightMCPBackend struct {
	values RuntimeEnvValues
	// slot serializes calls: whoever holds its one token owns session. It is a
	// channel, not a mutex, so that a caller waits for its turn only as long as its
	// context lives.
	slot    chan struct{}
	session *mcp.ClientSession
}

type playwrightCallRequest struct {
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
}

func newPlaywrightMCPBackend(values RuntimeEnvValues) *playwrightMCPBackend {
	return &playwrightMCPBackend{values: values, slot: make(chan struct{}, 1)}
}

// acquire waits for the session's turn, or for ctx to end.
func (b *playwrightMCPBackend) acquire(ctx context.Context) error {
	select {
	case b.slot <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (b *playwrightMCPBackend) release() { <-b.slot }

// Call invokes any tool of the bundled Playwright MCP. It does not apply the
// client-facing tool gate: wrapper code uses it for tools Aperture hides from
// clients, such as the pointer tools behind the CDP fallback. Client calls must
// go through handlePlaywrightCall.
//
// Calls run one at a time. A caller that is waiting for its turn gives up with
// ctx, without disturbing the call that is running.
//
// An error ends the session (the next call starts a new Playwright MCP) unless
// it came from the caller's own context. The go-sdk client answers a cancelled or
// timed-out call by sending the server a cancellation notification and retiring
// the request, so the connection stays sound and a response that arrives later is
// dropped: the session is fine, and tearing it down would only throw away the
// Playwright process (its page state and the seconds it takes to start again) for
// a caller that stopped waiting, such as a pointer tool's timeoutMs or a burst's
// probe. The one thing that may go on is the abandoned request itself, which the
// server stops or finishes by its own timeout; the tools that reach here bound
// themselves (Playwright's action timeout), and a wedged server shows up as a
// transport error on a later call, which does reset the session.
func (b *playwrightMCPBackend) Call(ctx context.Context, name string, arguments map[string]any) (*mcp.CallToolResult, error) {
	if err := b.acquire(ctx); err != nil {
		return nil, err
	}
	defer b.release()
	if b.session == nil {
		if err := b.start(ctx); err != nil {
			return nil, err
		}
	}

	result, err := b.session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: arguments})
	if err != nil {
		if ctx.Err() == nil {
			_ = b.session.Close()
			b.session = nil
		}
		return nil, err
	}
	return result, nil
}

func (b *playwrightMCPBackend) start(ctx context.Context) error {
	files := paths.SessionFiles(b.values.FilesDir)
	args := []string{
		"--cdp-endpoint", "http://127.0.0.1:" + strconv.Itoa(b.values.CDPPort),
		"--cdp-timeout", "30000",
		"--codegen", "none",
		"--file-paths", "relative",
		"--idle-timeout", "0",
		"--no-webmcp",
		"--output-dir", files.Outputs,
	}
	if capabilities := playwrightmcp.RuntimeCapabilities(); len(capabilities) > 0 {
		args = append(args, "--caps", strings.Join(capabilities, ","))
	}
	command := exec.Command("playwright-mcp", args...)
	// The workspace root bounds which files browser tools may read, so every session
	// file is usable by browser_file_upload under its relative path.
	command.Dir = files.Root
	command.Env = []string{
		"HOME=" + b.values.CacheDir,
		"TMPDIR=" + os.TempDir(),
		"XDG_CACHE_HOME=" + b.values.CacheDir,
	}
	command.Stderr = os.Stderr

	startupCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	client := mcp.NewClient(&mcp.Implementation{Name: "aperture-browser-session", Version: "1.0.0"}, nil)
	session, err := client.Connect(startupCtx, &mcp.CommandTransport{Command: command}, nil)
	if err != nil {
		return fmt.Errorf("start Playwright MCP: %w", err)
	}
	b.session = session
	return nil
}

func (b *playwrightMCPBackend) Close() {
	// Close waits for the call that is running, which ends with its own context.
	_ = b.acquire(context.Background())
	defer b.release()
	if b.session == nil {
		return
	}
	_ = b.session.Close()
	b.session = nil
}

func (r *wrapperRuntime) handlePlaywrightCall(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !r.wrapperControlAuthorized(req) {
		writeWrapperError(w, http.StatusUnauthorized, "wrapper control token required")
		return
	}
	if r.playwright == nil {
		writeWrapperError(w, http.StatusServiceUnavailable, "Playwright MCP is unavailable")
		return
	}

	req.Body = http.MaxBytesReader(w, req.Body, playwrightCallRequestMaxBytes)
	var call playwrightCallRequest
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&call); err != nil {
		writeWrapperError(w, http.StatusBadRequest, "invalid Playwright MCP call")
		return
	}
	if call.Name == "" || !playwrightmcp.HasTool(call.Name) {
		writeWrapperError(w, http.StatusBadRequest, "Playwright tool is not exposed")
		return
	}
	if call.Arguments == nil {
		call.Arguments = map[string]any{}
	}

	ctx, ticket := r.beginBurstAction(req.Context(), call.Name, call.Arguments, 0)
	// Whatever ends the handler, the bursts hear that the action is over: the
	// deferred end only counts when the normal one did not run (a panic).
	defer ticket.end(errBurstActionAbandoned)
	result, err := r.playwright.Call(ctx, call.Name, call.Arguments)
	ticket.end(burstFailure(result, err))
	if err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: Playwright MCP tool %s failed: %v\n", call.Name, err)
		writeWrapperError(w, http.StatusBadGateway, "Playwright MCP call failed")
		return
	}
	writeWrapperJSON(w, http.StatusOK, result)
}
