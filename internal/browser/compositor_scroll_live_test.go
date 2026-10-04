package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/recording"
	"github.com/chromedp/cdproto/runtime"
	"github.com/coder/websocket"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Run with APERTURE_TEST_PACKAGE pointing at a Nix-built Aperture package. The test owns its
// compositor, PipeWire core and Chromium profile; it never connects to the user's desktop.
func TestLiveCompositorScrollPixelCorrespondence(t *testing.T) {
	packageDir := os.Getenv("APERTURE_TEST_PACKAGE")
	if packageDir == "" {
		t.Skip("set APERTURE_TEST_PACKAGE to run isolated compositor verification")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	// Unix socket paths include the remote name and must fit in sockaddr_un.
	root, err := os.MkdirTemp("/tmp", "ap-scroll-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if t.Failed() {
			logs, _ := filepath.Glob(filepath.Join(root, "process-*.log"))
			for _, path := range logs {
				body, _ := os.ReadFile(path)
				t.Logf("%s: %s", filepath.Base(path), body)
			}
		}
		_ = os.RemoveAll(root)
	})
	t.Setenv("XDG_RUNTIME_DIR", root)
	t.Setenv("WAYLAND_DISPLAY", "scroll-test")
	t.Setenv("PIPEWIRE_REMOTE", sessionPipeWireRemote("scroll-test"))
	pipewire, pwDone, err := startSessionPipeWire(root, "scroll-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopProcess(pipewire, pwDone) })
	control := filepath.Join(root, "control")
	t.Setenv("APERTURE_CONTROL_SOCKET", control)
	start := func(cmd *exec.Cmd) <-chan error {
		t.Helper()
		log, err := os.CreateTemp(root, "process-*.log")
		if err != nil {
			t.Fatal(err)
		}
		cmd.Stdout, cmd.Stderr = log, log
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait(); _ = log.Close() }()
		t.Cleanup(func() { stopProcess(cmd, done) })
		return done
	}
	weston := exec.CommandContext(ctx, "weston", "--backend=pipewire", "--renderer=pixman", "--shell="+filepath.Join(packageDir, "lib/weston/aperture-weston-shell.so"), "--socket=scroll-test", "--width=1280", "--height=720", "--idle-time=0", "--no-config")
	westonDone := start(weston)
	if err := waitForWaylandSocket(filepath.Join(root, "scroll-test"), westonDone); err != nil {
		t.Fatal(err)
	}
	command := func(line string) string {
		t.Helper()
		response, err := sendCompositorControlCommand(ctx, control, line+"\n")
		if err != nil {
			t.Fatalf("%s: %v", line, err)
		}
		return response
	}
	command("output-create scroll 1280 768")
	command("surface-prepare scroll-page")
	port, err := allocateTestPort()
	if err != nil {
		t.Fatal(err)
	}
	chromium, err := exec.LookPath("chromium")
	if err != nil {
		t.Fatal(err)
	}
	start(exec.CommandContext(ctx, chromium, "--no-sandbox", "--no-first-run", "--disable-dev-shm-usage", "--ozone-platform=wayland", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--kiosk", "--user-data-dir="+filepath.Join(root, "profile"), fmt.Sprintf("--remote-debugging-port=%d", port), "data:text/html,<body style='margin:0'><div style='height:5000px'>Scroll pixels</div>"))
	var surface uint64
	for ctx.Err() == nil {
		response, err := sendCompositorControlCommand(ctx, control, "surface-find scroll-page\n")
		if err == nil {
			_, _ = fmt.Sscanf(response, "ok %d", &surface)
			if surface != 0 {
				break
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	if surface == 0 {
		t.Fatal("Chromium surface did not appear")
	}
	command(fmt.Sprintf("surface-bind %d scroll 1280 720 120", surface))
	r := newWrapperRuntime(RuntimeEnvValues{CDPPort: port}, control)
	r.ctx = ctx
	browser := newLiveSessionBrowser(r)
	t.Cleanup(browser.close)
	targets, err := browser.targets()
	if err != nil || len(targets) == 0 {
		t.Fatalf("targets %v, %v", targets, err)
	}
	targetID := targets[0].ID
	for ctx.Err() == nil {
		var height int
		err := browser.withTarget(targetID, func(ctx context.Context) error {
			result, _, err := runtime.Evaluate("document.body?.scrollHeight ?? 0").WithReturnByValue(true).Do(ctx)
			if err == nil {
				_, err = fmt.Sscanf(string(result.Value), "%d", &height)
			}
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		if height >= 5000 {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if ctx.Err() != nil {
		t.Fatal("scrollable page never loaded")
	}
	time.Sleep(200 * time.Millisecond)
	readY := func() int {
		t.Helper()
		var y int
		err := browser.withTarget(targetID, func(ctx context.Context) error {
			result, exception, err := runtime.Evaluate("scrollY").WithReturnByValue(true).Do(ctx)
			if err != nil {
				return err
			}
			if exception != nil {
				return exception
			}
			_, err = fmt.Sscanf(string(result.Value), "%d", &y)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return y
	}
	if y := readY(); y != 0 {
		t.Fatalf("initial scrollY=%d", y)
	}
	sender := newCompositorInputSender(newCompositorPointer(control), 1280, 720)
	sender.SetTarget(surface, 1280, 720)
	if err := sender.PointerAbsolute(0.5, 0.5); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	for _, step := range []struct {
		delta float64
		y     int
	}{{100, 100}, {1, 101}, {-1, 100}, {-100, 0}} {
		if err := sender.Scroll(0, step.delta, false, false); err != nil {
			t.Fatal(err)
		}
		// Chromium's wheel scroll animates. Check final CSS pixels after it settles.
		time.Sleep(600 * time.Millisecond)
		if y := readY(); y != step.y {
			t.Fatalf("%gpx human scroll moved scrollY to %d, want %d", step.delta, y, step.y)
		}
	}
	t.Run("new-tab-first-picture", func(t *testing.T) {
		verifyNewTabCapture(t, ctx, root, r, browser, targetID, surface, weston.Process.Pid)
	})
}

func verifyNewTabCapture(t *testing.T, ctx context.Context, root string, r *wrapperRuntime, browser *liveSessionBrowser, oldTarget string, oldSurface uint64, compositorPID int) {
	plugins := os.Getenv("APERTURE_TEST_GST_PLUGIN_PATH")
	if plugins == "" {
		t.Skip("set APERTURE_TEST_GST_PLUGIN_PATH for live recording verification")
	}
	configDir := filepath.Join(root, "config")
	wpConfig := filepath.Join(configDir, "wireplumber", "wireplumber.conf.d")
	if err := os.MkdirAll(wpConfig, 0700); err != nil {
		t.Fatal(err)
	}
	config := []byte("wireplumber.profiles = { main = { monitor.alsa = disabled monitor.alsa-midi = disabled monitor.bluez = disabled monitor.bluez-midi = disabled monitor.v4l2 = disabled monitor.libcamera = disabled } }\n")
	if err := os.WriteFile(filepath.Join(wpConfig, "90-recording-test.conf"), config, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_CONFIG_HOME", configDir)
	wp, wpDone, err := startSessionWirePlumber("scroll-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stopProcess(wp, wpDone)
		t.Logf("WirePlumber teardown: %v", wp.ProcessState)
	})
	gst, err := exec.LookPath("gst-launch-1.0")
	if err != nil {
		t.Fatal(err)
	}
	r.values.FilesDir = filepath.Join(root, "files")
	r.values.MediaProducerGSTExecutable = gst
	r.values.MediaProducerPluginPath = plugins
	r.values.RecordingFFmpegExecutable = ffmpegForTest(t)
	viewport := compositorViewport{Width: 1280, Height: 720, ContentWidth: 1280, ContentHeight: 720, CanvasWidth: 1280, CanvasHeight: 768, ScaleNumerator: 120}
	registry := newWrapperTargetRegistry(r, r.controlSocket, "", compositorPID)
	oldNode, err := ResolvePipeWireNodeTarget("weston.aperture-scroll", compositorPID)
	if err != nil {
		t.Fatal(err)
	}
	registry.targets[oldTarget] = wrapperTargetSnapshot{TargetID: oldTarget, SurfaceID: oldSurface, CaptureID: "scroll", PipeWireTarget: oldNode, State: wrapperTargetReady, Generation: 1, Viewport: viewport}
	r.targets = registry
	session := &liveSession{runtime: r, browser: browser, recordings: map[string]*wrapperRecording{}, gate: make(chan struct{}, 1)}
	status, err := session.startRecording(wrapperRecordingRequest{Mode: wrapperRecordingModeTab, TargetID: oldTarget, FPS: 30, Config: recording.Config{Capture: recording.CaptureBursts}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = session.cancelRecording(status.ID) })
	if _, err := sendCompositorControlCommand(ctx, r.controlSocket, "surface-prepare next-page\n"); err != nil {
		t.Fatal(err)
	}
	proxy := newCDPProxy(fmt.Sprintf("127.0.0.1:%d", r.values.CDPPort), func() automationCadence { return cadenceImmediate }, nil, session.journal, func() bool { return true })
	proxy.following = session.followsAutomation
	proxy.navigateTarget = browser.navigate
	proxy.prepareTarget = func(ctx context.Context, targetID string) error {
		if _, ready := registry.readyTarget(targetID); ready {
			return session.prepareRecordingTarget(ctx, targetID)
		}
		var surface uint64
		for ctx.Err() == nil {
			response, err := sendCompositorControlCommand(ctx, r.controlSocket, "surface-find next-page\n")
			if err == nil {
				_, _ = fmt.Sscanf(response, "ok %d", &surface)
				if surface != 0 {
					break
				}
			}
			time.Sleep(25 * time.Millisecond)
		}
		if surface == 0 {
			return fmt.Errorf("new surface: %w", ctx.Err())
		}
		output, err := registry.createOutput(ctx, "next", viewport)
		if err != nil {
			return err
		}
		if _, err := sendCompositorControlCommand(ctx, r.controlSocket, fmt.Sprintf("surface-bind %d next 1280 720 120\n", surface)); err != nil {
			return err
		}
		if err := registry.waitForSurface(ctx, surface, "next", output.Viewport); err != nil {
			return err
		}
		registry.mu.Lock()
		registry.targets[targetID] = wrapperTargetSnapshot{TargetID: targetID, SurfaceID: surface, CaptureID: "next", PipeWireTarget: output.PipeWireTarget, State: wrapperTargetReady, Generation: 1, Viewport: viewport}
		registry.mu.Unlock()
		return session.prepareRecordingTarget(ctx, targetID)
	}
	endpoint, err := proxy.serve(ctx)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Get(endpoint + "/json/version")
	if err != nil {
		t.Fatal(err)
	}
	var version struct {
		URL string `json:"webSocketDebuggerUrl"`
	}
	err = json.NewDecoder(response.Body).Decode(&version)
	_ = response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	client, _, err := websocket.Dial(ctx, version.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = client.CloseNow() }()
	// The first red picture exists for only 150 ms, shorter than the old asynchronous follow loss.
	url := "data:text/html,<body style='margin:0;background:red'><script>setTimeout(()=>document.body.style.background='blue',150)</script>"
	raw, _ := json.Marshal(map[string]any{"id": 1, "method": "Target.createTarget", "params": map[string]any{"url": url, "newWindow": true}})
	started := time.Now()
	var created struct {
		TargetID string `json:"targetId"`
	}
	if err := client.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatal(err)
	}
	for {
		_, raw, err := client.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var reply cdpMessage
		if err := json.Unmarshal(raw, &reply); err != nil {
			t.Fatal(err)
		}
		if reply.ID != nil && *reply.ID == 1 {
			if len(reply.Error) > 0 {
				t.Fatalf("create tab: %s", reply.Error)
			}
			if err := json.Unmarshal(reply.Result, &created); err != nil {
				t.Fatal(err)
			}
			break
		}
	}
	session.journal("call", started, map[string]any{"tool": "browser_tabs", "ok": true})
	time.Sleep(500 * time.Millisecond)
	verifyPlaywrightTabFollowing(t, ctx, r, proxy, endpoint, session, status.ID, oldTarget, created.TargetID)
	status, err = session.stopRecordingRequested(status.ID, "requested")
	if err != nil {
		t.Fatal(err)
	}
	pixels, err := exec.Command(r.values.RecordingFFmpegExecutable, "-hide_banner", "-loglevel", "error", "-i", status.Path, "-vf", "format=rgb24,crop=1:1:200:200", "-pix_fmt", "rgb24", "-f", "rawvideo", "-").Output()
	if err != nil {
		t.Fatal(err)
	}
	red, blue := false, false
	for i := 0; i+2 < len(pixels); i += 3 {
		red = red || pixels[i] > 180 && pixels[i+2] < 60
		blue = blue || pixels[i+2] > 180 && pixels[i] < 60
	}
	if !red || !blue {
		t.Fatalf("new tab's initial 150ms picture lost: red=%v blue=%v (%d frames)", red, blue, len(pixels)/3)
	}
}

func verifyPlaywrightTabFollowing(t *testing.T, ctx context.Context, r *wrapperRuntime, proxy *cdpProxy, endpoint string, session *liveSession, recordingID, oldTarget, newTarget string) {
	t.Helper()
	t.Setenv("PATH", filepath.Join(os.Getenv("APERTURE_TEST_PACKAGE"), "bin")+":"+os.Getenv("PATH"))
	backend := newPlaywrightMCPBackend(r.values, endpoint)
	backend.proxy = proxy
	t.Cleanup(backend.Close)
	call := func(tool string, args map[string]any, wantTarget string) *mcp.CallToolResult {
		t.Helper()
		result, err := backend.Call(ctx, tool, args)
		if err != nil || result.IsError {
			t.Fatalf("%s: result=%+v error=%v", tool, result, err)
		}
		r.mu.Lock()
		gotTarget := session.recordings[recordingID].TargetID
		r.mu.Unlock()
		if gotTarget != wantTarget {
			t.Fatalf("%s moved capture to %s, want %s", tool, gotTarget, wantTarget)
		}
		return result
	}
	listed := call("browser_tabs", map[string]any{"action": "list"}, newTarget)
	oldIndex := -1
	for _, content := range listed.Content {
		if content, ok := content.(*mcp.TextContent); ok {
			for _, line := range strings.Split(content.Text, "\n") {
				if strings.Contains(line, "5000px") {
					_, _ = fmt.Sscanf(line, "- %d:", &oldIndex)
				}
			}
		}
	}
	if oldIndex < 0 || oldIndex > 1 {
		t.Fatalf("could not identify scroll page in tab list: %+v", listed)
	}
	newIndex := 1 - oldIndex
	call("browser_tabs", map[string]any{"action": "select", "index": oldIndex}, oldTarget)
	call("browser_evaluate", map[string]any{"function": "() => { document.body.style.background = 'green'; document.body.insertAdjacentHTML('beforeend', '<select id=choice><option value=one>One</option><option value=two>Two</option></select><input id=date type=date>'); }"}, oldTarget)
	retarget := func() {
		t.Helper()
		if _, err := session.retargetRecording(ctx, recordingID, newTarget); err != nil {
			t.Fatal(err)
		}
	}
	retarget()
	call("browser_select_option", map[string]any{"target": "#choice", "values": []string{"two"}}, oldTarget)
	retarget()
	call("browser_type", map[string]any{"target": "#date", "text": "2026-10-04"}, oldTarget)
	var value string
	if err := session.browser.withTarget(oldTarget, func(ctx context.Context) error {
		result, _, err := runtime.Evaluate("document.querySelector('#choice').value + ':' + document.querySelector('#date').value").WithReturnByValue(true).Do(ctx)
		if err == nil {
			err = json.Unmarshal(result.Value, &value)
		}
		return err
	}); err != nil || value != "two:2026-10-04" {
		t.Fatalf("form actions value=%q error=%v", value, err)
	}
	call("browser_tabs", map[string]any{"action": "select", "index": newIndex}, newTarget)
	call("browser_tabs", map[string]any{"action": "list"}, newTarget)
	call("browser_tabs", map[string]any{"action": "close", "index": newIndex}, newTarget)
	call("browser_evaluate", map[string]any{"function": "() => document.body.style.background = 'purple'"}, oldTarget)
}
