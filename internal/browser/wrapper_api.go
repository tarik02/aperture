package browser

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	viewportScaleDenominator = 120
	viewportMinimumWidth     = 500
	mediaCanvasBucketSize    = 64
)

type compositorViewport struct {
	Width             int     `json:"width"`
	Height            int     `json:"height"`
	ScaleNumerator    int     `json:"-"`
	ContentWidth      int     `json:"contentWidth"`
	ContentHeight     int     `json:"contentHeight"`
	CanvasWidth       int     `json:"canvasWidth"`
	CanvasHeight      int     `json:"canvasHeight"`
	DeviceScaleFactor float64 `json:"deviceScaleFactor"`
}

type wrapperRuntime struct {
	values           RuntimeEnvValues
	controlSocket    string
	ctx              context.Context
	mu               sync.Mutex
	uploadMu         sync.Mutex
	compositorPID    int
	recordings       map[string]*wrapperRecording
	recordingClients map[string]*wrapperRecordingClient
	mediaProducer    *producer
	targets          *wrapperTargetRegistry
	viewers          map[*wrapperViewer]struct{}
	activeRequests   int
	cdpConnections   int
}

func (r *wrapperRuntime) setTargetRegistry(registry *wrapperTargetRegistry) {
	r.mu.Lock()
	r.targets = registry
	r.compositorPID = registry.compositorPID
	r.mu.Unlock()
}

func (r *wrapperRuntime) targetReady(ctx context.Context, target wrapperTargetSnapshot, previous wrapperTargetSnapshot, hadPrevious bool) error {
	if err := r.replaceRecordingTargets(ctx, target); err != nil {
		if hadPrevious {
			if rollbackErr := r.replaceRecordingTargets(context.Background(), previous); rollbackErr != nil {
				r.failRecordingTargets(previous.TargetID, previous.Generation)
				return errors.Join(err, fmt.Errorf("roll back recording capture sources: %w", rollbackErr))
			}
		}
		return err
	}
	mediaProducer := r.currentMediaProducer()
	if mediaProducer != nil {
		if err := mediaProducer.media.SetTarget(ctx, target); err != nil {
			if hadPrevious {
				if rollbackErr := r.replaceRecordingTargets(context.Background(), previous); rollbackErr != nil {
					r.failRecordingTargets(previous.TargetID, previous.Generation)
					return errors.Join(err, fmt.Errorf("roll back recording capture sources: %w", rollbackErr))
				}
			}
			return err
		}
	}
	return nil
}

func (r *wrapperRuntime) targetTransitioning(targetID string) {
	mediaProducer := r.currentMediaProducer()
	if mediaProducer != nil {
		mediaProducer.media.SuspendTarget(targetID)
	}
}

func (r *wrapperRuntime) targetRestored(targetID string) {
	mediaProducer := r.currentMediaProducer()
	if mediaProducer != nil {
		mediaProducer.media.RestoreTarget(targetID)
	}
}

func (r *wrapperRuntime) targetClosed(target wrapperTargetSnapshot) {
	r.stopTargetRecordings(target.TargetID)
	mediaProducer := r.currentMediaProducer()
	if mediaProducer != nil {
		mediaProducer.media.RemoveTarget(target.TargetID)
	}
}

func (r *wrapperRuntime) targetUnavailable(target wrapperTargetSnapshot) {
	mediaProducer := r.currentMediaProducer()
	if mediaProducer != nil {
		mediaProducer.media.RemoveTarget(target.TargetID)
	}
}

type wrapperViewer struct {
	cancel context.CancelFunc
}

// WrapperActivityStatus reports live work that must inhibit idle suspension.
type WrapperActivityStatus struct {
	Active            bool `json:"active"`
	ActiveRequests    int  `json:"activeRequests"`
	ViewerConnected   bool `json:"viewerConnected"`
	CDPConnections    int  `json:"cdpConnections"`
	RecordingsRunning int  `json:"recordingsRunning"`
}

func newWrapperRuntime(values RuntimeEnvValues, controlSocket string) *wrapperRuntime {
	return &wrapperRuntime{
		values:           values,
		controlSocket:    controlSocket,
		ctx:              context.Background(),
		viewers:          make(map[*wrapperViewer]struct{}),
		recordings:       make(map[string]*wrapperRecording),
		recordingClients: make(map[string]*wrapperRecordingClient),
	}
}

func (r *wrapperRuntime) setMediaProducer(mediaProducer *producer) {
	r.mu.Lock()
	r.mediaProducer = mediaProducer
	registry := r.targets
	r.mu.Unlock()
	if registry != nil {
		for _, target := range registry.snapshots() {
			if target.State == wrapperTargetReady {
				_ = mediaProducer.media.SetTarget(r.ctx, target)
			}
		}
	}
}

func (r *wrapperRuntime) currentMediaProducer() *producer {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.mediaProducer
}

func (r *wrapperRuntime) claimViewer(viewer *wrapperViewer) {
	r.mu.Lock()
	r.viewers[viewer] = struct{}{}
	r.mu.Unlock()
}

func (r *wrapperRuntime) releaseViewer(viewer *wrapperViewer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.viewers, viewer)
}

func (r *wrapperRuntime) disconnectConsumers() {
	r.mu.Lock()
	viewers := make([]*wrapperViewer, 0, len(r.viewers))
	for viewer := range r.viewers {
		viewers = append(viewers, viewer)
	}
	r.viewers = make(map[*wrapperViewer]struct{})
	recordingClients := make([]*wrapperRecordingClient, 0, len(r.recordingClients))
	for _, client := range r.recordingClients {
		recordingClients = append(recordingClients, client)
	}
	r.mu.Unlock()
	for _, viewer := range viewers {
		viewer.cancel()
	}
	for _, client := range recordingClients {
		client.cancel()
	}
}

func (r *wrapperRuntime) serve(ctx context.Context) (*http.Server, <-chan error, error) {
	if r.values.WrapperPort <= 0 {
		return nil, nil, fmt.Errorf("wrapper port is required")
	}
	r.ctx = ctx
	if err := r.watchSessionToken(ctx); err != nil {
		return nil, nil, err
	}
	if err := r.reconcilePendingUploads(); err != nil {
		return nil, nil, fmt.Errorf("reconcile pending uploads: %w", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/{$}", r.handleCDPDiscovery)
	mux.HandleFunc("/health", r.handleHealth)
	mux.HandleFunc("/status", r.handleStatus)
	mux.HandleFunc("/activity", r.handleActivity)
	mux.HandleFunc("/sessions/", r.handleCDPDiscovery)
	mux.HandleFunc("/json", r.handleCDPDiscovery)
	mux.HandleFunc("/json/", r.handleCDPDiscovery)
	mux.HandleFunc("/devtools/", r.handleCDPProxy)
	mux.HandleFunc("/webrtc/signal", r.handleSignal)
	mux.HandleFunc("/targets", r.handleTargets)
	mux.HandleFunc("/viewport", r.handleViewport)
	mux.HandleFunc("/quality", r.handleQuality)
	mux.HandleFunc("/recordings", r.handleRecordings)
	mux.HandleFunc("/recordings/client", r.handleRecordingClient)
	mux.HandleFunc("/recordings/", r.handleRecording)
	mux.HandleFunc("/files", r.handleFiles)
	mux.HandleFunc("/files/", r.handleFileDownload)
	mux.HandleFunc("/uploads", r.handleUploads)

	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/health", "/status", "/activity":
			mux.ServeHTTP(w, req)
			return
		}

		r.mu.Lock()
		r.activeRequests++
		r.mu.Unlock()
		defer func() {
			r.mu.Lock()
			r.activeRequests--
			r.mu.Unlock()
		}()
		mux.ServeHTTP(w, req)
	})}
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
		"sessionId": r.values.SessionID,
		"browser": map[string]any{
			"mode": r.values.BrowserMode,
		},
		"capabilities":    CapabilitiesFromRuntime(r.values),
		"compositor":      r.values.CompositorEnabled,
		"compositorPid":   r.compositorPID,
		"browserCDPPort":  r.values.CDPPort,
		"gpuMode":         r.values.GPUMode,
		"mediaCodec":      r.values.MediaProducerCodec,
		"activeRequests":  r.activeRequests,
		"viewerConnected": len(r.viewers) > 0,
		"cdpConnections":  r.cdpConnections,
		"recordings":      r.listRecordingsLocked(),
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
	connection := map[string]any{}
	if r.values.ExternalBaseURL != "" {
		connection["cdpUrl"] = strings.TrimRight(r.values.ExternalBaseURL, "/") + "/sessions/" + r.values.SessionID + "/cdp"
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
	if r.values.MediaProducerEnabled {
		connection["webrtc"] = map[string]any{"iceServers": iceServers}
	}
	if r.targets != nil {
		status["targets"] = r.targets.snapshots()
	}
	if r.values.SessionTokenPath != "" {
		body, err := os.ReadFile(r.values.SessionTokenPath)
		if err != nil {
			writeWrapperError(w, http.StatusInternalServerError, "session token unavailable")
			return
		}
		token := strings.TrimSpace(string(body))
		if token == "" {
			writeWrapperError(w, http.StatusInternalServerError, "session token unavailable")
			return
		}
		connection["sessionToken"] = token
	} else if r.values.SessionToken != "" {
		connection["sessionToken"] = r.values.SessionToken
	}
	status["connection"] = connection
	writeWrapperJSON(w, http.StatusOK, status)
}

func (r *wrapperRuntime) handleActivity(w http.ResponseWriter, _ *http.Request) {
	r.mu.Lock()
	defer r.mu.Unlock()
	writeWrapperJSON(w, http.StatusOK, WrapperActivityStatus{
		Active:            r.activeRequests > 0 || r.activeRecordingCountLocked() > 0,
		ActiveRequests:    r.activeRequests,
		ViewerConnected:   len(r.viewers) > 0,
		CDPConnections:    r.cdpConnections,
		RecordingsRunning: r.activeRecordingCountLocked(),
	})
}

func (r *wrapperRuntime) handleViewport(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		TargetID          string  `json:"targetId"`
		Width             int     `json:"width"`
		Height            int     `json:"height"`
		DeviceScaleFactor float64 `json:"deviceScaleFactor"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeWrapperError(w, http.StatusBadRequest, "invalid viewport request")
		return
	}
	r.mu.Lock()
	registry := r.targets
	r.mu.Unlock()
	if registry == nil {
		writeWrapperError(w, http.StatusConflict, "target registry is unavailable")
		return
	}
	if strings.TrimSpace(body.TargetID) == "" {
		writeWrapperError(w, http.StatusBadRequest, "targetId is required")
		return
	}
	target, err := registry.resizeTarget(req.Context(), body.TargetID, body.Width, body.Height, body.DeviceScaleFactor)
	if err != nil {
		writeWrapperError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeWrapperJSON(w, http.StatusOK, map[string]any{"targetId": target.TargetID, "generation": target.Generation, "viewport": target.Viewport})
}

func (r *wrapperRuntime) handleQuality(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Profile string `json:"profile"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeWrapperError(w, http.StatusBadRequest, "invalid media quality request")
		return
	}
	mediaProducer := r.currentMediaProducer()
	if mediaProducer == nil {
		writeWrapperError(w, http.StatusConflict, "media producer is not enabled")
		return
	}
	profile, exists := mediaProducer.media.Profile(body.Profile)
	if !exists {
		writeWrapperError(w, http.StatusBadRequest, fmt.Sprintf("video profile %q is not configured", body.Profile))
		return
	}
	option, exists := profile.Options[profile.DefaultOption]
	if !exists {
		writeWrapperError(w, http.StatusInternalServerError, fmt.Sprintf("default video option for profile %q is not configured", body.Profile))
		return
	}
	if err := mediaProducer.media.UpdateQuality(option.Quality(body.Profile, profile.DefaultOption)); err != nil {
		writeWrapperError(w, http.StatusBadGateway, err.Error())
		return
	}
	quality := mediaProducer.media.Quality()
	writeWrapperJSON(w, http.StatusOK, map[string]any{
		"profile":     quality.Profile,
		"option":      quality.Option,
		"width":       quality.Width,
		"height":      quality.Height,
		"framerate":   quality.Framerate,
		"bitrateKbps": quality.BitrateKbps,
	})
}

func (r *wrapperRuntime) handleTargets(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	r.mu.Lock()
	registry := r.targets
	r.mu.Unlock()
	if registry == nil {
		writeWrapperJSON(w, http.StatusOK, []wrapperTargetSnapshot{})
		return
	}
	writeWrapperJSON(w, http.StatusOK, registry.snapshots())
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

func startWrapperScreencast(ctx context.Context, values RuntimeEnvValues, controlSocket string, captureID string, target string, viewport compositorViewport, path string, fps int, bitrateKbps int, codec string) (*exec.Cmd, <-chan error, error) {
	keepaliveMS := 1000 / fps
	recordingWidth := min(viewport.CanvasWidth, (viewport.ContentWidth+1)/2*2)
	recordingHeight := min(viewport.CanvasHeight, (viewport.ContentHeight+1)/2*2)
	args := []string{
		"-e",
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
		"videocrop",
		"right=" + strconv.Itoa(viewport.CanvasWidth-recordingWidth),
		"bottom=" + strconv.Itoa(viewport.CanvasHeight-recordingHeight),
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
	go func() {
		for _, delay := range []time.Duration{50 * time.Millisecond, 100 * time.Millisecond, 250 * time.Millisecond} {
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			_, _ = sendCompositorControlCommand(ctx, controlSocket, "output-repaint "+captureID+"\n")
		}
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

func resolveWrapperRecordingCodec(requested string, fallback string, gpuMode string) (string, error) {
	codec := strings.TrimSpace(requested)
	if codec == "" {
		codec = strings.TrimSpace(fallback)
	}
	if codec == "" || codec == mediaCodecAuto {
		codec = mediaCodecVP8
	}
	switch codec {
	case mediaCodecVP8:
		return codec, nil
	case mediaCodecH264:
		if gpuMode != gpuModeHardware {
			return "", errors.New("h264-va recording requires hardware GPU mode")
		}
		return codec, nil
	default:
		return "", fmt.Errorf("recording codec must be vp8 or h264-va")
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

func viewportScaleNumerator(deviceScaleFactor float64) int {
	if deviceScaleFactor <= 0 || math.IsNaN(deviceScaleFactor) || math.IsInf(deviceScaleFactor, 0) {
		return viewportScaleDenominator
	}
	return int(math.Round(deviceScaleFactor * viewportScaleDenominator))
}

func sendCompositorControlCommand(ctx context.Context, socketPath string, command string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
	if err != nil {
		return "", fmt.Errorf("dial compositor control socket: %w", err)
	}
	defer func() { _ = conn.Close() }()

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
