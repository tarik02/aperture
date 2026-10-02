package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/playwrightmcp"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const playwrightCallRequestMaxBytes = 16 << 20

type playwrightMCPBackend struct {
	values      RuntimeEnvValues
	cdpEndpoint string
	mu          sync.Mutex
	session     *mcp.ClientSession
}

type playwrightCallRequest struct {
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
}

func newPlaywrightMCPBackend(values RuntimeEnvValues, cdpEndpoint string) *playwrightMCPBackend {
	return &playwrightMCPBackend{values: values, cdpEndpoint: cdpEndpoint}
}

// startAutomationBackend starts the CDP proxy that Playwright MCP drives the browser through and the
// backend that talks to it. Both end with ctx.
func (r *wrapperRuntime) startAutomationBackend(ctx context.Context, liveSession *liveSession) error {
	var pointer *cdpPointer
	if multiTargetCompositorEnabled(r.values) {
		pointer = newCDPPointer(r.controlSocket, r.pointerSurface, liveSession.journal)
		liveSession.pointer = pointer
	}
	proxy := newCDPProxy(net.JoinHostPort("127.0.0.1", strconv.Itoa(r.values.CDPPort)), liveSession.automationCadence, pointer, liveSession.journal, func() bool { return liveSession.activeRecordings.Load() > 0 })
	endpoint, err := proxy.serve(ctx)
	if err != nil {
		return err
	}
	r.playwright = newPlaywrightMCPBackend(r.values, endpoint)
	go func() {
		<-ctx.Done()
		r.playwright.Close()
	}()
	return nil
}

// pointerSurface finds the compositor surface of a browser target that can take input.
func (r *wrapperRuntime) pointerSurface(targetID string) (cdpSurface, bool) {
	r.mu.Lock()
	registry := r.targets
	r.mu.Unlock()
	if registry == nil {
		return cdpSurface{}, false
	}
	target, ready := registry.readyTarget(targetID)
	return cdpSurface{id: target.SurfaceID, targetID: target.TargetID, width: float64(target.Viewport.Width), height: float64(target.Viewport.Height)}, ready
}

func (b *playwrightMCPBackend) Call(ctx context.Context, name string, arguments map[string]any) (*mcp.CallToolResult, error) {
	if !playwrightmcp.HasTool(name) {
		return nil, fmt.Errorf("playwright tool %q is not exposed", name)
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	if b.session == nil {
		if err := b.start(ctx); err != nil {
			return nil, err
		}
	}

	result, err := b.session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: arguments})
	if err != nil {
		_ = b.session.Close()
		b.session = nil
		return nil, err
	}
	return result, nil
}

func (b *playwrightMCPBackend) start(ctx context.Context) error {
	files := paths.SessionFiles(b.values.FilesDir)
	args := []string{
		"--cdp-endpoint", b.cdpEndpoint,
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
	b.mu.Lock()
	defer b.mu.Unlock()
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

	// One browser call at a time, and none while a recording starts or stops.
	release, err := r.liveSession.acquireGate(req.Context())
	if err != nil {
		writeWrapperError(w, http.StatusServiceUnavailable, "browser call was canceled")
		return
	}
	defer release()
	started := time.Now()
	result, err := r.playwright.Call(req.Context(), call.Name, call.Arguments)
	if !playwrightmcp.ReadOnly(call.Name) {
		r.liveSession.journal("call", started, map[string]any{"tool": call.Name, "ok": err == nil && !result.IsError})
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: Playwright MCP tool %s failed: %v\n", call.Name, err)
		writeWrapperError(w, http.StatusBadGateway, "Playwright MCP call failed")
		return
	}
	writeWrapperJSON(w, http.StatusOK, result)
}
