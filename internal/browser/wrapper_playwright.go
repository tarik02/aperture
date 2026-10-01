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
	values        RuntimeEnvValues
	controlSocket string
	slot          chan struct{} // one call at a time; holding it guards session
	session       *mcp.ClientSession
}

type playwrightCallRequest struct {
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
}

func newPlaywrightMCPBackend(values RuntimeEnvValues, controlSocket string) *playwrightMCPBackend {
	return &playwrightMCPBackend{values: values, controlSocket: controlSocket, slot: make(chan struct{}, 1)}
}

func (b *playwrightMCPBackend) Call(ctx context.Context, name string, arguments map[string]any) (*mcp.CallToolResult, error) {
	if !playwrightmcp.HasTool(name) {
		return nil, fmt.Errorf("playwright tool %q is not exposed", name)
	}

	select {
	case b.slot <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-b.slot }()
	if b.session == nil {
		if err := b.start(ctx); err != nil {
			return nil, err
		}
	}

	result, err := b.session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: arguments})
	if err != nil {
		// A caller that gave up says nothing about the host; only transport and protocol errors do.
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
		"--output-dir", files.Outputs,
		// Where the host finds the compositor and the surface of each browser target.
		"--compositor-socket", b.controlSocket,
		"--targets-url", "http://127.0.0.1:" + strconv.Itoa(b.values.WrapperPort) + "/targets",
	}
	if capabilities := playwrightmcp.RuntimeCapabilities(); len(capabilities) > 0 {
		args = append(args, "--caps", strings.Join(capabilities, ","))
	}
	command := exec.Command("aperture-browser-mcp", args...)
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
		return fmt.Errorf("start browser MCP host: %w", err)
	}
	b.session = session
	return nil
}

func (b *playwrightMCPBackend) Close() {
	b.slot <- struct{}{}
	defer func() { <-b.slot }()
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

	result, err := r.playwright.Call(req.Context(), call.Name, call.Arguments)
	if err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: Playwright MCP tool %s failed: %v\n", call.Name, err)
		writeWrapperError(w, http.StatusBadGateway, "Playwright MCP call failed")
		return
	}
	writeWrapperJSON(w, http.StatusOK, result)
}
