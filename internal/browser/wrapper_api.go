package browser

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const viewportScaleDenominator = 120

type compositorViewport struct {
	Width             int
	Height            int
	ScaleNumerator    int
	PhysicalWidth     int
	PhysicalHeight    int
	DeviceScaleFactor float64
}

type wrapperRuntime struct {
	values         RuntimeEnvValues
	controlSocket  string
	ctx            context.Context
	mu             sync.Mutex
	uploadMu       sync.Mutex
	compositorPID  int
	pipewireTarget string
	screencast     *wrapperScreencast
	lastScreencast *wrapperScreencastFile
	mediaProducer  *producer
	viewer         *wrapperViewer
}

type wrapperScreencast struct {
	cmd       *exec.Cmd
	done      <-chan error
	path      string
	startedAt time.Time
	fps       int
	codec     string
}

type wrapperScreencastFile struct {
	path      string
	stoppedAt time.Time
	sizeBytes int64
}

type wrapperScreencastRequest struct {
	FPS         int    `json:"fps"`
	BitrateKbps int    `json:"bitrateKbps"`
	Codec       string `json:"codec"`
	Path        string `json:"path"`
}

type wrapperViewer struct {
	cancel context.CancelFunc
}

func newWrapperRuntime(values RuntimeEnvValues, controlSocket string) *wrapperRuntime {
	return &wrapperRuntime{
		values:        values,
		controlSocket: controlSocket,
		ctx:           context.Background(),
	}
}

func (r *wrapperRuntime) setCaptureTarget(target string, compositorPID int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pipewireTarget = target
	r.compositorPID = compositorPID
}

func (r *wrapperRuntime) setMediaProducer(mediaProducer *producer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.mediaProducer = mediaProducer
}

func (r *wrapperRuntime) currentMediaProducer() *producer {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.mediaProducer
}

func (r *wrapperRuntime) claimViewer(viewer *wrapperViewer) {
	r.mu.Lock()
	previous := r.viewer
	r.viewer = viewer
	r.mu.Unlock()
	if previous != nil {
		previous.cancel()
	}
}

func (r *wrapperRuntime) releaseViewer(viewer *wrapperViewer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.viewer == viewer {
		r.viewer = nil
	}
}

func (r *wrapperRuntime) disconnectViewer() {
	r.mu.Lock()
	viewer := r.viewer
	r.viewer = nil
	r.mu.Unlock()
	if viewer != nil {
		viewer.cancel()
	}
}

func (r *wrapperRuntime) serve(ctx context.Context) (*http.Server, <-chan error, error) {
	if r.values.WrapperPort <= 0 {
		return nil, nil, fmt.Errorf("wrapper port is required")
	}
	r.ctx = ctx
	if err := r.watchCDPToken(ctx); err != nil {
		return nil, nil, err
	}
	if err := r.reconcilePendingUploads(); err != nil {
		return nil, nil, fmt.Errorf("reconcile pending uploads: %w", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/{$}", r.handleCDPDiscovery)
	mux.HandleFunc("/health", r.handleHealth)
	mux.HandleFunc("/status", r.handleStatus)
	mux.HandleFunc("/sessions/", r.handleCDPDiscovery)
	mux.HandleFunc("/json", r.handleCDPDiscovery)
	mux.HandleFunc("/json/", r.handleCDPDiscovery)
	mux.HandleFunc("/webrtc/signal", r.handleSignal)
	mux.HandleFunc("/viewport", r.handleViewport)
	mux.HandleFunc("/screencast/start", r.handleScreencastStart)
	mux.HandleFunc("/screencast/stop", r.handleScreencastStop)
	mux.HandleFunc("/screencast/status", r.handleScreencastStatus)
	mux.HandleFunc("/files", r.handleFiles)
	mux.HandleFunc("/files/", r.handleFileDownload)
	mux.HandleFunc("/uploads", r.handleUploads)

	server := &http.Server{Handler: mux}
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(r.values.WrapperPort)))
	if err != nil {
		return nil, nil, fmt.Errorf("listen wrapper api: %w", err)
	}
	done := make(chan error, 1)
	go func() {
		err := server.Serve(listener)
		if err != nil && err != http.ErrServerClosed {
			done <- err
			return
		}
		done <- nil
	}()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	return server, done, nil
}

func (r *wrapperRuntime) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeWrapperJSON(w, http.StatusOK, map[string]any{"status": "ok", "sessionId": r.values.SessionID, "gpuMode": r.values.GPUMode, "mediaCodec": r.values.MediaProducerCodec})
}

func (r *wrapperRuntime) handleStatus(w http.ResponseWriter, _ *http.Request) {
	r.mu.Lock()
	defer r.mu.Unlock()
	status := map[string]any{
		"sessionId":      r.values.SessionID,
		"compositor":     r.values.CompositorEnabled,
		"compositorPid":  r.compositorPID,
		"pipewireTarget": r.pipewireTarget,
		"browserCDPPort": r.values.CDPPort,
		"gpuMode":        r.values.GPUMode,
		"mediaCodec":     r.values.MediaProducerCodec,
		"screencast":     r.screencastStatusLocked(),
	}
	if r.mediaProducer != nil {
		quality := r.mediaProducer.media.Quality()
		status["mediaQuality"] = map[string]any{
			"profile":     quality.Profile,
			"option":      quality.Option,
			"width":       quality.Width,
			"height":      quality.Height,
			"framerate":   quality.Framerate,
			"bitrateKbps": quality.BitrateKbps,
		}
		status["mediaProfiles"] = r.mediaProducer.profiles
		status["mediaKeyframeInterval"] = r.values.MediaProducerKeyframe
	}
	if r.values.RenderNode != "" {
		status["renderNode"] = r.values.RenderNode
	}
	if r.values.ExternalBaseURL != "" {
		status["cdpUrl"] = strings.TrimRight(r.values.ExternalBaseURL, "/") + "/sessions/" + r.values.SessionID + "/cdp"
	}
	iceServers := make([]struct {
		URLs       []string `json:"urls"`
		Username   string   `json:"username,omitempty"`
		Credential string   `json:"credential,omitempty"`
	}, 0)
	if r.values.MediaProducerICEServers != "" {
		if err := json.Unmarshal([]byte(r.values.MediaProducerICEServers), &iceServers); err != nil {
			writeWrapperError(w, http.StatusInternalServerError, "media ICE servers unavailable")
			return
		}
	}
	mediaMode := "cdp"
	if r.values.MediaProducerEnabled {
		mediaMode = "auto"
	}
	status["media"] = map[string]any{
		"mode":           mediaMode,
		"webrtcProducer": r.values.MediaProducerEnabled,
		"iceServers":     iceServers,
	}
	writeWrapperJSON(w, http.StatusOK, status)
}

func (r *wrapperRuntime) handleViewport(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Width             int     `json:"width"`
		Height            int     `json:"height"`
		DeviceScaleFactor float64 `json:"deviceScaleFactor"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeWrapperError(w, http.StatusBadRequest, "invalid viewport request")
		return
	}
	viewport, err := resizeCompositor(req.Context(), r.controlSocket, body.Width, body.Height, body.DeviceScaleFactor)
	if err == nil {
		if mediaProducer := r.currentMediaProducer(); mediaProducer != nil {
			err = mediaProducer.setViewport(viewport)
		}
	}
	if err != nil {
		writeWrapperError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeWrapperJSON(w, http.StatusOK, viewportMetadata(viewport))
}

func (r *wrapperRuntime) handleSignal(w http.ResponseWriter, req *http.Request) {
	mediaProducer := r.currentMediaProducer()
	if mediaProducer == nil {
		writeWrapperError(w, http.StatusConflict, "media producer is not enabled")
		return
	}
	ctx, cancel := context.WithCancel(req.Context())
	defer cancel()
	viewer := &wrapperViewer{cancel: cancel}
	r.claimViewer(viewer)
	defer r.releaseViewer(viewer)
	mediaProducer.Handler().ServeHTTP(w, req.WithContext(ctx))
}

func (r *wrapperRuntime) handleScreencastStart(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body wrapperScreencastRequest
	if req.Body != nil {
		_ = json.NewDecoder(req.Body).Decode(&body)
	}
	if req.Header.Get("X-Aperture-Actor-Kind") == "session_capability" {
		body.Path = ""
	}
	status, err := r.startScreencast(body)
	if err != nil {
		writeWrapperError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeWrapperJSON(w, http.StatusOK, status)
}

func (r *wrapperRuntime) handleScreencastStop(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	file, err := r.stopScreencast()
	if err != nil {
		writeWrapperError(w, http.StatusConflict, err.Error())
		return
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(file.path)))
	w.Header().Set("Content-Type", "video/webm")
	http.ServeFile(w, req, file.path)
}

func (r *wrapperRuntime) handleScreencastStatus(w http.ResponseWriter, _ *http.Request) {
	r.mu.Lock()
	defer r.mu.Unlock()
	writeWrapperJSON(w, http.StatusOK, r.screencastStatusLocked())
}

func (r *wrapperRuntime) startScreencast(request wrapperScreencastRequest) (map[string]any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.screencast != nil {
		return nil, fmt.Errorf("screencast already active")
	}
	if strings.TrimSpace(r.pipewireTarget) == "" {
		return nil, fmt.Errorf("pipewire target is not ready")
	}
	fps := request.FPS
	if fps <= 0 {
		fps = r.values.MediaProducerFPS
	}
	if fps <= 0 {
		fps = 60
	}
	bitrateKbps := request.BitrateKbps
	if bitrateKbps <= 0 {
		bitrateKbps = r.values.MediaProducerBitrateKbps
	}
	if bitrateKbps <= 0 {
		bitrateKbps = 6000
	}
	codec := normalizeWrapperCodec(request.Codec, r.values.MediaProducerCodec)
	path := strings.TrimSpace(request.Path)
	if path == "" {
		path = filepath.Join(r.values.ArtifactsDir, "screencast-"+time.Now().UTC().Format("20060102T150405Z")+".webm")
	}
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("screencast path must be absolute")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("mkdir screencast dir: %w", err)
	}
	cmd, done, err := startWrapperScreencast(r.ctx, r.values, r.pipewireTarget, path, fps, bitrateKbps, codec)
	if err != nil {
		return nil, err
	}
	r.screencast = &wrapperScreencast{
		cmd:       cmd,
		done:      done,
		path:      path,
		startedAt: time.Now().UTC(),
		fps:       fps,
		codec:     codec,
	}
	return r.screencastStatusLocked(), nil
}

func (r *wrapperRuntime) stopScreencast() (*wrapperScreencastFile, error) {
	r.mu.Lock()
	active := r.screencast
	r.screencast = nil
	r.mu.Unlock()
	if active == nil {
		return nil, fmt.Errorf("screencast is not active")
	}
	if active.cmd.Process != nil && active.cmd.ProcessState == nil {
		_ = active.cmd.Process.Signal(syscall.SIGINT)
		timer := time.NewTimer(5 * time.Second)
		select {
		case <-active.done:
		case <-timer.C:
			_ = active.cmd.Process.Kill()
			<-active.done
		}
		timer.Stop()
	}
	sizeBytes := int64(0)
	if info, err := os.Stat(active.path); err == nil {
		sizeBytes = info.Size()
	}
	if sizeBytes <= 0 {
		return nil, fmt.Errorf("screencast is empty")
	}
	stoppedAt := time.Now().UTC()
	r.mu.Lock()
	r.lastScreencast = &wrapperScreencastFile{
		path:      active.path,
		stoppedAt: stoppedAt,
		sizeBytes: sizeBytes,
	}
	file := r.lastScreencast
	r.mu.Unlock()
	return file, nil
}

func (r *wrapperRuntime) screencastStatusLocked() map[string]any {
	if r.screencast == nil {
		status := map[string]any{"active": false}
		if file := r.screencastFileLocked(); file != nil {
			status["path"] = file.path
			status["stoppedAt"] = file.stoppedAt.Format(time.RFC3339Nano)
			status["sizeBytes"] = file.sizeBytes
		}
		return status
	}
	return map[string]any{
		"active":    true,
		"path":      r.screencast.path,
		"startedAt": r.screencast.startedAt.Format(time.RFC3339Nano),
		"fps":       r.screencast.fps,
		"codec":     r.screencast.codec,
	}
}

func (r *wrapperRuntime) screencastFileLocked() *wrapperScreencastFile {
	if r.lastScreencast != nil {
		return r.lastScreencast
	}
	matches, err := filepath.Glob(filepath.Join(r.values.ArtifactsDir, "screencast-*.webm"))
	if err != nil {
		return nil
	}
	var latest *wrapperScreencastFile
	for _, path := range matches {
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 {
			continue
		}
		if latest == nil || info.ModTime().After(latest.stoppedAt) {
			latest = &wrapperScreencastFile{
				path:      path,
				stoppedAt: info.ModTime().UTC(),
				sizeBytes: info.Size(),
			}
		}
	}
	r.lastScreencast = latest
	return latest
}

func startWrapperScreencast(ctx context.Context, values RuntimeEnvValues, target string, path string, fps int, bitrateKbps int, codec string) (*exec.Cmd, <-chan error, error) {
	keepaliveMS := 1000 / fps
	args := []string{
		"pipewiresrc",
		"target-object=" + target,
		"do-timestamp=true",
		"keepalive-time=" + strconv.Itoa(keepaliveMS),
		"!",
		"queue",
		"max-size-buffers=1",
		"leaky=downstream",
		"!",
		"videorate",
		"drop-only=true",
		"!",
		fmt.Sprintf("video/x-raw,framerate=%d/1", fps),
		"!",
		"queue",
		"max-size-buffers=1",
		"leaky=downstream",
		"!",
	}
	args = append(args, wrapperRecordingPipeline(codec, bitrateKbps, values.MediaProducerKeyframe)...)
	args = append(args, "!", "filesink", "location="+path, "sync=false")
	cmd := exec.CommandContext(ctx, values.MediaProducerGSTExecutable, args...)
	cmd.Env = wrapperMediaProcessEnv(values.MediaProducerPluginPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, nil, fmt.Errorf("start screencast pipeline: %w", err)
	}
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()
	return cmd, done, nil
}

func wrapperRecordingPipeline(codec string, bitrateKbps int, keyframe int) []string {
	if keyframe <= 0 {
		keyframe = 120
	}
	if codec == "h264-va" {
		return []string{
			"vapostproc",
			"!",
			"video/x-raw(memory:VAMemory),format=NV12",
			"!",
			"vah264enc",
			"bitrate=" + strconv.Itoa(bitrateKbps),
			"rate-control=vcm",
			"key-int-max=" + strconv.Itoa(keyframe),
			"target-usage=7",
			"ref-frames=1",
			"cabac=false",
			"!",
			"h264parse",
			"!",
			"matroskamux",
		}
	}
	return []string{
		"videoconvert",
		"!",
		"vp8enc",
		"deadline=1",
		"keyframe-max-dist=" + strconv.Itoa(keyframe),
		"cpu-used=8",
		"target-bitrate=" + strconv.Itoa(bitrateKbps*1000),
		"!",
		"webmmux",
	}
}

func normalizeWrapperCodec(requested string, fallback string) string {
	switch strings.TrimSpace(requested) {
	case "h264-va", "vp8":
		return strings.TrimSpace(requested)
	}
	switch strings.TrimSpace(fallback) {
	case "h264-va":
		return "h264-va"
	default:
		return "vp8"
	}
}

func wrapperMediaProcessEnv(pluginPath string) []string {
	env := make([]string, 0, 6)
	for _, key := range []string{"XDG_RUNTIME_DIR", "PIPEWIRE_REMOTE", "DBUS_SESSION_BUS_ADDRESS", "LIBVA_DRIVER_NAME", "LIBVA_DRIVERS_PATH", "NVIDIA_VISIBLE_DEVICES"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			env = append(env, key+"="+value)
		}
	}
	if strings.TrimSpace(pluginPath) != "" {
		env = append(env, "GST_PLUGIN_SYSTEM_PATH_1_0="+pluginPath)
	}
	return env
}

func resizeCompositor(ctx context.Context, socketPath string, width int, height int, deviceScaleFactor float64) (compositorViewport, error) {
	scaleNumerator := viewportScaleNumerator(deviceScaleFactor)
	if width <= 0 || height <= 0 || width > 16384 || height > 16384 {
		return compositorViewport{}, fmt.Errorf("invalid viewport resize %dx%d", width, height)
	}
	response, err := sendCompositorControlCommand(
		ctx,
		socketPath,
		fmt.Sprintf("resize %d %d %d\n", width, height, scaleNumerator),
	)
	if err != nil {
		return compositorViewport{}, err
	}
	if !strings.HasPrefix(response, "ok ") {
		return compositorViewport{}, fmt.Errorf("compositor resize rejected: %s", response)
	}
	viewport := compositorViewport{}
	if _, err := fmt.Sscanf(
		response,
		"ok %d %d %d %d %d",
		&viewport.Width,
		&viewport.Height,
		&viewport.ScaleNumerator,
		&viewport.PhysicalWidth,
		&viewport.PhysicalHeight,
	); err != nil {
		return compositorViewport{}, fmt.Errorf("parse compositor resize response %q: %w", response, err)
	}
	viewport.DeviceScaleFactor = float64(viewport.ScaleNumerator) / viewportScaleDenominator
	return viewport, nil
}

func viewportScaleNumerator(deviceScaleFactor float64) int {
	if deviceScaleFactor <= 0 || math.IsNaN(deviceScaleFactor) || math.IsInf(deviceScaleFactor, 0) {
		return viewportScaleDenominator
	}
	return int(math.Round(deviceScaleFactor * viewportScaleDenominator))
}

func viewportMetadata(viewport compositorViewport) map[string]any {
	return map[string]any{
		"width":             viewport.Width,
		"height":            viewport.Height,
		"deviceScaleFactor": viewport.DeviceScaleFactor,
		"physicalWidth":     viewport.PhysicalWidth,
		"physicalHeight":    viewport.PhysicalHeight,
	}
}

func sendCompositorControlCommand(ctx context.Context, socketPath string, command string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
	if err != nil {
		return "", fmt.Errorf("dial compositor control socket: %w", err)
	}
	defer conn.Close()

	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	if _, err := conn.Write([]byte(command)); err != nil {
		return "", fmt.Errorf("send compositor control command: %w", err)
	}
	response, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		return "", fmt.Errorf("read compositor control response: %w", err)
	}
	response = strings.TrimSpace(response)
	if !strings.HasPrefix(response, "ok") {
		return "", fmt.Errorf("compositor control rejected: %s", response)
	}
	return response, nil
}

func writeWrapperJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeWrapperError(w http.ResponseWriter, status int, message string) {
	writeWrapperJSON(w, status, map[string]any{"error": message})
}

func headerHasProtocol(header string, protocol string) bool {
	for _, part := range strings.Split(header, ",") {
		if strings.TrimSpace(part) == protocol {
			return true
		}
	}
	return false
}
