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
	"sync"
	"time"

	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/playwrightmcp"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const playwrightCallRequestMaxBytes = 16 << 20

type playwrightMCPBackend struct {
	values  RuntimeEnvValues
	mu      sync.Mutex
	session *mcp.ClientSession
}

type playwrightCallRequest struct {
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
	// Caption is text for the recording's video to show while the tool runs. The
	// daemon takes it out of the tool's arguments, which Playwright would reject.
	Caption string `json:"caption,omitempty"`
}

func newPlaywrightMCPBackend(values RuntimeEnvValues) *playwrightMCPBackend {
	return &playwrightMCPBackend{values: values}
}

// Call invokes any tool of the bundled Playwright MCP. It does not apply the
// client-facing tool gate: wrapper code uses it for tools Aperture hides from
// clients, such as the pointer tools behind the CDP fallback. Client calls must
// go through handlePlaywrightCall.
func (b *playwrightMCPBackend) Call(ctx context.Context, name string, arguments map[string]any) (*mcp.CallToolResult, error) {
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

	if err := validateToolCaption(call.Caption); err != nil {
		writeWrapperError(w, http.StatusBadRequest, err.Error())
		return
	}
	started := time.Now()
	result, err := r.playwright.Call(req.Context(), call.Name, call.Arguments)
	r.noteToolCaption(call, started, result, err)
	if err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: Playwright MCP tool %s failed: %v\n", call.Name, err)
		writeWrapperError(w, http.StatusBadGateway, "Playwright MCP call failed")
		return
	}
	writeWrapperJSON(w, http.StatusOK, result)
}
