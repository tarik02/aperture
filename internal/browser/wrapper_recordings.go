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
	"syscall"
	"time"

	"github.com/aperture/aperture/internal/paths"
	"github.com/google/uuid"
)

const wrapperRecordingCapacity = 4

var errWrapperRecordingNotFound = errors.New("recording not found")

type wrapperRecordingStatus string

const (
	wrapperRecordingStarting wrapperRecordingStatus = "starting"
	wrapperRecordingRunning  wrapperRecordingStatus = "running"
	wrapperRecordingStopped  wrapperRecordingStatus = "stopped"
	wrapperRecordingFailed   wrapperRecordingStatus = "failed"
)

type wrapperRecording struct {
	ID                string                 `json:"recordingId"`
	TargetID          string                 `json:"targetId"`
	CaptureGeneration uint64                 `json:"captureGeneration"`
	Status            wrapperRecordingStatus `json:"status"`
	StopReason        string                 `json:"stopReason,omitempty"`
	Path              string                 `json:"path"`
	StartedAt         time.Time              `json:"startedAt"`
	StoppedAt         *time.Time             `json:"stoppedAt,omitempty"`
	SizeBytes         int64                  `json:"sizeBytes,omitempty"`
	FPS               int                    `json:"fps"`
	BitrateKbps       int                    `json:"bitrateKbps"`
	Codec             string                 `json:"codec"`
	segmentDir        string
	segments          []string
	cmd               *exec.Cmd
	done              <-chan error
	finalizing        bool
	replacing         bool
}

type wrapperRecordingRequest struct {
	TargetID    string `json:"targetId"`
	FPS         int    `json:"fps"`
	BitrateKbps int    `json:"bitrateKbps"`
	Codec       string `json:"codec"`
	Path        string `json:"path"`
}

func (r *wrapperRuntime) handleRecordings(w http.ResponseWriter, req *http.Request) {
	switch req.Method {
	case http.MethodGet:
		writeWrapperJSON(w, http.StatusOK, r.listRecordings())
	case http.MethodPost:
		var body wrapperRecordingRequest
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			writeWrapperError(w, http.StatusBadRequest, "invalid recording request")
			return
		}
		if req.Header.Get("X-Aperture-Actor-Kind") == "session_capability" {
			body.Path = ""
		}
		recording, err := r.startRecording(body)
		if err != nil {
			writeWrapperError(w, http.StatusConflict, err.Error())
			return
		}
		writeWrapperJSON(w, http.StatusCreated, recording)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (r *wrapperRuntime) handleRecording(w http.ResponseWriter, req *http.Request) {
	path := strings.TrimPrefix(req.URL.Path, "/recordings/")
	parts := strings.Split(path, "/")
	if len(parts) == 1 && req.Method == http.MethodGet {
		recording, exists := r.recording(parts[0])
		if !exists {
			writeWrapperError(w, http.StatusNotFound, "recording not found")
			return
		}
		writeWrapperJSON(w, http.StatusOK, recording)
		return
	}
	if len(parts) == 2 && parts[1] == "stop" && req.Method == http.MethodPost {
		recording, err := r.stopRecording(parts[0], "requested")
		if err != nil {
			if errors.Is(err, errWrapperRecordingNotFound) {
				writeWrapperError(w, http.StatusNotFound, err.Error())
				return
			}
			writeWrapperError(w, http.StatusConflict, err.Error())
			return
		}
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(recording.Path)))
		contentType := "video/webm"
		if recording.Codec == "h264-va" {
			contentType = "video/x-matroska"
		}
		w.Header().Set("Content-Type", contentType)
		http.ServeFile(w, req, recording.Path)
		return
	}
	w.WriteHeader(http.StatusMethodNotAllowed)
}

func (r *wrapperRuntime) startRecording(request wrapperRecordingRequest) (wrapperRecording, error) {
	r.mu.Lock()
	registry := r.targets
	r.mu.Unlock()
	if registry == nil {
		return wrapperRecording{}, errors.New("target registry is unavailable")
	}
	target, exists := registry.readyTarget(request.TargetID)
	if !exists {
		return wrapperRecording{}, errors.New("target is not ready")
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

	r.mu.Lock()
	active := 0
	for _, recording := range r.recordings {
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
	}
	r.recordings[id] = recording
	cmd, done, err := startWrapperScreencast(r.ctx, r.values, target.PipeWireTarget, segment, fps, bitrateKbps, codec)
	if err != nil {
		recording.Status = wrapperRecordingFailed
		recording.StopReason = "start_failed"
		r.mu.Unlock()
		return wrapperRecording{}, err
	}
	recording.cmd = cmd
	recording.done = done
	recording.Status = wrapperRecordingRunning
	status := *recording
	r.mu.Unlock()
	return status, nil
}

func (r *wrapperRuntime) stopRecording(recordingID string, reason string) (wrapperRecording, error) {
	r.mu.Lock()
	recording := r.recordings[recordingID]
	if recording == nil {
		r.mu.Unlock()
		return wrapperRecording{}, errWrapperRecordingNotFound
	}
	r.refreshRecordingLocked(recording)
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
	if recording.finalizing || recording.replacing {
		r.mu.Unlock()
		return wrapperRecording{}, errors.New("recording is changing capture source")
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
		return status, err
	}
	if err := r.joinRecordingSegments(recording); err != nil {
		r.mu.Lock()
		recording.finalizing = false
		recording.Status = wrapperRecordingFailed
		recording.StopReason = "finalize_failed"
		status := *recording
		r.mu.Unlock()
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
		return status, errors.New("recording is empty")
	}
	status := *recording
	r.mu.Unlock()
	return status, nil
}

func stopRecordingSegment(recording *wrapperRecording) error {
	if recording.cmd == nil || recording.cmd.Process == nil {
		return nil
	}
	if recording.cmd.ProcessState != nil {
		err := <-recording.done
		recording.cmd = nil
		recording.done = nil
		if err != nil {
			return fmt.Errorf("recording pipeline stopped: %w", err)
		}
		return nil
	}
	_ = recording.cmd.Process.Signal(syscall.SIGINT)
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case err := <-recording.done:
		if err != nil {
			return fmt.Errorf("recording pipeline stopped: %w", err)
		}
	case <-timer.C:
		_ = recording.cmd.Process.Kill()
		<-recording.done
	}
	recording.cmd = nil
	recording.done = nil
	return nil
}

func (r *wrapperRuntime) replaceRecordingTargets(ctx context.Context, target wrapperTargetSnapshot) error {
	r.mu.Lock()
	recordings := make([]*wrapperRecording, 0)
	for _, recording := range r.recordings {
		if recording.TargetID != target.TargetID || recording.Status != wrapperRecordingRunning || recording.CaptureGeneration == target.Generation {
			continue
		}
		r.refreshRecordingLocked(recording)
		if recording.Status != wrapperRecordingRunning || recording.finalizing || recording.replacing {
			continue
		}
		recording.replacing = true
		recordings = append(recordings, recording)
	}
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		for _, recording := range recordings {
			recording.replacing = false
		}
		r.mu.Unlock()
	}()
	for _, recording := range recordings {
		segment := filepath.Join(recording.segmentDir, "segment-"+fmt.Sprintf("%04d", len(recording.segments))+filepath.Ext(recording.Path))
		cmd, done, err := startWrapperScreencast(r.ctx, r.values, target.PipeWireTarget, segment, recording.FPS, recording.BitrateKbps, recording.Codec)
		if err == nil {
			waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			for waitCtx.Err() == nil {
				if info, statErr := os.Stat(segment); statErr == nil && info.Size() > 0 {
					break
				}
				if cmd.ProcessState != nil {
					err = errors.New("replacement recording pipeline exited before producing data")
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
			r.mu.Lock()
			recording.replacing = false
			r.mu.Unlock()
			return err
		}
		if err := stopRecordingSegment(recording); err != nil {
			replacement := &wrapperRecording{cmd: cmd, done: done}
			_ = stopRecordingSegment(replacement)
			r.mu.Lock()
			recording.replacing = false
			recording.Status = wrapperRecordingFailed
			recording.StopReason = "replacement_failed"
			r.mu.Unlock()
			return err
		}
		r.mu.Lock()
		recording.segments = append(recording.segments, segment)
		recording.cmd = cmd
		recording.done = done
		recording.CaptureGeneration = target.Generation
		recording.replacing = false
		r.mu.Unlock()
	}
	return nil
}

func (r *wrapperRuntime) failRecordingTargets(targetID string, generation uint64) {
	r.mu.Lock()
	recordings := make([]*wrapperRecording, 0)
	for _, recording := range r.recordings {
		if recording.TargetID != targetID || recording.CaptureGeneration == generation || recording.Status != wrapperRecordingRunning {
			continue
		}
		recording.replacing = true
		recordings = append(recordings, recording)
	}
	r.mu.Unlock()
	for _, recording := range recordings {
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
	}
}

func (r *wrapperRuntime) stopTargetRecordings(targetID string) {
	r.mu.Lock()
	ids := make([]string, 0)
	for _, recording := range r.recordings {
		if recording.TargetID == targetID && recording.Status == wrapperRecordingRunning {
			ids = append(ids, recording.ID)
		}
	}
	r.mu.Unlock()
	for _, id := range ids {
		_, _ = r.stopRecording(id, "target_closed")
	}
}

func (r *wrapperRuntime) stopAllRecordings(reason string) {
	r.mu.Lock()
	ids := make([]string, 0)
	for _, recording := range r.recordings {
		r.refreshRecordingLocked(recording)
		if recording.Status == wrapperRecordingStarting || recording.Status == wrapperRecordingRunning {
			ids = append(ids, recording.ID)
		}
	}
	r.mu.Unlock()
	for _, id := range ids {
		_, _ = r.stopRecording(id, reason)
	}
}

func (r *wrapperRuntime) joinRecordingSegments(recording *wrapperRecording) error {
	if len(recording.segments) == 1 {
		if err := os.Rename(recording.segments[0], recording.Path); err != nil {
			return fmt.Errorf("finalize recording: %w", err)
		}
		return os.RemoveAll(recording.segmentDir)
	}
	mux := "webmmux"
	parser := ""
	if recording.Codec == "h264-va" {
		parser = "h264parse"
		mux = "matroskamux"
	}
	args := []string{"concat", "name=join", "!", "queue", "!", mux, "!", "filesink", "location=" + recording.Path, "sync=false"}
	for _, segment := range recording.segments {
		args = append(args, "filesrc", "location="+segment, "!", "matroskademux", "!", "queue", "!")
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
		return fmt.Errorf("join recording segments: %w", err)
	}
	return os.RemoveAll(recording.segmentDir)
}

func (r *wrapperRuntime) recording(recordingID string) (wrapperRecording, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	recording := r.recordings[recordingID]
	if recording == nil {
		return wrapperRecording{}, false
	}
	r.refreshRecordingLocked(recording)
	return *recording, true
}

func (r *wrapperRuntime) listRecordings() []wrapperRecording {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.listRecordingsLocked()
}

func (r *wrapperRuntime) listRecordingsLocked() []wrapperRecording {
	recordings := make([]wrapperRecording, 0, len(r.recordings))
	for _, recording := range r.recordings {
		r.refreshRecordingLocked(recording)
		recordings = append(recordings, *recording)
	}
	sort.Slice(recordings, func(left int, right int) bool {
		return recordings[left].StartedAt.Before(recordings[right].StartedAt)
	})
	return recordings
}

func (r *wrapperRuntime) activeRecordingCountLocked() int {
	count := 0
	for _, recording := range r.recordings {
		r.refreshRecordingLocked(recording)
		if recording.Status == wrapperRecordingStarting || recording.Status == wrapperRecordingRunning {
			count++
		}
	}
	return count
}

func (r *wrapperRuntime) refreshRecordingLocked(recording *wrapperRecording) {
	if recording.Status != wrapperRecordingRunning || recording.finalizing || recording.replacing || recording.cmd == nil || recording.cmd.ProcessState == nil {
		return
	}
	select {
	case <-recording.done:
	default:
		return
	}
	recording.cmd = nil
	recording.done = nil
	recording.Status = wrapperRecordingFailed
	recording.StopReason = "pipeline_exited"
	stoppedAt := time.Now().UTC()
	recording.StoppedAt = &stoppedAt
}
