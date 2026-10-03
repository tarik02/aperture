package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/recording"
	"github.com/aperture/aperture/internal/sessionfiles"
	"github.com/google/uuid"
	"golang.org/x/sys/unix"
)

const wrapperRecordingCapacity = 4

var (
	errWrapperRecordingNotFound         = errors.New("recording not found")
	errWrapperRecordingEmpty            = errors.New("recording is empty")
	errWrapperRecordingCodecUnavailable = errors.New("recording codec is unavailable on this host")
)

type wrapperRecordingStatus string

type wrapperRecordingMode string

const (
	wrapperRecordingStarting wrapperRecordingStatus = "starting"
	wrapperRecordingRunning  wrapperRecordingStatus = "running"
	wrapperRecordingStopped  wrapperRecordingStatus = "stopped"
	wrapperRecordingFailed   wrapperRecordingStatus = "failed"

	wrapperRecordingModeTab    wrapperRecordingMode = "tab"
	wrapperRecordingModeViewer wrapperRecordingMode = "viewer"
)

type wrapperRecording struct {
	ID                string                 `json:"recordingId"`
	Mode              wrapperRecordingMode   `json:"mode"`
	TargetID          string                 `json:"targetId"`
	CaptureGeneration uint64                 `json:"captureGeneration"`
	Status            wrapperRecordingStatus `json:"status"`
	StopReason        string                 `json:"stopReason,omitempty"`
	Path              string                 `json:"-"`
	StartedAt         time.Time              `json:"startedAt"`
	StoppedAt         *time.Time             `json:"stoppedAt,omitempty"`
	SizeBytes         int64                  `json:"sizeBytes,omitempty"`
	FPS               int                    `json:"fps"`
	BitrateKbps       int                    `json:"bitrateKbps"`
	Codec             string                 `json:"codec"`
	filesRoot         string
	segmentDir        string
	segments          []*recordingSegment
	journal           *recordingJournal
	config            recording.Config
	follow            chan string        // bursts: the target the latest automation acted on, for followAutomation
	cancelFollow      context.CancelFunc // ends followAutomation
	// Editing says the stop's edit is still running; the raw video is already published. The edit
	// fields are filled when it ends.
	Editing      bool                    `json:"editing"`
	cancelEdit   context.CancelCauseFunc // ends the edit; the cause says why
	editDone     chan struct{}           // closed when the edit has ended
	EditedPath   string                  `json:"-"` // the edited video, when the stop made one
	TimelinePath string                  `json:"-"`
	EditError    *recording.EditError    `json:"editError,omitempty"`
	cmd          *exec.Cmd
	done         <-chan error
	viewport     compositorViewport
	// stopping says the capture is being stopped: the recording takes no more journal entries, no
	// longer counts as active, and its pipeline's exit is expected.
	stopping    bool
	replacing   bool
	unsalvaged  bool // the pipeline exited; refreshRecordings still has to keep what it captured
	clientID    string
	operationMu *sync.Mutex
}

type wrapperRecordingRequest struct {
	Mode        wrapperRecordingMode `json:"mode"`
	TargetID    string               `json:"targetId"`
	ClientID    string               `json:"clientId"`
	FPS         int                  `json:"fps"`
	BitrateKbps int                  `json:"bitrateKbps"`
	Codec       string               `json:"codec"`
	Path        string               `json:"path"`
	recording.Config
}

type wrapperRecordingRetargetRequest struct {
	TargetID string `json:"targetId"`
}

func (session *liveSession) handleRecordings(w http.ResponseWriter, req *http.Request) {
	switch req.Method {
	case http.MethodGet:
		writeWrapperJSON(w, http.StatusOK, session.listRecordings())
	case http.MethodPost:
		var body wrapperRecordingRequest
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			writeWrapperError(w, http.StatusBadRequest, "invalid recording request")
			return
		}
		if req.Header.Get("X-Aperture-Actor-Kind") == "session_capability" {
			body.Path = ""
		}
		started, err := session.startRecording(body)
		if errors.Is(err, errWrapperRecordingCodecUnavailable) {
			writeWrapperError(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
		if errors.Is(err, recording.ErrInvalid) {
			writeWrapperError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err != nil {
			writeWrapperError(w, http.StatusConflict, err.Error())
			return
		}
		writeWrapperJSON(w, http.StatusCreated, started)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (session *liveSession) handleRecording(w http.ResponseWriter, req *http.Request) {
	path := strings.TrimPrefix(req.URL.Path, "/recordings/")
	parts := strings.Split(path, "/")
	if len(parts) == 1 && req.Method == http.MethodGet {
		recording, exists := session.recording(parts[0])
		if !exists {
			writeWrapperError(w, http.StatusNotFound, "recording not found")
			return
		}
		writeWrapperJSON(w, http.StatusOK, recording)
		return
	}
	if len(parts) == 2 && parts[0] == "annotations" && req.Method == http.MethodPost {
		session.handleAnnotation(w, req, parts[1])
		return
	}
	if len(parts) == 2 && parts[1] == "stop" && req.Method == http.MethodPost {
		recording, err := session.stopRecordingRequested(parts[0], "requested")
		if err != nil {
			if errors.Is(err, errWrapperRecordingNotFound) {
				writeWrapperError(w, http.StatusNotFound, err.Error())
				return
			}
			writeWrapperError(w, http.StatusConflict, err.Error())
			return
		}
		serveWrapperRecording(w, req, recording)
		return
	}
	if len(parts) == 2 && parts[1] == "retarget" && req.Method == http.MethodPost {
		var body wrapperRecordingRetargetRequest
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			writeWrapperError(w, http.StatusBadRequest, "invalid retarget request")
			return
		}
		if strings.TrimSpace(body.TargetID) == "" {
			writeWrapperError(w, http.StatusBadRequest, "targetId is required")
			return
		}
		recording, err := session.retargetRecording(req.Context(), parts[0], body.TargetID)
		if err != nil {
			if errors.Is(err, errWrapperRecordingNotFound) {
				writeWrapperError(w, http.StatusNotFound, err.Error())
				return
			}
			writeWrapperError(w, http.StatusConflict, err.Error())
			return
		}
		writeWrapperJSON(w, http.StatusOK, recording)
		return
	}
	if len(parts) == 2 && parts[1] == "content" && req.Method == http.MethodGet {
		recording, exists := session.recording(parts[0])
		if !exists {
			writeWrapperError(w, http.StatusNotFound, "recording not found")
			return
		}
		if recording.Status != wrapperRecordingStopped {
			writeWrapperError(w, http.StatusConflict, "recording is not ready for download")
			return
		}
		serveWrapperRecording(w, req, recording)
		return
	}
	w.WriteHeader(http.StatusMethodNotAllowed)
}

func serveWrapperRecording(w http.ResponseWriter, req *http.Request, recording wrapperRecording) {
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(recording.Path)))
	contentType := "video/webm"
	if recording.Codec == "h264-va" {
		contentType = "video/x-matroska"
	}
	w.Header().Set("Content-Type", contentType)
	http.ServeFile(w, req, recording.Path)
}

// recordingGateWait bounds how long starting, stopping or annotating a recording waits for a browser call.
const recordingGateWait = 30 * time.Second

// acquireGate takes the slot that serializes browser calls with recording start and stop: a start
// holds it until the capture's first frame, so no automation happens before frame 0, and a stop
// holds it while the recording leaves the journal. The release can be called more than once.
func (session *liveSession) acquireGate(ctx context.Context) (func(), error) {
	select {
	case session.gate <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	var once sync.Once
	return func() { once.Do(func() { <-session.gate }) }, nil
}

func (session *liveSession) acquireRecordingGate(ctx context.Context) (func(), error) {
	waitCtx, cancel := context.WithTimeout(ctx, recordingGateWait)
	defer cancel()
	release, err := session.acquireGate(waitCtx)
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("wait for the browser call to end: %w", ctx.Err())
		}
		return nil, errors.New("a browser call is still running; try again")
	}
	return release, nil
}

func (session *liveSession) startRecording(request wrapperRecordingRequest) (wrapperRecording, error) {
	r := session.runtime
	// The daemon checked the config already; live-session clients reach the wrapper without it.
	if err := request.Validate(); err != nil {
		return wrapperRecording{}, err
	}
	if request.ClientID != "" {
		parsedClientID, err := uuid.Parse(request.ClientID)
		if err != nil || parsedClientID.String() != request.ClientID {
			return wrapperRecording{}, errors.New("clientId must be a UUID")
		}
	}
	switch request.Mode {
	case wrapperRecordingModeTab:
	case wrapperRecordingModeViewer:
		if request.ClientID == "" {
			return wrapperRecording{}, errors.New("viewer recording requires a valid clientId")
		}
		if request.Capture == recording.CaptureBursts { // a viewer recording follows its client, so it cannot follow automation
			return wrapperRecording{}, fmt.Errorf("%w: capture bursts applies to tab recordings, not to viewer recordings", recording.ErrInvalid)
		}
	default:
		return wrapperRecording{}, errors.New("recording mode must be tab or viewer")
	}
	r.mu.Lock()
	registry := r.targets
	r.mu.Unlock()
	if registry == nil {
		return wrapperRecording{}, errors.New("target registry is unavailable")
	}
	// The gate comes before recordingMu: nothing that holds recordingMu waits for the gate.
	release, err := session.acquireRecordingGate(r.ctx)
	if err != nil {
		return wrapperRecording{}, err
	}
	defer release()
	if request.ClientID != "" {
		session.recordingMu.Lock()
		defer session.recordingMu.Unlock()
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
	id := uuid.NewString()
	if codec == "h264-va" {
		if err := probeGStreamerElements(r.values, codec, []string{"vapostproc", "vah264enc", "h264parse", "matroskamux"}); err != nil {
			return wrapperRecording{}, fmt.Errorf("%w: %w", errWrapperRecordingCodecUnavailable, err)
		}
	}
	files := paths.SessionFiles(r.values.FilesDir)
	recordingsDir := files.Recordings
	path, err := recordingPath(files, request.Path, id, codec)
	if err != nil {
		return wrapperRecording{}, err
	}
	segmentDir := filepath.Join(recordingsDir, ".recording-"+id)
	if err := os.MkdirAll(segmentDir, 0o700); err != nil {
		return wrapperRecording{}, fmt.Errorf("mkdir recording segment dir: %w", err)
	}
	segmentPath := filepath.Join(segmentDir, "segment-0000"+filepath.Ext(path))

	targetID := request.TargetID
	if request.ClientID != "" {
		session.mu.Lock()
		client := session.clients[request.ClientID]
		if client != nil && request.Mode == wrapperRecordingModeViewer {
			targetID = client.activeTargetID
		}
		session.mu.Unlock()
		if client == nil {
			_ = os.RemoveAll(segmentDir)
			return wrapperRecording{}, errors.New("session client is unavailable")
		}
	}
	target, exists := registry.readyTarget(targetID)
	if !exists {
		_ = os.RemoveAll(segmentDir)
		return wrapperRecording{}, errors.New("target is not ready")
	}

	recording := &wrapperRecording{
		ID:                id,
		Mode:              request.Mode,
		TargetID:          target.TargetID,
		CaptureGeneration: target.Generation,
		Status:            wrapperRecordingStarting,
		Path:              path,
		filesRoot:         files.Root,
		StartedAt:         time.Now().UTC(),
		FPS:               fps,
		BitrateKbps:       bitrateKbps,
		Codec:             codec,
		segmentDir:        segmentDir,
		segments:          []*recordingSegment{newRecordingSegment(segmentPath, target)},
		journal:           newRecordingJournal(segmentDir),
		config:            request.Config,
		viewport:          target.Viewport,
		clientID:          request.ClientID,
		operationMu:       &sync.Mutex{},
	}
	// Event-driven stops and failures wait on this until the start is over, so they never see a
	// half-started pipeline. It is taken while the recording is still private, before r.mu, which
	// is the order every other operation takes the two in.
	recording.operationMu.Lock()
	defer recording.operationMu.Unlock()
	r.mu.Lock()
	active := 0
	for _, other := range session.recordings {
		if other.Status == wrapperRecordingStarting || other.Status == wrapperRecordingRunning {
			active++
		}
	}
	if active >= wrapperRecordingCapacity {
		r.mu.Unlock()
		_ = os.RemoveAll(segmentDir)
		return wrapperRecording{}, fmt.Errorf("recording capacity of %d is exhausted", wrapperRecordingCapacity)
	}
	if request.Capture == "bursts" {
		var followCtx context.Context
		followCtx, recording.cancelFollow = context.WithCancel(r.ctx)
		recording.follow = make(chan string, 1)
		go session.followAutomation(followCtx, recording)
	}
	session.recordings[id] = recording
	session.setRecordingStatusLocked(recording, wrapperRecordingStarting)
	cmd, done, clock, err := startWrapperScreencast(r.ctx, r.values, r.controlSocket, target.CaptureID, target.PipeWireTarget, target.Viewport, segmentPath, fps, bitrateKbps, codec)
	if err != nil {
		session.markFailedLocked(recording, "start_failed")
		r.mu.Unlock()
		_ = os.RemoveAll(segmentDir)
		session.broadcastRecordings()
		return wrapperRecording{}, err
	}
	recording.cmd = cmd
	recording.done = done
	recording.segments[0].clock = clock
	r.mu.Unlock()
	session.broadcastRecordings()
	// The gate is still held, so the first automation is admitted only once frame 0 exists.
	repaint := func() {
		_, _ = sendCompositorControlCommand(r.ctx, r.controlSocket, "output-repaint "+target.CaptureID+"\n")
	}
	if err := clock.waitForFirstFrame(r.ctx, repaint, done); err != nil {
		if errors.Is(err, errCapturePipelineExited) {
			r.mu.Lock()
			recording.cmd, recording.done = nil, nil
			r.mu.Unlock()
		} else {
			_ = stopRecordingSegment(recording)
		}
		_, _ = session.failRecording(recording, "start_failed", err)
		session.broadcastRecordings()
		return wrapperRecording{}, err
	}
	r.mu.Lock()
	session.setRecordingStatusLocked(recording, wrapperRecordingRunning)
	status := *recording
	r.mu.Unlock()
	session.broadcastRecordings()
	return status, nil
}

func (session *liveSession) moveViewerRecordings(ctx context.Context, clientID, targetID string) error {
	r := session.runtime
	type candidate struct {
		recording *wrapperRecording
		targetID  string
	}
	r.mu.Lock()
	recordings := make([]candidate, 0)
	for _, recording := range session.recordings {
		if recording.Mode == wrapperRecordingModeViewer &&
			recording.clientID == clientID &&
			recording.Status == wrapperRecordingRunning {
			recordings = append(recordings, candidate{recording: recording, targetID: recording.TargetID})
		}
	}
	r.mu.Unlock()
	if len(recordings) == 0 {
		return nil
	}
	r.mu.Lock()
	registry := r.targets
	r.mu.Unlock()
	if registry == nil {
		return errors.New("target registry is unavailable")
	}
	target, exists := registry.readyTarget(targetID)
	if !exists {
		return errors.New("target is not ready")
	}
	rotated := make([]candidate, 0, len(recordings))
	for _, current := range recordings {
		if err := session.rotateRecordingTarget(ctx, current.recording, target, current.targetID); err != nil {
			rollbackCtx, cancelRollback := context.WithTimeout(r.ctx, 10*time.Second)
			defer cancelRollback()
			for index := len(rotated) - 1; index >= 0; index-- {
				previous, ready := registry.readyTarget(rotated[index].targetID)
				if ready {
					_ = session.rotateRecordingTarget(rollbackCtx, rotated[index].recording, previous, targetID)
				}
			}
			return err
		}
		rotated = append(rotated, current)
	}
	return nil
}

func (session *liveSession) stopClientRecordings(clientID string) {
	r := session.runtime
	r.mu.Lock()
	recordingIDs := make([]string, 0)
	for _, recording := range session.recordings {
		if recording.clientID == clientID &&
			(recording.Status == wrapperRecordingStarting || recording.Status == wrapperRecordingRunning) {
			recordingIDs = append(recordingIDs, recording.ID)
		}
	}
	r.mu.Unlock()
	for _, recordingID := range recordingIDs {
		_, _ = session.stopRecording(recordingID, "client_disconnected")
	}
}

func (session *liveSession) stopViewerRecordings(clientID, reason string) {
	r := session.runtime
	r.mu.Lock()
	recordingIDs := make([]string, 0)
	for _, recording := range session.recordings {
		if recording.Mode == wrapperRecordingModeViewer &&
			recording.clientID == clientID &&
			(recording.Status == wrapperRecordingStarting || recording.Status == wrapperRecordingRunning) {
			recordingIDs = append(recordingIDs, recording.ID)
		}
	}
	r.mu.Unlock()
	for _, recordingID := range recordingIDs {
		_, _ = session.stopRecording(recordingID, reason)
	}
}

func (session *liveSession) stopRecording(recordingID string, reason string) (wrapperRecording, error) {
	return session.stopRecordingForTarget(recordingID, "", reason)
}

// stopRecordingRequested stops a recording on behalf of a client or the API. The recording leaves
// the journal under the gate, so a browser call that is running finishes inside it; the stop's
// slower part, joining and publishing the raw video, runs after the gate is released, and its
// edit runs on after the stop has returned. Stops that follow from events (a closed target, a
// gone client, the session ending) do not wait for the gate: they can run while recordingMu is
// held, which a starting recording needs after it took the gate; and they publish the raw video only.
func (session *liveSession) stopRecordingRequested(recordingID string, reason string) (wrapperRecording, error) {
	// A recording that is done needs no gate, whether or not its edit still runs: this stop only
	// reports its status, and must not hold the gate while it does.
	settled := func() bool {
		status, found := session.recording(recordingID)
		return !found || status.Status == wrapperRecordingStopped || status.Status == wrapperRecordingFailed
	}
	if settled() {
		return session.stopRecordingForTarget(recordingID, "", reason)
	}
	release, err := session.acquireRecordingGate(session.runtime.ctx)
	if err != nil {
		return wrapperRecording{}, err
	}
	defer release()
	if settled() { // the stop ahead of this one ended the recording while this waited for the gate
		release()
		return session.stopRecordingForTarget(recordingID, "", reason)
	}
	return session.stopRecordingWithGate(recordingID, "", reason, release)
}

// cancelRecording stops a recording without an edit; a recording whose edit is running keeps the
// raw video and loses the edit.
func (session *liveSession) cancelRecording(recordingID string) (wrapperRecording, error) {
	r := session.runtime
	r.mu.Lock()
	recording := session.recordings[recordingID]
	var editDone chan struct{}
	if recording != nil && recording.Editing {
		recording.cancelEdit(errors.New("cancelled on request"))
		editDone = recording.editDone
	}
	r.mu.Unlock()
	if editDone == nil {
		return session.stopRecordingRequested(recordingID, "canceled")
	}
	<-editDone
	status, _ := session.recording(recordingID)
	return status, nil
}

func (session *liveSession) stopRecordingForTarget(recordingID string, targetID string, reason string) (wrapperRecording, error) {
	return session.stopRecordingWithGate(recordingID, targetID, reason, func() {})
}

func (session *liveSession) stopRecordingWithGate(recordingID string, targetID string, reason string, releaseGate func()) (wrapperRecording, error) {
	r := session.runtime
	r.mu.Lock()
	recording := session.recordings[recordingID]
	r.mu.Unlock()
	if recording == nil {
		return wrapperRecording{}, errWrapperRecordingNotFound
	}
	defer session.broadcastRecordings()
	recording.operationMu.Lock()
	defer recording.operationMu.Unlock()

	r.mu.Lock()
	session.refreshRecordingLocked(recording)
	if (targetID != "" && recording.TargetID != targetID) || recording.Status == wrapperRecordingStopped {
		status := *recording
		r.mu.Unlock()
		return status, nil
	}
	if recording.Status == wrapperRecordingFailed {
		status := *recording
		r.mu.Unlock()
		return status, errors.New("recording has failed")
	}
	recording.stopping = true
	session.setRecordingStatusLocked(recording, recording.Status) // no longer counts as running
	r.mu.Unlock()
	releaseGate()

	source, failure, err := session.stopCapture(recording)
	if err != nil {
		return session.failRecording(recording, failure, err)
	}
	return session.publishStoppedRecording(recording, source, reason)
}

// stopCapture ends the capture pipeline and joins what it recorded into one file, in the work
// directory. The failure names what a returned error failed.
func (session *liveSession) stopCapture(recording *wrapperRecording) (source string, failure string, err error) {
	if err := stopRecordingSegment(recording); err != nil {
		return "", "pipeline_failed", err
	}
	recordCaptureFacts(recording)
	source, err = session.joinRecordingSegments(recording)
	if err != nil {
		return "", "finalize_failed", err
	}
	return source, "", nil
}

// publishStoppedRecording makes the raw video visible and the recording stopped. Only a requested
// stop edits: the others come from events that cannot wait for ffmpeg. The video is opened before
// it is published, so the edit reads this very file, and the edit runs on after the stop returns.
func (session *liveSession) publishStoppedRecording(rec *wrapperRecording, source string, reason string) (wrapperRecording, error) {
	r := session.runtime
	var video *os.File
	var editError *recording.EditError
	if reason == "requested" {
		var err error
		if video, err = openRecordingVideo(source); err != nil {
			editError = &recording.EditError{Code: recording.EditOpenFailed, Message: err.Error()}
		}
	}
	finalPath, size, err := publishFinishedRecording(source, rec.Path)
	if err != nil {
		if video != nil {
			_ = video.Close()
		}
		if errors.Is(err, errWrapperRecordingEmpty) {
			return session.failRecording(rec, reason, err)
		}
		return session.failRecording(rec, "finalize_failed", err)
	}
	// The raw video is published, so the segments must not be published again by a sweep after a crash.
	for _, segment := range rec.segments {
		_ = os.Remove(segment.path)
	}
	if video == nil {
		_ = os.RemoveAll(rec.segmentDir)
	}
	r.mu.Lock()
	stoppedAt := time.Now().UTC()
	rec.Path = finalPath
	rec.EditError = editError
	rec.SizeBytes = size
	rec.StoppedAt = &stoppedAt
	rec.stopping = false
	session.setRecordingStatusLocked(rec, wrapperRecordingStopped)
	rec.StopReason = reason
	if video != nil {
		session.startEditLocked(rec, video, finalPath)
	}
	status := *rec
	r.mu.Unlock()
	return status, nil
}

// startEditLocked runs the edit of a stopped recording on its own; the recording is editing until
// it ends. The session's end and a cancel end it early, and the edit counts as activity meanwhile,
// so the session is not suspended under it.
func (session *liveSession) startEditLocked(recording *wrapperRecording, video *os.File, raw string) {
	r := session.runtime
	finalize := session.finalize
	if finalize == nil {
		finalize = session.finalizeRecording
	}
	ctx, cancel := context.WithCancelCause(r.ctx)
	done := make(chan struct{})
	recording.Editing, recording.cancelEdit, recording.editDone = true, cancel, done
	go func() {
		defer close(done)
		edited, timeline, failure := finalize(ctx, recording, video, raw)
		cancel(nil)
		_ = video.Close()
		_ = os.RemoveAll(recording.segmentDir)
		r.mu.Lock()
		recording.Editing = false
		recording.EditedPath, recording.TimelinePath, recording.EditError = edited, timeline, failure
		r.mu.Unlock()
		session.broadcastRecordings()
	}()
}

// failRecording marks a recording failed after keeping what it captured.
func (session *liveSession) failRecording(recording *wrapperRecording, reason string, cause error) (wrapperRecording, error) {
	salvaged := abandonRecordingSegments(recording.segmentDir, recording.Path)
	r := session.runtime
	r.mu.Lock()
	defer r.mu.Unlock()
	session.markFailedLocked(recording, reason)
	if salvaged != "" {
		recording.Path = salvaged
	}
	return *recording, cause
}

// markFailedLocked ends a recording in failure: it stops counting, and keeps why and when.
func (session *liveSession) markFailedLocked(recording *wrapperRecording, reason string) {
	stoppedAt := time.Now().UTC()
	recording.stopping = false
	session.setRecordingStatusLocked(recording, wrapperRecordingFailed)
	recording.StopReason = reason
	recording.StoppedAt = &stoppedAt
}

func stopRecordingSegment(recording *wrapperRecording) error {
	if recording.cmd == nil || recording.cmd.Process == nil {
		return nil
	}
	select {
	case err := <-recording.done:
		recording.cmd = nil
		recording.done = nil
		if err != nil {
			return fmt.Errorf("recording pipeline stopped: %w", err)
		}
		return nil
	default:
	}
	_ = recording.cmd.Process.Signal(syscall.SIGINT)
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	var stopErr error
	select {
	case err := <-recording.done:
		if err != nil {
			stopErr = fmt.Errorf("recording pipeline stopped: %w", err)
		}
	case <-timer.C:
		_ = recording.cmd.Process.Kill()
		<-recording.done
	}
	recording.cmd = nil
	recording.done = nil
	return stopErr
}

func (session *liveSession) replaceRecordingTargets(ctx context.Context, target wrapperTargetSnapshot) error {
	r := session.runtime
	r.mu.Lock()
	recordings := make([]*wrapperRecording, 0)
	for _, recording := range session.recordings {
		session.refreshRecordingLocked(recording)
		if recording.TargetID == target.TargetID && recording.Status == wrapperRecordingRunning {
			recordings = append(recordings, recording)
		}
	}
	r.mu.Unlock()
	if len(recordings) > 0 {
		defer session.broadcastRecordings()
	}
	for _, recording := range recordings {
		if err := session.rotateRecordingTarget(ctx, recording, target, target.TargetID); err != nil {
			return err
		}
	}
	return nil
}

func (session *liveSession) retargetRecording(ctx context.Context, recordingID, targetID string) (wrapperRecording, error) {
	r := session.runtime
	r.mu.Lock()
	recording := session.recordings[recordingID]
	registry := r.targets
	r.mu.Unlock()
	if recording == nil {
		return wrapperRecording{}, errWrapperRecordingNotFound
	}

	recording.operationMu.Lock()
	defer recording.operationMu.Unlock()
	defer session.broadcastRecordings()

	r.mu.Lock()
	session.refreshRecordingLocked(recording)
	if recording.Mode != wrapperRecordingModeTab {
		status := *recording
		r.mu.Unlock()
		return status, errors.New("only tab recordings can be retargeted")
	}
	if recording.Status != wrapperRecordingRunning {
		status := *recording
		r.mu.Unlock()
		return status, errors.New("only running recordings can be retargeted")
	}
	if recording.TargetID == targetID {
		status := *recording
		r.mu.Unlock()
		return status, nil
	}
	expectedTargetID := recording.TargetID
	r.mu.Unlock()

	if registry == nil {
		return wrapperRecording{}, errors.New("target registry is unavailable")
	}
	target, exists := registry.readyTarget(targetID)
	if !exists {
		return wrapperRecording{}, errors.New("target is not ready")
	}
	if err := session.rotateRecordingTargetLocked(ctx, recording, target, expectedTargetID, true); err != nil {
		return wrapperRecording{}, err
	}
	r.mu.Lock()
	status := *recording
	r.mu.Unlock()
	return status, nil
}

func (session *liveSession) rotateRecordingTarget(ctx context.Context, recording *wrapperRecording, target wrapperTargetSnapshot, expectedTargetID string) error {
	recording.operationMu.Lock()
	defer recording.operationMu.Unlock()
	return session.rotateRecordingTargetLocked(ctx, recording, target, expectedTargetID, false)
}

func (session *liveSession) rotateRecordingTargetLocked(ctx context.Context, recording *wrapperRecording, target wrapperTargetSnapshot, expectedTargetID string, allowTabTargetChange bool) error {
	r := session.runtime

	r.mu.Lock()
	session.refreshRecordingLocked(recording)
	if recording.Status != wrapperRecordingRunning {
		r.mu.Unlock()
		return nil
	}
	if recording.TargetID != expectedTargetID {
		r.mu.Unlock()
		return nil
	}
	if recording.TargetID == target.TargetID && recording.CaptureGeneration == target.Generation && recording.viewport == target.Viewport {
		r.mu.Unlock()
		return nil
	}
	if recording.Mode == wrapperRecordingModeTab && recording.TargetID != target.TargetID && !allowTabTargetChange {
		r.mu.Unlock()
		return errors.New("tab recording cannot switch targets")
	}
	recording.replacing = true
	segment := newRecordingSegment(filepath.Join(recording.segmentDir, "segment-"+fmt.Sprintf("%04d", len(recording.segments))+filepath.Ext(recording.Path)), target)
	fps := recording.FPS
	bitrateKbps := recording.BitrateKbps
	codec := recording.Codec
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		recording.replacing = false
		r.mu.Unlock()
	}()

	cmd, done, clock, err := startWrapperScreencast(r.ctx, r.values, r.controlSocket, target.CaptureID, target.PipeWireTarget, target.Viewport, segment.path, fps, bitrateKbps, codec)
	segment.clock = clock
	if err == nil {
		waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		for waitCtx.Err() == nil {
			if info, statErr := os.Stat(segment.path); statErr == nil && info.Size() > 0 {
				break
			}
			select {
			case pipelineErr := <-done:
				cmd = nil
				done = nil
				if pipelineErr != nil {
					err = fmt.Errorf("replacement recording pipeline exited before producing data: %w", pipelineErr)
				} else {
					err = errors.New("replacement recording pipeline exited before producing data")
				}
			default:
			}
			if err != nil {
				break
			}
			timer := time.NewTimer(25 * time.Millisecond)
			select {
			case <-waitCtx.Done():
				timer.Stop()
			case <-timer.C:
			}
		}
		if err == nil && waitCtx.Err() != nil {
			err = fmt.Errorf("replacement recording pipeline did not produce data: %w", waitCtx.Err())
		}
		cancel()
	}
	if err != nil {
		if cmd != nil {
			replacement := &wrapperRecording{cmd: cmd, done: done}
			_ = stopRecordingSegment(replacement)
		}
		return err
	}
	if err := stopRecordingSegment(recording); err != nil {
		replacement := &wrapperRecording{cmd: cmd, done: done}
		_ = stopRecordingSegment(replacement)
		r.mu.Lock()
		session.markFailedLocked(recording, "replacement_failed")
		r.mu.Unlock()
		return err
	}
	r.mu.Lock()
	recording.segments = append(recording.segments, segment)
	recording.cmd = cmd
	recording.done = done
	recording.TargetID = target.TargetID
	recording.CaptureGeneration = target.Generation
	recording.viewport = target.Viewport
	r.mu.Unlock()
	return nil
}

func (session *liveSession) failRecordingTargets(targetID string, generation uint64) {
	r := session.runtime
	r.mu.Lock()
	recordings := make([]*wrapperRecording, 0)
	for _, recording := range session.recordings {
		if recording.TargetID != targetID || recording.CaptureGeneration == generation || recording.Status != wrapperRecordingRunning {
			continue
		}
		recordings = append(recordings, recording)
	}
	r.mu.Unlock()
	if len(recordings) > 0 {
		defer session.broadcastRecordings()
	}
	for _, recording := range recordings {
		recording.operationMu.Lock()
		r.mu.Lock()
		session.refreshRecordingLocked(recording)
		if recording.TargetID != targetID || recording.CaptureGeneration == generation || recording.Status != wrapperRecordingRunning {
			r.mu.Unlock()
			recording.operationMu.Unlock()
			continue
		}
		recording.replacing = true
		r.mu.Unlock()
		_ = stopRecordingSegment(recording)
		r.mu.Lock()
		recording.cmd = nil
		recording.done = nil
		session.markFailedLocked(recording, "replacement_rollback_failed")
		recording.replacing = false
		r.mu.Unlock()
		recording.operationMu.Unlock()
	}
}

func (session *liveSession) stopTabRecordings(targetID string) {
	r := session.runtime
	r.mu.Lock()
	ids := make([]string, 0)
	for _, recording := range session.recordings {
		if recording.Mode == wrapperRecordingModeTab && recording.TargetID == targetID && recording.Status == wrapperRecordingRunning {
			ids = append(ids, recording.ID)
		}
	}
	r.mu.Unlock()
	for _, id := range ids {
		_, _ = session.stopRecordingForTarget(id, targetID, "target_closed")
	}
}

// stopAllRecordings ends every recording as the session ends: captures stop and publish their raw
// video, and running edits are cancelled. It returns once the edits are gone.
func (session *liveSession) stopAllRecordings(reason string) {
	r := session.runtime
	r.mu.Lock()
	ids := make([]string, 0)
	var editing []chan struct{}
	for _, recording := range session.recordings {
		session.refreshRecordingLocked(recording)
		if recording.Editing {
			recording.cancelEdit(errors.New("the session is closing"))
			editing = append(editing, recording.editDone)
		} else if recording.Status == wrapperRecordingStarting || recording.Status == wrapperRecordingRunning {
			ids = append(ids, recording.ID)
		}
	}
	r.mu.Unlock()
	for _, id := range ids {
		_, _ = session.stopRecording(id, reason)
	}
	for _, done := range editing {
		<-done
	}
}

// joinRecordingSegments joins a recording's segments into one file in its work directory and
// returns it. Joining inside the hidden directory keeps the visible recording from appearing
// before it is complete.
func (session *liveSession) joinRecordingSegments(recording *wrapperRecording) (string, error) {
	r := session.runtime
	if len(recording.segments) == 1 {
		return recording.segments[0].path, nil
	}
	mux := "webmmux"
	parser := ""
	if recording.Codec == "h264-va" {
		parser = "h264parse"
		mux = "matroskamux"
	}
	joined := filepath.Join(recording.segmentDir, "joined"+filepath.Ext(recording.Path))
	args := []string{"concat", "name=join", "!", "queue", "!", mux, "!", "filesink", "location=" + joined, "sync=false"}
	for _, segment := range recording.segments {
		args = append(args, "filesrc", "location="+segment.path, "!", "matroskademux", "!", "queue", "!")
		if parser != "" {
			args = append(args, parser, "!")
		}
		args = append(args, "join.")
	}
	cmd := exec.CommandContext(r.ctx, r.values.MediaProducerGSTExecutable, args...)
	cmd.Env = wrapperMediaProcessEnv(r.values.MediaProducerPluginPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("join recording segments: %w", err)
	}
	return joined, nil
}

// publishFinishedRecording makes a finished recording visible and returns where it went and its
// size, measured before it can be moved.
func publishFinishedRecording(source, target string) (string, int64, error) {
	info, err := os.Stat(source)
	if err != nil {
		return "", 0, fmt.Errorf("finalize recording: %w", err)
	}
	if info.Size() == 0 {
		return "", 0, errWrapperRecordingEmpty
	}
	final, err := publishRecording(source, target)
	return final, info.Size(), err
}

// abandonRecordingSegments keeps the non-empty segments of a recording that did
// not finish as numbered "-failed" files next to its target, and removes its
// hidden segment directory, which the API could never reach or delete. It returns
// the first kept file.
func abandonRecordingSegments(segmentDir, target string) string {
	entries, _ := os.ReadDir(segmentDir)
	extension := filepath.Ext(target)
	failed := strings.TrimSuffix(target, extension) + "-failed" + extension
	salvaged := ""
	for _, entry := range entries {
		// A join output may be incomplete; the segments it came from are kept. Sources are not video.
		if !entry.Type().IsRegular() || !strings.HasPrefix(entry.Name(), "segment-") {
			continue
		}
		source := filepath.Join(segmentDir, entry.Name())
		info, err := entry.Info()
		if err != nil || info.Size() == 0 {
			continue
		}
		final, err := publishRecording(source, failed)
		if err == nil && salvaged == "" {
			salvaged = final
		}
	}
	_ = os.RemoveAll(segmentDir)
	return salvaged
}

// sweepRecordingSegments abandons the segment directories a previous wrapper
// process left behind; no recording of this process has started yet.
func sweepRecordingSegments(recordingsDir string) {
	entries, _ := os.ReadDir(recordingsDir)
	for _, entry := range entries {
		id, ok := strings.CutPrefix(entry.Name(), ".recording-")
		if !ok || !entry.IsDir() {
			continue
		}
		segmentDir := filepath.Join(recordingsDir, entry.Name())
		extension := ".webm"
		if segments, _ := filepath.Glob(filepath.Join(segmentDir, "segment-*")); len(segments) > 0 {
			extension = filepath.Ext(segments[0])
		}
		abandonRecordingSegments(segmentDir, filepath.Join(recordingsDir, "recording-"+id+extension))
	}
}

// recordingPath resolves where a recording is saved: a path relative to the files
// root, or an absolute path, inside the recordings directory, or a generated name.
// Its directory is created now, so finalizing cannot fail on it.
func recordingPath(files paths.SessionFilesLayout, requested, id, codec string) (string, error) {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		extension := ".webm"
		if codec == "h264-va" {
			extension = ".mkv"
		}
		return filepath.Join(files.Recordings, "recording-"+id+extension), nil
	}
	target := requested
	if !filepath.IsAbs(target) {
		target = filepath.Join(files.Root, filepath.FromSlash(requested))
	}
	relative, err := filepath.Rel(files.Root, target)
	if err != nil {
		return "", errors.New("recording path is invalid")
	}
	if _, err := sessionfiles.Normalize(filepath.ToSlash(relative)); err != nil {
		return "", errors.New("recording path is invalid")
	}
	if err := paths.ValidateTrustedPath(files.Recordings, target); err != nil || target == files.Recordings {
		return "", errors.New("recording path must be inside the recordings directory")
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", fmt.Errorf("create recording directory: %w", err)
	}
	// MkdirAll follows symlinks, so check again now that the directory exists.
	if err := paths.ValidateTrustedPath(files.Recordings, target); err != nil {
		return "", errors.New("recording path must be inside the recordings directory")
	}
	return target, nil
}

// MarshalJSON reports the recording's file relative to the session files root;
// host paths never leave the wrapper.
func (recording wrapperRecording) MarshalJSON() ([]byte, error) {
	type fields wrapperRecording
	relative := func(path string) string {
		if rel, err := filepath.Rel(recording.filesRoot, path); err == nil && path != "" {
			return filepath.ToSlash(rel)
		}
		return ""
	}
	path := relative(recording.Path)
	sandboxPath := ""
	if path != "" {
		sandboxPath = sessionfiles.SandboxPath(path)
	}
	return json.Marshal(struct {
		fields
		RelativePath string `json:"relativePath"`
		SandboxPath  string `json:"sandboxPath,omitempty"`
		// Path repeats RelativePath for clients that still read the field it replaced.
		// It used to carry a host path, which it never does now.
		Path                 string `json:"path"`
		EditedRelativePath   string `json:"editedRelativePath,omitempty"`
		TimelineRelativePath string `json:"timelineRelativePath,omitempty"`
	}{fields: fields(recording), RelativePath: path, SandboxPath: sandboxPath, Path: path,
		EditedRelativePath: relative(recording.EditedPath), TimelineRelativePath: relative(recording.TimelinePath)})
}

// publishRecording moves a finished recording into place without replacing an
// existing file, numbering the name instead, as uploads do.
func publishRecording(source, target string) (string, error) {
	// The target's directory may have been deleted since the recording started.
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", fmt.Errorf("finalize recording: %w", err)
	}
	extension := filepath.Ext(target)
	stem := strings.TrimSuffix(target, extension)
	for sequence := 0; ; sequence++ {
		candidate := target
		if sequence > 0 {
			candidate = fmt.Sprintf("%s-%d%s", stem, sequence, extension)
		}
		err := sessionfiles.RenameNoReplace(source, candidate)
		if errors.Is(err, unix.EEXIST) {
			continue
		}
		if err != nil {
			return "", fmt.Errorf("finalize recording: %w", err)
		}
		return candidate, nil
	}
}

func (session *liveSession) recording(recordingID string) (wrapperRecording, bool) {
	r := session.runtime
	r.mu.Lock()
	defer r.mu.Unlock()
	recording := session.recordings[recordingID]
	if recording == nil {
		return wrapperRecording{}, false
	}
	session.refreshRecordingLocked(recording)
	return *recording, true
}

func (session *liveSession) listRecordings() []wrapperRecording {
	r := session.runtime
	r.mu.Lock()
	defer r.mu.Unlock()
	return session.listRecordingsLocked()
}

func (session *liveSession) listRecordingsLocked() []wrapperRecording {
	recordings := make([]wrapperRecording, 0, len(session.recordings))
	for _, recording := range session.recordings {
		session.refreshRecordingLocked(recording)
		recordings = append(recordings, *recording)
	}
	sort.Slice(recordings, func(left int, right int) bool {
		return recordings[left].StartedAt.Before(recordings[right].StartedAt)
	})
	return recordings
}

// setRecordingStatusLocked changes a recording's status and refreshes the count the cadence reads without locks.
func (session *liveSession) setRecordingStatusLocked(recording *wrapperRecording, status wrapperRecordingStatus) {
	recording.Status = status
	if recording.cancelFollow != nil && (recording.stopping || status == wrapperRecordingStopped || status == wrapperRecordingFailed) {
		recording.cancelFollow()
	}
	var active, presentation int32
	for _, other := range session.recordings {
		if (other.Status == wrapperRecordingStarting || other.Status == wrapperRecordingRunning) && !other.stopping {
			active++
			if other.config.Presentation {
				presentation++
			}
		}
	}
	session.activeRecordings.Store(active)
	session.presentationRecordings.Store(presentation)
}

// refreshRecordings notices capture pipelines that have exited, which stops their recordings
// counting for the automation cadence, and keeps what they captured, outside the lock.
func (session *liveSession) refreshRecordings() {
	r := session.runtime
	r.mu.Lock()
	var exited []*wrapperRecording
	for _, recording := range session.recordings {
		session.refreshRecordingLocked(recording)
		if recording.unsalvaged {
			exited = append(exited, recording)
		}
	}
	r.mu.Unlock()
	for _, recording := range exited {
		salvaged := abandonRecordingSegments(recording.segmentDir, recording.Path)
		r.mu.Lock()
		recording.unsalvaged = false
		if salvaged != "" {
			recording.Path = salvaged
		}
		r.mu.Unlock()
	}
}

func (session *liveSession) activeRecordingCountLocked() int {
	count := 0
	for _, recording := range session.recordings {
		session.refreshRecordingLocked(recording)
		if recording.Status == wrapperRecordingStarting || recording.Status == wrapperRecordingRunning {
			count++
		}
	}
	return count
}

// editingRecordingCountLocked counts the recordings whose edit still runs; they are activity, so
// idle suspension does not end the session under a render.
func (session *liveSession) editingRecordingCountLocked() int {
	count := 0
	for _, recording := range session.recordings {
		if recording.Editing {
			count++
		}
	}
	return count
}

func (session *liveSession) refreshRecordingLocked(recording *wrapperRecording) {
	if recording.Status != wrapperRecordingRunning || recording.stopping || recording.replacing || recording.cmd == nil {
		return
	}
	select {
	case <-recording.done:
	default:
		return
	}
	recording.cmd = nil
	recording.done = nil
	session.markFailedLocked(recording, "pipeline_exited")
	recording.unsalvaged = true
}
