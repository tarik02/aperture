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
	"time"

	"golang.org/x/sys/unix"
)

// recordingEditError says why a recording that asked for an edit, or has a timeline to publish,
// has none. It never fails the stop: the raw video is always published.
type recordingEditError struct {
	Code    string `json:"code"` // ffmpeg_unavailable, analysis_failed, plan_failed, render_failed, timeout or timeline_failed
	Message string `json:"message"`
}

var errFFmpegUnavailable = errors.New("recording edits need ffmpeg, which is not configured")

// renderTimeout is how long analysing and rendering a recording of the given length may take.
func renderTimeout(videoMS int64) time.Duration {
	return min(max(30*time.Second+10*time.Duration(videoMS)*time.Millisecond, 2*time.Minute), 30*time.Minute)
}

// finalizeRecording turns a stopped recording's journal into a timeline and, when it asks for
// something to apply (bursts, idle, captions, focus or ripples), an edited video, both published
// next to the raw video at raw. The video is the raw file, opened before it was published.
func (session *liveSession) finalizeRecording(recording *wrapperRecording, video *os.File, raw string) (edited, timeline string, failure *recordingEditError) {
	r := session.runtime
	journal, _ := os.ReadFile(filepath.Join(recording.segmentDir, recordingJournalFile))
	var entries []journalEntry
	for _, line := range bytes.Split(journal, []byte{'\n'}) {
		var entry journalEntry
		if json.Unmarshal(line, &entry) == nil && entry.kind() != "" {
			entries = append(entries, entry)
		}
	}
	plan := placeJournal(recording.segments, entries)
	if len(entries) == 0 || plan.total <= 0 {
		return "", "", nil
	}
	ctx, cancel := context.WithTimeout(r.ctx, renderTimeout(plan.total))
	defer cancel()
	work, stem, cfg := recording.segmentDir, strings.TrimSuffix(raw, filepath.Ext(raw)), recording.config

	stage := "analysis_failed"
	var analysis videoAnalysis
	var err error
	if cfg.Capture == "bursts" || cfg.Idle != "" {
		analysis, err = analyzeVideo(ctx, r.values, work, video, cfg, plan.total)
	}
	if err == nil {
		stage = "plan_failed"
		err = plan.plan(cfg, recording.FPS, analysis)
	}
	if err == nil && plan.filter != "" {
		stage = "render_failed"
		var rendered string
		if rendered, err = renderEdit(ctx, r.values, work, video, plan); err == nil {
			edited, err = publishRecording(rendered, stem+".edited.mp4")
		}
	}
	if err != nil {
		code := stage
		switch {
		case errors.Is(err, errFFmpegUnavailable):
			code = "ffmpeg_unavailable"
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			code, err = "timeout", fmt.Errorf("edit timed out after %s", renderTimeout(plan.total))
		}
		failure = &recordingEditError{Code: code, Message: err.Error()}
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: recording %s edit: %v\n", recording.ID, err)
	}
	// The timeline reports edited times only for an edit that exists.
	encoded, err := json.Marshal(plan.timeline(edited != ""))
	if err == nil {
		err = os.WriteFile(filepath.Join(work, "timeline.json"), encoded, 0o600)
	}
	if err == nil {
		timeline, err = publishRecording(filepath.Join(work, "timeline.json"), stem+".timeline.json")
	}
	if err != nil && failure == nil {
		failure = &recordingEditError{Code: "timeline_failed", Message: err.Error()}
	}
	return edited, timeline, failure
}

// analyzeVideo asks ffmpeg what the raw video does: mpdecimate keeps the frames that differ from
// their predecessor (idle), freezedetect finds the stretches that stand still for the settle time (bursts).
func analyzeVideo(ctx context.Context, values RuntimeEnvValues, work string, video *os.File, cfg recordingConfig, total int64) (videoAnalysis, error) {
	filter := "setpts=PTS-STARTPTS,mpdecimate,showinfo"
	if cfg.Capture == "bursts" {
		filter = "setpts=PTS-STARTPTS,freezedetect=n=-60dB:d=" + seconds(cfg.Burst.SettleMS)
	}
	log, err := runFFmpeg(ctx, values, work, video, "-loglevel", "info", "-an", "-vf", filter, "-f", "null", "-")
	if err != nil {
		return videoAnalysis{}, err
	}
	if cfg.Capture == "bursts" {
		return videoAnalysis{frozen: parseFreezes(log, total)}, nil
	}
	return videoAnalysis{active: parseActive(log)}, nil
}

// renderEdit encodes the planned filter chain into edited.mp4 in the work directory.
func renderEdit(ctx context.Context, values RuntimeEnvValues, work string, video *os.File, plan *recordingPlan) (string, error) {
	if plan.ass != nil {
		if err := os.WriteFile(filepath.Join(work, "captions.ass"), plan.ass, 0o600); err != nil {
			return "", err
		}
	}
	_, err := runFFmpeg(ctx, values, work, video, "-loglevel", "error", "-xerror", "-y", "-an", "-vf", plan.filter,
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
		"-fps_mode", "passthrough", "-movflags", "+faststart", "-f", "mp4", "edited.mp4")
	return filepath.Join(work, "edited.mp4"), err
}

// openRecordingVideo opens the video for ffmpeg once, without following a link.
func openRecordingVideo(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}

// runFFmpeg runs ffmpeg in the work directory on the video and returns its log. ffmpeg reads the
// descriptor the wrapper opened, as the one container format and no other protocol, so the file
// cannot name something else to read, and its environment holds nothing of the wrapper's.
func runFFmpeg(ctx context.Context, values RuntimeEnvValues, work string, video *os.File, args ...string) (string, error) {
	if values.RecordingFFmpegExecutable == "" {
		return "", errFFmpegUnavailable
	}
	cmd := exec.CommandContext(ctx, values.RecordingFFmpegExecutable, append([]string{
		"-hide_banner", "-nostdin", "-nostats", "-protocol_whitelist", "file", "-f", "matroska,webm", "-i", "file:/dev/fd/3",
	}, args...)...)
	cmd.Dir = work
	cmd.Env = []string{"HOME=" + work, "TMPDIR=" + work}
	if values.CacheDir != "" { // fontconfig takes seconds to build its cache
		cache := filepath.Join(values.CacheDir, "ffmpeg")
		_ = os.MkdirAll(cache, 0o700)
		cmd.Env = append(cmd.Env, "XDG_CACHE_HOME="+cache)
	}
	cmd.ExtraFiles = []*os.File{video}
	cmd.WaitDelay = 5 * time.Second
	var log bytes.Buffer
	cmd.Stderr = &log
	if err := runNiced(cmd); err != nil {
		tail := strings.ToValidUTF8(strings.TrimSpace(log.String()), "")
		return "", fmt.Errorf("ffmpeg failed: %w: %s", err, tail[max(len(tail)-1000, 0):])
	}
	return log.String(), nil
}

// runNiced runs a command at low priority so it yields to the live session. Priority is per
// thread on Linux and a child inherits its starting thread's, so the command starts from a
// goroutine whose thread was made nice first; the goroutine keeps that thread until the command
// ends, and Go discards a thread whose goroutine ended locked, so the priority never spreads.
func runNiced(cmd *exec.Cmd) error {
	result := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		_ = unix.Setpriority(unix.PRIO_PROCESS, unix.Gettid(), 10)
		result <- cmd.Run()
	}()
	return <-result
}
