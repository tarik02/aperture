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
	"runtime"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const recordingWorkerName = "aperture-recording-worker"

var errWrapperRecordingEffectsUnavailable = errors.New("recording effects need ffmpeg, which this host does not have")

// RecordingEdit is what stopping a recording made of its effects: the edited video
// (its path below the files root), why there is none although effects applied, and
// what was left out.
type RecordingEdit struct {
	EditedRelativePath string   `json:"editedRelativePath,omitempty"`
	EditError          string   `json:"editError,omitempty"`
	EditWarnings       []string `json:"editWarnings,omitempty"`
}

type recordingRenderRequest struct {
	Version  int              `json:"version"`
	FFmpeg   string           `json:"ffmpeg"`
	FPS      int              `json:"fps"`
	Effects  recordingEffects `json:"effects"`
	Timeline timelineDoc      `json:"timeline"`
}

type recordingRenderResult struct {
	Version  int      `json:"version"`
	Rendered bool     `json:"rendered"`
	Warnings []string `json:"warnings"`
}

// sweepEditDirs removes the work directories a previous wrapper process left behind.
func sweepEditDirs(recordingsDir string) {
	stale, _ := filepath.Glob(filepath.Join(recordingsDir, ".edit-*"))
	for _, dir := range stale {
		_ = os.RemoveAll(dir)
	}
}

// editRecording asks the stateless worker to plan and render a stopped recording.
// A render failure is reported in the stop result rather than failing the stop.
func (session *liveSession) editRecording(recording *wrapperRecording, video string, doc timelineDoc, timelineErr error) RecordingEdit {
	if recording.timeline == nil {
		return RecordingEdit{}
	}
	if timelineErr != nil {
		return recordingEditFailure(recording.ID, timelineErr)
	}
	result, output, err := renderRecording(session.renders, session.runtime.values, filepath.Dir(recording.segmentDir), recording.ID, video, recording.FPS, recording.effects, doc)
	if err != nil {
		return recordingEditFailure(recording.ID, err)
	}
	if !result.Rendered {
		return RecordingEdit{EditWarnings: result.Warnings}
	}
	relative, err := filepath.Rel(recording.filesRoot, output)
	if err != nil {
		return recordingEditFailure(recording.ID, err)
	}
	return RecordingEdit{EditedRelativePath: filepath.ToSlash(relative), EditWarnings: result.Warnings}
}

func recordingEditFailure(id string, err error) RecordingEdit {
	fmt.Fprintf(os.Stderr, "browser-session-wrapper: recording %s edit: %v\n", id, err)
	return RecordingEdit{EditError: err.Error()}
}

// renderRecording gives the worker the canonical timeline on stdin and the source
// video as descriptor 3. The worker owns planning and ffmpeg; Go only supervises it
// and atomically publishes its fixed output file.
func renderRecording(parent context.Context, values RuntimeEnvValues, recordingsDir, id, video string, fps int, effects recordingEffects, timeline timelineDoc) (recordingRenderResult, string, error) {
	if values.RecordingFFmpegExecutable == "" {
		return recordingRenderResult{}, "", errWrapperRecordingEffectsUnavailable
	}
	worker, err := recordingWorkerPath()
	if err != nil {
		return recordingRenderResult{}, "", err
	}
	request, err := json.Marshal(recordingRenderRequest{
		Version: 1, FFmpeg: values.RecordingFFmpegExecutable, FPS: min(fps, 60), Effects: effects, Timeline: timeline,
	})
	if err != nil {
		return recordingRenderResult{}, "", fmt.Errorf("encode recording render request: %w", err)
	}

	work := filepath.Join(recordingsDir, ".edit-"+id)
	_ = os.RemoveAll(work)
	if err := os.Mkdir(work, 0o700); err != nil {
		return recordingRenderResult{}, "", err
	}
	defer func() { _ = os.RemoveAll(work) }()

	fd, err := unix.Open(video, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return recordingRenderResult{}, "", err
	}
	source := os.NewFile(uintptr(fd), video)
	defer func() { _ = source.Close() }()
	if info, err := source.Stat(); err != nil || !info.Mode().IsRegular() {
		return recordingRenderResult{}, "", errors.New("the recording is not a regular file")
	}

	timeout := min(30*time.Second+10*time.Duration(timeline.DurationMS)*time.Millisecond, 30*time.Minute)
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	command := exec.CommandContext(ctx, worker)
	command.Dir = work
	command.Env = []string{"HOME=" + work, "TMPDIR=" + work}
	if values.CacheDir != "" {
		cache := filepath.Join(values.CacheDir, "ffmpeg")
		_ = os.MkdirAll(cache, 0o700)
		command.Env = append(command.Env, "XDG_CACHE_HOME="+cache)
	}
	for _, name := range []string{"PATH", "FONTCONFIG_FILE", "FONTCONFIG_PATH", "LANG"} {
		if value := os.Getenv(name); value != "" {
			command.Env = append(command.Env, name+"="+value)
		}
	}
	command.Stdin = bytes.NewReader(request)
	command.ExtraFiles = []*os.File{source}
	command.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM, Setpgid: true}
	command.Cancel = func() error {
		if command.Process == nil {
			return nil
		}
		return unix.Kill(-command.Process.Pid, unix.SIGTERM)
	}
	command.WaitDelay = 5 * time.Second
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := runNiced(command); err != nil {
		switch {
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			return recordingRenderResult{}, "", fmt.Errorf("render timed out after %ds", int(timeout.Seconds()))
		case ctx.Err() != nil:
			return recordingRenderResult{}, "", errors.New("render cancelled: the session is closing")
		}
		message := strings.TrimSpace(stderr.String())
		return recordingRenderResult{}, "", fmt.Errorf("recording render worker failed: %w: %s", err, strings.ToValidUTF8(message[max(len(message)-2000, 0):], ""))
	}
	if stdout.Len() > 64*1024 {
		return recordingRenderResult{}, "", errors.New("recording render worker returned too much output")
	}
	var result recordingRenderResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil || result.Version != 1 {
		return recordingRenderResult{}, "", errors.New("recording render worker returned an invalid result")
	}
	if !result.Rendered {
		return result, "", nil
	}
	output := filepath.Join(work, "edited.mp4")
	if info, err := os.Lstat(output); err != nil || !info.Mode().IsRegular() {
		return recordingRenderResult{}, "", errors.New("recording render worker did not produce a regular video file")
	}
	published, err := publishRecording(output, video+".edited.mp4")
	return result, published, err
}

func recordingWorkerPath() (string, error) {
	if executable, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(executable), recordingWorkerName)
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	path, err := exec.LookPath(recordingWorkerName)
	if err != nil {
		return "", fmt.Errorf("locate %s: %w", recordingWorkerName, err)
	}
	return path, nil
}

// runNiced starts a command from a locked low-priority thread. The child inherits
// that priority, and Go discards the thread after this goroutine exits.
func runNiced(command *exec.Cmd) error {
	result := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		_ = unix.Setpriority(unix.PRIO_PROCESS, unix.Gettid(), 10)
		result <- command.Run()
	}()
	return <-result
}
