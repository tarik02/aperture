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
	values                   RuntimeEnvValues
	controlSocket            string
	ctx                      context.Context
	mu                       sync.Mutex
	uploadMu                 sync.Mutex
	compositorPID            int
	mediaProducer            *producer
	targets                  *wrapperTargetRegistry
	viewers                  map[*wrapperViewer]struct{}
	revokedAccessGenerations map[string]map[string]struct{}
	activeRequests           int
	cdpConnections           int
	liveSession              *liveSession
}

func (r *wrapperRuntime) setTargetRegistry(registry *wrapperTargetRegistry) {
	r.mu.Lock()
	r.targets = registry
	r.compositorPID = registry.compositorPID
	r.mu.Unlock()
}

func (r *wrapperRuntime) targetReady(ctx context.Context, target wrapperTargetSnapshot, previous wrapperTargetSnapshot, hadPrevious bool) error {
	if err := r.liveSession.replaceRecordingTargets(ctx, target); err != nil {
		if hadPrevious {
			if rollbackErr := r.liveSession.replaceRecordingTargets(context.Background(), previous); rollbackErr != nil {
				r.liveSession.failRecordingTargets(previous.TargetID, previous.Generation)
				return errors.Join(err, fmt.Errorf("roll back recording capture sources: %w", rollbackErr))
			}
		}
		return err
	}
	mediaProducer := r.currentMediaProducer()
	if mediaProducer != nil {
		if err := mediaProducer.media.SetTarget(ctx, target); err != nil {
			if hadPrevious {
				if rollbackErr := r.liveSession.replaceRecordingTargets(context.Background(), previous); rollbackErr != nil {
					r.liveSession.failRecordingTargets(previous.TargetID, previous.Generation)
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
	r.liveSession.stopTabRecordings(target.TargetID)
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
	cancel                    context.CancelFunc
	role                      string
	capabilityRole            string
	sessionTokenAuthenticated bool
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
		values:                   values,
		controlSocket:            controlSocket,
		ctx:                      context.Background(),
		viewers:                  make(map[*wrapperViewer]struct{}),
		revokedAccessGenerations: make(map[string]map[string]struct{}),
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

func (r *wrapperRuntime) claimViewer(viewer *wrapperViewer) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if viewer.role != "owner" {
		nonOwnerViewers := 0
		for current := range r.viewers {
			if current.role != "owner" {
				nonOwnerViewers++
			}
		}
		if nonOwnerViewers >= mediaMaximumNonOwnerPeers {
			return false
		}
	}
	r.viewers[viewer] = struct{}{}
	return true
}

func (r *wrapperRuntime) releaseViewer(viewer *wrapperViewer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.viewers, viewer)
}

func (r *wrapperRuntime) disconnectSessionTokenConsumers(generation string) {
	r.mu.Lock()
	r.revokeSessionAccessGenerationLocked("owner", generation)
	viewers := make([]*wrapperViewer, 0, len(r.viewers))
	for viewer := range r.viewers {
		if viewer.sessionTokenAuthenticated {
			viewers = append(viewers, viewer)
		}
	}
	liveSession := r.liveSession
	r.mu.Unlock()
	for _, viewer := range viewers {
		viewer.cancel()
	}
	if liveSession != nil {
		liveSession.disconnectSessionTokenClients()
	}
}

func (r *wrapperRuntime) disconnectCollaborationCapabilityConsumers(role, generation string) {
	r.mu.Lock()
	r.revokeSessionAccessGenerationLocked(role, generation)
	viewers := make([]*wrapperViewer, 0)
	for viewer := range r.viewers {
		if viewer.capabilityRole == role {
			viewers = append(viewers, viewer)
		}
	}
	liveSession := r.liveSession
	r.mu.Unlock()
	for _, viewer := range viewers {
		viewer.cancel()
	}
	if liveSession != nil {
		liveSession.disconnectCapabilityRoleClients(role)
	}
}

func (r *wrapperRuntime) revokeSessionAccessGenerationLocked(role, generation string) {
	revoked := r.revokedAccessGenerations[role]
	if revoked == nil {
		revoked = make(map[string]struct{})
		r.revokedAccessGenerations[role] = revoked
	}
	revoked[generation] = struct{}{}
}

func (r *wrapperRuntime) restoreCollaborationCapabilityGeneration(role, generation string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	revoked := r.revokedAccessGenerations[role]
	delete(revoked, generation)
	if len(revoked) == 0 {
		delete(r.revokedAccessGenerations, role)
	}
}

func sessionCapabilityRole(req *http.Request) string {
	if strings.TrimSpace(req.Header.Get("X-Aperture-Actor-Kind")) != "session_capability" {
		return ""
	}
	role := strings.TrimSpace(req.Header.Get("X-Aperture-Collaboration-Role"))
	if role == "owner" || role == "editor" || role == "viewer" {
		return role
	}
	return ""
}

func collaborationCapabilityRole(req *http.Request) string {
	role := sessionCapabilityRole(req)
	if role == "editor" || role == "viewer" {
		return role
	}
	return ""
}

func sessionCapabilityGeneration(req *http.Request) string {
	if sessionCapabilityRole(req) == "" {
		return ""
	}
	return strings.TrimSpace(req.Header.Get("X-Aperture-Capability-Generation"))
}

func (r *wrapperRuntime) sessionAccessGenerationAllowed(role, generation string) bool {
	if role == "" {
		return true
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	revoked := r.revokedAccessGenerations[role]
	if len(revoked) == 0 {
		return true
	}
	if generation == "" {
		return false
	}
	_, denied := revoked[generation]
	return !denied
}

func sessionTokenAuthenticated(req *http.Request) bool {
	return sessionCapabilityRole(req) == "owner"
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
	liveSession, err := newLiveSession(r)
	if err != nil {
		return nil, nil, fmt.Errorf("create live session: %w", err)
	}
	r.mu.Lock()
	r.liveSession = liveSession
	r.mu.Unlock()
	go liveSession.run(ctx)
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
	mux.HandleFunc("/session", liveSession.serveSessionWebSocketHTTP)
	mux.HandleFunc("/automation/lease", liveSession.serveAutomationLeaseHTTP)
	mux.HandleFunc("/collaboration/capability-rotated", r.handleCollaborationCapabilityRotated)
	mux.HandleFunc("/targets", r.handleTargets)
	mux.HandleFunc("/viewport", r.handleViewport)
	mux.HandleFunc("/cursor", r.handleCursor)
	mux.HandleFunc("/recordings", liveSession.handleRecordings)
	mux.HandleFunc("/recordings/", liveSession.handleRecording)
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

func (r *wrapperRuntime) handleCollaborationCapabilityRotated(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost && req.Method != http.MethodDelete {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	role := strings.TrimSpace(req.URL.Query().Get("role"))
	if role != "editor" && role != "viewer" {
		writeWrapperError(w, http.StatusBadRequest, "invalid collaboration role")
		return
	}
	generation := strings.TrimSpace(req.URL.Query().Get("generation"))
	if generation == "" || len(generation) > 128 {
		writeWrapperError(w, http.StatusBadRequest, "invalid collaboration capability generation")
		return
	}
	if req.Method == http.MethodDelete {
		r.restoreCollaborationCapabilityGeneration(role, generation)
	} else {
		r.disconnectCollaborationCapabilityConsumers(role, generation)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (r *wrapperRuntime) handleStatus(w http.ResponseWriter, req *http.Request) {
	r.mu.Lock()
	defer r.mu.Unlock()
	status := map[string]any{
		"sessionId":       r.values.SessionID,
		"compositor":      r.values.CompositorEnabled,
		"compositorPid":   r.compositorPID,
		"browserCDPPort":  r.values.CDPPort,
		"gpuMode":         r.values.GPUMode,
		"mediaCodec":      r.values.MediaProducerCodec,
		"activeRequests":  r.activeRequests,
		"viewerConnected": len(r.viewers) > 0,
		"cdpConnections":  r.cdpConnections,
		"recordings":      r.liveSession.listRecordingsLocked(),
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
	if r.targets != nil {
		status["targets"] = r.targets.snapshots()
	}
	collaborationRole := strings.TrimSpace(req.Header.Get("X-Aperture-Collaboration-Role"))
	if collaborationRole != "" && collaborationRole != "owner" {
		delete(status, "recordings")
		writeWrapperJSON(w, http.StatusOK, status)
		return
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
		status["sessionToken"] = token
	} else if r.values.SessionToken != "" {
		status["sessionToken"] = r.values.SessionToken
	}
	writeWrapperJSON(w, http.StatusOK, status)
}

func (r *wrapperRuntime) handleActivity(w http.ResponseWriter, _ *http.Request) {
	r.mu.Lock()
	defer r.mu.Unlock()
	writeWrapperJSON(w, http.StatusOK, WrapperActivityStatus{
		Active:            r.activeRequests > 0 || r.liveSession.activeRecordingCountLocked() > 0,
		ActiveRequests:    r.activeRequests,
		ViewerConnected:   len(r.viewers) > 0,
		CDPConnections:    r.cdpConnections,
		RecordingsRunning: r.liveSession.activeRecordingCountLocked(),
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

func (r *wrapperRuntime) handleCursor(w http.ResponseWriter, req *http.Request) {
	visible := r.liveSession.presentation().CursorVisible
	switch req.Method {
	case http.MethodGet:
	case http.MethodPut:
		var body struct {
			Visible *bool `json:"visible"`
		}
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil || body.Visible == nil {
			writeWrapperError(w, http.StatusBadRequest, "invalid cursor request")
			return
		}
		presentation, err := r.liveSession.updateCursorVisibility(req.Context(), *body.Visible)
		if err != nil {
			writeWrapperError(w, http.StatusBadGateway, err.Error())
			return
		}
		visible = presentation.CursorVisible
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	writeWrapperJSON(w, http.StatusOK, map[string]bool{"visible": visible})
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
	role := strings.TrimSpace(req.Header.Get("X-Aperture-Collaboration-Role"))
	viewer := &wrapperViewer{
		cancel:                    cancel,
		role:                      role,
		capabilityRole:            collaborationCapabilityRole(req),
		sessionTokenAuthenticated: sessionTokenAuthenticated(req),
	}
	if !r.claimViewer(viewer) {
		writeWrapperError(w, http.StatusServiceUnavailable, "shared WebRTC connection limit reached")
		return
	}
	defer r.releaseViewer(viewer)
	metadata := newLiveSessionWebRTCPeerMetadata(r.liveSession, mediaProducer.webrtc, req, cancel)
	mediaProducer.Handler(metadata).ServeHTTP(w, req.WithContext(ctx))
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
