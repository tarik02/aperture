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
	"github.com/google/uuid"
)

const wrapperRecordingCapacity = 4

var errWrapperRecordingNotFound = errors.New("recording not found")

func cleanupPartialRecordings(recordingsDir string) error {
	entries, err := os.ReadDir(recordingsDir)
	if err != nil {
		return fmt.Errorf("read recordings directory: %w", err)
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), ".recording-") {
			continue
		}
		if err := os.RemoveAll(filepath.Join(recordingsDir, entry.Name())); err != nil {
			return fmt.Errorf("remove partial recording %s: %w", entry.Name(), err)
		}
	}
	return nil
}

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
	ID                string                      `json:"recordingId"`
	Mode              wrapperRecordingMode        `json:"mode"`
	TargetID          string                      `json:"targetId"`
	CaptureGeneration uint64                      `json:"captureGeneration"`
	Status            wrapperRecordingStatus      `json:"status"`
	StopReason        string                      `json:"stopReason,omitempty"`
	Path              string                      `json:"path"`
	StartedAt         time.Time                   `json:"startedAt"`
	StoppedAt         *time.Time                  `json:"stoppedAt,omitempty"`
	SizeBytes         int64                       `json:"sizeBytes,omitempty"`
	FPS               int                         `json:"fps"`
	BitrateKbps       int                         `json:"bitrateKbps"`
	Codec             string                      `json:"codec"`
	CDP               *wrapperCDPRecordingOptions `json:"cdp,omitempty"`
	AcceptedFrames    uint64                      `json:"acceptedFrames,omitempty"`
	DroppedFrames     uint64                      `json:"droppedFrames,omitempty"`
	segmentDir        string
	segments          []string
	cmd               *exec.Cmd
	done              <-chan error
	cdpSegment        *cdpRecordingSegment
	viewport          compositorViewport
	finalizing        bool
	replacing         bool
	clientID          string
	operationMu       *sync.Mutex
}

type wrapperRecordingRequest struct {
	Mode        wrapperRecordingMode        `json:"mode"`
	TargetID    string                      `json:"targetId"`
	ClientID    string                      `json:"clientId"`
	FPS         int                         `json:"fps"`
	BitrateKbps int                         `json:"bitrateKbps"`
	Codec       string                      `json:"codec"`
	Path        string                      `json:"path"`
	CDP         *wrapperCDPRecordingOptions `json:"cdp"`
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
		recording, err := session.startRecording(body)
		if err != nil {
			writeWrapperError(w, http.StatusConflict, err.Error())
			return
		}
		writeWrapperJSON(w, http.StatusCreated, recording)
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
	if len(parts) == 2 && parts[1] == "stop" && req.Method == http.MethodPost {
		recording, err := session.stopRecording(parts[0], "requested")
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

func (session *liveSession) startRecording(request wrapperRecordingRequest) (wrapperRecording, error) {
	r := session.runtime
	if r.values.RecordingMechanism == "" {
		return wrapperRecording{}, errors.New("recording is unavailable")
	}
	if strings.TrimSpace(request.TargetID) == "" {
		return wrapperRecording{}, errors.New("targetId is required")
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
	default:
		return wrapperRecording{}, errors.New("recording mode must be tab or viewer")
	}
	r.mu.Lock()
	registry := r.targets
	r.mu.Unlock()
	if registry == nil {
		return wrapperRecording{}, errors.New("target registry is unavailable")
	}
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
	codec, err := resolveWrapperRecordingCodec(request.Codec, r.values.MediaProducerCodec, r.values.GPUMode)
	if err != nil {
		return wrapperRecording{}, err
	}
	var cdpOptions wrapperCDPRecordingOptions
	if r.values.RecordingMechanism == RecordingMechanismCDP {
		cdpOptions, err = normalizeCDPRecordingOptions(request.CDP)
		if err != nil {
			return wrapperRecording{}, err
		}
	} else if request.CDP != nil {
		return wrapperRecording{}, errors.New("cdp options require the CDP recording mechanism")
	}
	id := uuid.NewString()
	path := strings.TrimSpace(request.Path)
	if path == "" {
		extension := ".webm"
		if codec == "h264-va" {
			extension = ".mkv"
		}
		path = filepath.Join(r.values.RecordingsDir, "recording-"+id+extension)
	}
	if !filepath.IsAbs(path) {
		return wrapperRecording{}, errors.New("recording path must be absolute")
	}
	if err := paths.ValidateTrustedPath(r.values.RecordingsDir, path); err != nil {
		return wrapperRecording{}, fmt.Errorf("recording path must be inside recordings root: %w", err)
	}
	segmentDir := filepath.Join(r.values.RecordingsDir, ".recording-"+id)
	if err := os.MkdirAll(segmentDir, 0o700); err != nil {
		return wrapperRecording{}, fmt.Errorf("mkdir recording segment dir: %w", err)
	}
	segment := filepath.Join(segmentDir, "segment-0000"+filepath.Ext(path))

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

	r.mu.Lock()
	active := 0
	for _, recording := range session.recordings {
		if recording.Status == wrapperRecordingStarting || recording.Status == wrapperRecordingRunning {
			active++
		}
	}
	if active >= wrapperRecordingCapacity {
		r.mu.Unlock()
		_ = os.RemoveAll(segmentDir)
		return wrapperRecording{}, fmt.Errorf("recording capacity of %d is exhausted", wrapperRecordingCapacity)
	}
	recording := &wrapperRecording{
		ID:                id,
		Mode:              request.Mode,
		TargetID:          target.TargetID,
		CaptureGeneration: target.Generation,
		Status:            wrapperRecordingStarting,
		Path:              path,
		StartedAt:         time.Now().UTC(),
		FPS:               fps,
		BitrateKbps:       bitrateKbps,
		Codec:             codec,
		segmentDir:        segmentDir,
		segments:          []string{segment},
		viewport:          target.Viewport,
		clientID:          request.ClientID,
		operationMu:       &sync.Mutex{},
	}
	if r.values.RecordingMechanism == RecordingMechanismCDP {
		recording.CDP = &cdpOptions
	}
	session.recordings[id] = recording
	if r.values.RecordingMechanism == RecordingMechanismCDP {
		recording.cdpSegment, err = startCDPRecordingSegment(
			r.ctx,
			r.values,
			target.TargetID,
			segment,
			fps,
			bitrateKbps,
			codec,
			cdpOptions,
			func(accepted uint64, dropped uint64) {
				r.mu.Lock()
				recording.AcceptedFrames += accepted
				recording.DroppedFrames += dropped
				r.mu.Unlock()
			},
		)
	} else {
		recording.cmd, recording.done, err = startWrapperScreencast(r.ctx, r.values, r.controlSocket, target.CaptureID, target.PipeWireTarget, target.Viewport, segment, fps, bitrateKbps, codec)
	}
	if err != nil {
		recording.Status = wrapperRecordingFailed
		recording.StopReason = "start_failed"
		r.mu.Unlock()
		_ = os.RemoveAll(segmentDir)
		_ = os.Remove(path)
		session.broadcastRecordings()
		return wrapperRecording{}, err
	}
	recording.Status = wrapperRecordingRunning
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

func (session *liveSession) stopRecordingForTarget(recordingID string, targetID string, reason string) (wrapperRecording, error) {
	r := session.runtime
	r.mu.Lock()
	recording := session.recordings[recordingID]
	if recording == nil {
		r.mu.Unlock()
		return wrapperRecording{}, errWrapperRecordingNotFound
	}
	r.mu.Unlock()
	defer session.broadcastRecordings()
	recording.operationMu.Lock()
	defer recording.operationMu.Unlock()

	r.mu.Lock()
	session.refreshRecordingLocked(recording)
	if targetID != "" && recording.TargetID != targetID {
		status := *recording
		r.mu.Unlock()
		return status, nil
	}
	if recording.Status == wrapperRecordingStopped {
		status := *recording
		r.mu.Unlock()
		return status, nil
	}
	if recording.Status == wrapperRecordingFailed {
		status := *recording
		r.mu.Unlock()
		return status, errors.New("recording has failed")
	}
	recording.finalizing = true
	r.mu.Unlock()

	if err := stopRecordingSegment(recording); err != nil {
		r.mu.Lock()
		recording.finalizing = false
		recording.Status = wrapperRecordingFailed
		recording.StopReason = "pipeline_failed"
		status := *recording
		r.mu.Unlock()
		session.removePartialRecording(recording)
		return status, err
	}
	if err := session.joinRecordingSegments(recording); err != nil {
		r.mu.Lock()
		recording.finalizing = false
		recording.Status = wrapperRecordingFailed
		recording.StopReason = "finalize_failed"
		status := *recording
		r.mu.Unlock()
		session.removePartialRecording(recording)
		return status, err
	}
	r.mu.Lock()
	stoppedAt := time.Now().UTC()
	recording.StoppedAt = &stoppedAt
	recording.Status = wrapperRecordingStopped
	recording.StopReason = reason
	recording.finalizing = false
	if info, err := os.Stat(recording.Path); err == nil {
		recording.SizeBytes = info.Size()
	}
	if recording.SizeBytes <= 0 {
		recording.Status = wrapperRecordingFailed
		status := *recording
		r.mu.Unlock()
		session.removePartialRecording(recording)
		return status, errors.New("recording is empty")
	}
	status := *recording
	r.mu.Unlock()
	return status, nil
}

func stopRecordingSegment(recording *wrapperRecording) error {
	if recording.cdpSegment != nil {
		stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		err := recording.cdpSegment.Stop(stopCtx)
		recording.cdpSegment = nil
		return err
	}
	if recording.cmd == nil || recording.cmd.Process == nil {
		return nil
	}
	select {
	case err := <-recording.done:
		recording.cmd = nil
		recording.done = nil
		recording.cdpSegment = nil
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

func (session *liveSession) rotateRecordingTarget(ctx context.Context, recording *wrapperRecording, target wrapperTargetSnapshot, expectedTargetID string) error {
	r := session.runtime
	recording.operationMu.Lock()
	defer recording.operationMu.Unlock()

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
	if recording.Mode == wrapperRecordingModeTab && recording.TargetID != target.TargetID {
		r.mu.Unlock()
		return errors.New("tab recording cannot switch targets")
	}
	recording.replacing = true
	segment := filepath.Join(recording.segmentDir, "segment-"+fmt.Sprintf("%04d", len(recording.segments))+filepath.Ext(recording.Path))
	fps := recording.FPS
	bitrateKbps := recording.BitrateKbps
	codec := recording.Codec
	var cdpOptions wrapperCDPRecordingOptions
	if recording.CDP != nil {
		cdpOptions = *recording.CDP
	}
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		recording.replacing = false
		r.mu.Unlock()
	}()

	var cmd *exec.Cmd
	var done <-chan error
	var cdpSegment *cdpRecordingSegment
	var err error
	if r.values.RecordingMechanism == RecordingMechanismCDP {
		cdpSegment, err = startCDPRecordingSegment(
			r.ctx,
			r.values,
			target.TargetID,
			segment,
			fps,
			bitrateKbps,
			codec,
			cdpOptions,
			func(accepted uint64, dropped uint64) {
				r.mu.Lock()
				recording.AcceptedFrames += accepted
				recording.DroppedFrames += dropped
				r.mu.Unlock()
			},
		)
		if err == nil {
			waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			select {
			case <-cdpSegment.Ready():
			case <-cdpSegment.Done():
				err = cdpSegment.Err()
				if err == nil {
					err = errors.New("replacement CDP recording exited before producing data")
				}
			case <-waitCtx.Done():
				err = fmt.Errorf("replacement CDP recording did not produce data: %w", waitCtx.Err())
			}
			cancel()
		}
	} else {
		cmd, done, err = startWrapperScreencast(r.ctx, r.values, r.controlSocket, target.CaptureID, target.PipeWireTarget, target.Viewport, segment, fps, bitrateKbps, codec)
		if err == nil {
			waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			for waitCtx.Err() == nil {
				if info, statErr := os.Stat(segment); statErr == nil && info.Size() > 0 {
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
	}
	if err != nil {
		if cmd != nil || cdpSegment != nil {
			replacement := &wrapperRecording{cmd: cmd, done: done, cdpSegment: cdpSegment}
			_ = stopRecordingSegment(replacement)
		}
		_ = os.Remove(segment)
		return err
	}
	if err := stopRecordingSegment(recording); err != nil {
		replacement := &wrapperRecording{cmd: cmd, done: done, cdpSegment: cdpSegment}
		_ = stopRecordingSegment(replacement)
		r.mu.Lock()
		recording.Status = wrapperRecordingFailed
		recording.StopReason = "replacement_failed"
		r.mu.Unlock()
		session.removePartialRecording(recording)
		return err
	}
	r.mu.Lock()
	recording.segments = append(recording.segments, segment)
	recording.cmd = cmd
	recording.done = done
	recording.cdpSegment = cdpSegment
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
		stoppedAt := time.Now().UTC()
		recording.cmd = nil
		recording.done = nil
		recording.StoppedAt = &stoppedAt
		recording.Status = wrapperRecordingFailed
		recording.StopReason = "replacement_rollback_failed"
		recording.replacing = false
		r.mu.Unlock()
		recording.operationMu.Unlock()
		session.removePartialRecording(recording)
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

func (session *liveSession) stopAllRecordings(reason string) {
	r := session.runtime
	r.mu.Lock()
	ids := make([]string, 0)
	for _, recording := range session.recordings {
		session.refreshRecordingLocked(recording)
		if recording.Status == wrapperRecordingStarting || recording.Status == wrapperRecordingRunning {
			ids = append(ids, recording.ID)
		}
	}
	r.mu.Unlock()
	for _, id := range ids {
		_, _ = session.stopRecording(id, reason)
	}
}

func (session *liveSession) discardAllRecordings(reason string) {
	r := session.runtime
	r.mu.Lock()
	recordings := make([]*wrapperRecording, 0)
	for _, recording := range session.recordings {
		session.refreshRecordingLocked(recording)
		if recording.Status == wrapperRecordingStarting || recording.Status == wrapperRecordingRunning {
			recordings = append(recordings, recording)
		}
	}
	r.mu.Unlock()
	for _, recording := range recordings {
		recording.operationMu.Lock()
		if recording.cdpSegment != nil {
			recording.cdpSegment.Abort()
			recording.cdpSegment = nil
		} else if recording.cmd != nil && recording.cmd.Process != nil {
			_ = recording.cmd.Process.Kill()
			if recording.done != nil {
				<-recording.done
			}
			recording.cmd = nil
			recording.done = nil
		}
		session.removePartialRecording(recording)
		r.mu.Lock()
		stoppedAt := time.Now().UTC()
		recording.StoppedAt = &stoppedAt
		recording.Status = wrapperRecordingFailed
		recording.StopReason = reason
		r.mu.Unlock()
		recording.operationMu.Unlock()
	}
}

func (session *liveSession) removePartialRecording(recording *wrapperRecording) {
	_ = os.Remove(recording.Path)
	_ = os.RemoveAll(recording.segmentDir)
}

func (session *liveSession) joinRecordingSegments(recording *wrapperRecording) error {
	r := session.runtime
	if err := joinRecordingFiles(r.ctx, r.values, recording.Codec, recording.segments, recording.Path); err != nil {
		return err
	}
	return os.RemoveAll(recording.segmentDir)
}

func joinRecordingFiles(ctx context.Context, values RuntimeEnvValues, codec string, segments []string, path string) error {
	if len(segments) == 0 {
		return errors.New("recording has no segments")
	}
	if len(segments) == 1 {
		if err := os.Rename(segments[0], path); err != nil {
			return fmt.Errorf("finalize recording: %w", err)
		}
		return nil
	}
	mux := "webmmux"
	parser := ""
	if codec == "h264-va" {
		parser = "h264parse"
		mux = "matroskamux"
	}
	args := []string{"concat", "name=join", "!", "queue", "!", mux, "!", "filesink", "location=" + path, "sync=false"}
	for _, segment := range segments {
		args = append(args, "filesrc", "location="+segment, "!", "matroskademux", "!", "queue", "!")
		if parser != "" {
			args = append(args, parser, "!")
		}
		args = append(args, "join.")
	}
	cmd := exec.CommandContext(ctx, values.MediaProducerGSTExecutable, args...)
	cmd.Env = wrapperMediaProcessEnv(values.MediaProducerPluginPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("join recording segments: %w", err)
	}
	return nil
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

func (session *liveSession) refreshRecordingLocked(recording *wrapperRecording) {
	if recording.Status != wrapperRecordingRunning || recording.finalizing || recording.replacing {
		return
	}
	if recording.cdpSegment != nil {
		select {
		case <-recording.cdpSegment.Done():
		default:
			return
		}
		recording.cdpSegment = nil
		recording.StopReason = "encoder_exited"
	} else if recording.cmd != nil {
		select {
		case <-recording.done:
		default:
			return
		}
		recording.cmd = nil
		recording.done = nil
		recording.StopReason = "pipeline_exited"
	} else {
		return
	}
	recording.Status = wrapperRecordingFailed
	stoppedAt := time.Now().UTC()
	recording.StoppedAt = &stoppedAt
	session.removePartialRecording(recording)
}
