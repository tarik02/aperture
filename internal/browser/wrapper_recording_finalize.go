package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// RecordingArtifacts reports published files; private worker paths never cross
// the session boundary. Raw capture remains available if finalization fails.
type RecordingArtifacts struct {
	CaptureRelativePath  string   `json:"captureRelativePath,omitempty"`
	ActionsRelativePath  string   `json:"actionsRelativePath,omitempty"`
	ConfigRelativePath   string   `json:"configRelativePath,omitempty"`
	TimelineRelativePath string   `json:"timelineRelativePath,omitempty"`
	EditedRelativePath   string   `json:"editedRelativePath,omitempty"`
	FinalizeError        string   `json:"finalizeError,omitempty"`
	Warnings             []string `json:"warnings,omitempty"`
}
type recordingFinalizeResult struct {
	Version  int      `json:"version"`
	Timeline bool     `json:"timeline"`
	Edited   bool     `json:"edited"`
	Warnings []string `json:"warnings"`
}

func (session *liveSession) finalizeRecording(recording *wrapperRecording, raw string) (RecordingArtifacts, string, int64, error) {
	artifacts := RecordingArtifacts{}
	segments, complete := recording.capture.snapshot()
	capture := struct {
		Version          int              `json:"version"`
		RecordingID      string           `json:"recordingId"`
		Video            string           `json:"video"`
		FPS              int              `json:"fps"`
		Segments         []captureSegment `json:"segments"`
		ActivityComplete bool             `json:"activityComplete"`
		ActionsComplete  bool             `json:"actionsComplete"`
		Warnings         []string         `json:"warnings"`
	}{1, recording.ID, filepath.Base(raw), recording.FPS, segments, complete, recording.actionsComplete, recording.sourceWarnings}
	var sourceErr error
	for name, source := range map[string]any{"capture.json": capture, "config.json": recording.Config} {
		encoded, err := json.Marshal(source)
		if err == nil {
			err = os.WriteFile(filepath.Join(recording.segmentDir, name), encoded, 0o600)
		}
		if err != nil {
			sourceErr = errors.Join(sourceErr, fmt.Errorf("write %s: %w", name, err))
		}
	}
	var result recordingFinalizeResult
	if sourceErr == nil {
		var err error
		result, err = runRecordingFinalizer(session.runtime.ctx, session.runtime.values, recording.segmentDir)
		if err != nil {
			artifacts.FinalizeError = "recording finalization failed; raw capture was preserved"
			fmt.Fprintf(os.Stderr, "browser-session-wrapper: finalize recording %s: %v\n", recording.ID, err)
		}
	} else {
		artifacts.FinalizeError = "recording sources could not be written; raw capture was preserved"
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: recording sources %s: %v\n", recording.ID, sourceErr)
	}
	artifacts.Warnings = result.Warnings
	info, err := os.Stat(raw)
	if err != nil {
		return artifacts, "", 0, err
	}
	if info.Size() == 0 {
		return artifacts, "", 0, errWrapperRecordingEmpty
	}
	final, err := publishRecording(raw, recording.Path)
	if err != nil {
		return artifacts, "", 0, err
	}
	// Each file is atomically renamed after the worker exits. Its requested name
	// follows the actual raw filename, including any collision suffix.
	outputs := []struct {
		name     string
		path     *string
		required bool
	}{
		{"capture.json", &artifacts.CaptureRelativePath, true},
		{"actions.ndjson", &artifacts.ActionsRelativePath, true},
		{"config.json", &artifacts.ConfigRelativePath, true},
		{"timeline.json", &artifacts.TimelineRelativePath, result.Timeline},
		{"edited.mp4", &artifacts.EditedRelativePath, result.Edited},
	}
	publicationComplete := true
	for _, output := range outputs {
		source := filepath.Join(recording.segmentDir, output.name)
		file, statErr := os.Lstat(source)
		if statErr != nil || !file.Mode().IsRegular() || (file.Size() == 0 && output.name != "actions.ndjson") {
			if output.required {
				artifacts.Warnings = append(artifacts.Warnings, "finalizer output unavailable: "+output.name)
			}
			continue
		}
		// An interrupted render may leave an incomplete MP4, which is never published.
		if output.name == "edited.mp4" && !result.Edited {
			continue
		}
		published, err := publishRecording(source, final+"."+output.name)
		if err != nil {
			publicationComplete = false
			artifacts.Warnings = append(artifacts.Warnings, "could not publish "+output.name)
			continue
		}
		*output.path = recordingRelativeArtifact(recording, published)
	}
	if publicationComplete {
		if err := os.RemoveAll(recording.segmentDir); err != nil {
			artifacts.Warnings = append(artifacts.Warnings, "private recording directory cleanup failed")
		}
	} else {
		artifacts.Warnings = append(artifacts.Warnings, "unpublished recording files preserved in the private recording directory")
	}
	return artifacts, final, info.Size(), nil
}

func runRecordingFinalizer(parent context.Context, values RuntimeEnvValues, work string) (recordingFinalizeResult, error) {
	worker := "aperture-recording-worker"
	if executable, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(executable), worker)
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
			worker = candidate
		}
	}
	request, err := json.Marshal(struct {
		FFmpeg string `json:"ffmpeg"`
	}{values.RecordingFFmpegExecutable})
	if err != nil {
		return recordingFinalizeResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, worker)
	command.Dir = work
	command.Env = append(os.Environ(), "HOME="+work, "TMPDIR="+work)
	command.Stdin = bytes.NewReader(request)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGTERM}
	command.Cancel = func() error { return unix.Kill(-command.Process.Pid, unix.SIGKILL) }
	command.WaitDelay = 5 * time.Second
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		diagnostic := strings.TrimSpace(stderr.String())
		if diagnostic == "" {
			diagnostic = strings.TrimSpace(stdout.String())
		}
		return recordingFinalizeResult{}, fmt.Errorf("finalizer: %w: %s", err, diagnostic[max(0, len(diagnostic)-2048):])
	}
	if stdout.Len() > 65536 {
		return recordingFinalizeResult{}, errors.New("finalizer result is too large")
	}
	var result recordingFinalizeResult
	decoder := json.NewDecoder(&stdout)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil || result.Version != 1 {
		return recordingFinalizeResult{}, errors.New("invalid finalizer result")
	}
	return result, nil
}

func recordingRawName(codec string) string {
	if codec == "h264-va" {
		return "raw.mkv"
	}
	return "raw.webm"
}
