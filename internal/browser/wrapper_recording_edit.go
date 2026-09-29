package browser

import (
	"bytes"
	"context"
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

var errWrapperRecordingEffectsUnavailable = errors.New("recording effects need ffmpeg, which this host does not have")

// recordingEdit is what stopping a recording made of its effects: the edited video
// (its path below the files root), why there is none although effects applied, and
// what was left out.
type recordingEdit struct {
	Path     string   `json:"editedRelativePath,omitempty"`
	Error    string   `json:"editError,omitempty"`
	Warnings []string `json:"editWarnings,omitempty"`
}

// sweepEditDirs removes the work directories a previous wrapper process left behind.
func sweepEditDirs(recordingsDir string) {
	stale, _ := filepath.Glob(filepath.Join(recordingsDir, ".edit-*"))
	for _, dir := range stale {
		_ = os.RemoveAll(dir)
	}
}

// renderOnStop makes the stop that follows render the recording's effects. Only the
// HTTP stop route asks for it, which is what the API and MCP use; a stop by the live
// session protocol or by the recording ending does not wait for a render.
func (session *liveSession) renderOnStop(recordingID string) {
	session.runtime.mu.Lock()
	defer session.runtime.mu.Unlock()
	if recording := session.recordings[recordingID]; recording != nil {
		recording.renderOnStop = true
	}
}

// editRecording renders the effects a stopped recording asked for into `<video>.edited.mp4`
// next to it. The video and its timeline are only read, and a failure is reported
// instead of failing the stop.
func (session *liveSession) editRecording(recording *wrapperRecording, video string) recordingEdit {
	if !recording.renderOnStop || recording.timeline == nil {
		return recordingEdit{}
	}
	r := session.runtime
	doc, err := recording.timeline.build(recording.ID, "")
	var plan *editPlan
	if err == nil {
		plan, err = buildEditPlan(doc, recording.effects, recording.FPS)
	}
	if plan == nil && err == nil {
		return recordingEdit{}
	}
	output := ""
	if err == nil && plan.filter != "" {
		if output, err = renderEdit(r.ctx, r.values, filepath.Dir(video), recording.ID, video, plan); err == nil {
			output, err = filepath.Rel(recording.filesRoot, output)
		}
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: recording %s edit: %v\n", recording.ID, err)
		return recordingEdit{Error: err.Error()}
	}
	return recordingEdit{Path: filepath.ToSlash(output), Warnings: plan.warnings}
}

// renderEdit runs ffmpeg on the plan and publishes its output next to the video.
func renderEdit(parent context.Context, values RuntimeEnvValues, dir, id, video string, plan *editPlan) (string, error) {
	if values.RecordingFFmpegExecutable == "" {
		return "", errWrapperRecordingEffectsUnavailable
	}
	work := filepath.Join(dir, ".edit-"+id)
	if err := os.MkdirAll(work, 0o700); err != nil {
		return "", err
	}
	defer func() { _ = os.RemoveAll(work) }()
	if plan.ass != nil {
		if err := os.WriteFile(filepath.Join(work, "captions.ass"), plan.ass, 0o600); err != nil {
			return "", err
		}
	}
	// The video is opened once, without following a link, and ffmpeg reads that very
	// file as descriptor 3, as the one container format and no other protocol.
	fd, err := unix.Open(video, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return "", err
	}
	source := os.NewFile(uintptr(fd), video)
	defer func() { _ = source.Close() }()
	if info, err := source.Stat(); err != nil || !info.Mode().IsRegular() {
		return "", errors.New("the recording is not a regular file")
	}
	ctx, cancel := context.WithTimeout(parent, min(30*time.Second+10*time.Duration(plan.durationMS)*time.Millisecond, 30*time.Minute))
	defer cancel()
	cache := filepath.Join(values.CacheDir, "ffmpeg") // fontconfig takes seconds to build its cache
	_ = os.MkdirAll(cache, 0o700)
	cmd := exec.CommandContext(ctx, values.RecordingFFmpegExecutable, "-hide_banner", "-nostdin", "-loglevel", "error", "-xerror", "-y",
		"-protocol_whitelist", "file", "-f", "matroska,webm", "-i", "file:/dev/fd/3",
		"-map", "0:v:0", "-an", "-sn", "-dn", "-vf", plan.filter,
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
		"-fps_mode", "passthrough", "-movflags", "+faststart", "-f", "mp4", "edited.mp4")
	cmd.Dir = work
	cmd.Env = []string{"HOME=" + work, "TMPDIR=" + work, "XDG_CACHE_HOME=" + cache}
	for _, name := range []string{"PATH", "FONTCONFIG_FILE", "FONTCONFIG_PATH", "LANG"} {
		if value := os.Getenv(name); value != "" {
			cmd.Env = append(cmd.Env, name+"="+value)
		}
	}
	cmd.ExtraFiles = []*os.File{source}
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL} // ffmpeg does not outlive the wrapper
	cmd.WaitDelay = 5 * time.Second
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := runNiced(cmd); err != nil {
		message := strings.TrimSpace(stderr.String())
		return "", fmt.Errorf("ffmpeg failed: %w: %s", err, message[max(len(message)-1000, 0):])
	}
	return publishRecording(filepath.Join(work, "edited.mp4"), video+".edited.mp4")
}

// runNiced runs a command at low priority so it yields to the live session. Priority
// is per thread on Linux and a child inherits its starting thread's, so the command
// starts from a goroutine whose thread was made nice first. That goroutine keeps its
// thread until the command ends, since Pdeathsig fires when the thread that started
// the command exits, and Go discards a thread whose goroutine ended locked, so the
// priority never spreads.
func runNiced(cmd *exec.Cmd) error {
	result := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		_ = unix.Setpriority(unix.PRIO_PROCESS, unix.Gettid(), 10)
		result <- cmd.Run()
	}()
	return <-result
}
