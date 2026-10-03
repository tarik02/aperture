package browser

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/recording"
	"golang.org/x/sys/unix"
)

var errFFmpegUnavailable = errors.New("recording edits need ffmpeg, which is not configured")

// renderSlot lets one ffmpeg render run at a time: a render is heavy, and so is waiting for several.
var renderSlot = make(chan struct{}, 1)

// renderTimeout is how long analysing and rendering a recording of the given length may take.
func renderTimeout(videoMS int64) time.Duration {
	return min(max(30*time.Second+10*time.Duration(videoMS)*time.Millisecond, 2*time.Minute), 30*time.Minute)
}

// finalizeRecording turns a stopped recording's journal into a timeline and, when it asks for
// something to apply (bursts, idle, captions, focus or ripples), an edited video, both published
// next to the raw video at raw. The video is the raw file, opened before it was published. Only
// requested stops come here; ctx ends when the session closes or the edit is cancelled, which
// ends the render.
func (session *liveSession) finalizeRecording(ctx context.Context, rec *wrapperRecording, video *os.File, raw string) (edited, timeline string, failure *recording.EditError) {
	r := session.runtime
	journal, _ := os.ReadFile(filepath.Join(rec.segmentDir, recordingJournalFile))
	var entries []journalEntry
	for _, line := range bytes.Split(journal, []byte{'\n'}) {
		var entry journalEntry
		if json.Unmarshal(line, &entry) == nil && entry.kind() != "" {
			entries = append(entries, entry)
		}
	}
	plan := placeJournal(rec.segments, entries)
	plan.eventsDropped = rec.journal.droppedEntries()
	work, stem, cfg := rec.segmentDir, strings.TrimSuffix(raw, filepath.Ext(raw)), rec.config
	if plan.total <= 0 { // no frame: nothing to edit and nothing to tell
		if cfg.Capture == recording.CaptureBursts {
			failure = &recording.EditError{Code: recording.EditNothingKept, Message: errNothingKept.Error()}
		}
		return "", "", failure
	}

	stage := recording.EditAnalysisFailed
	var analysis []span
	var err error
	// The slot wait counts against the timeout: a render queued behind others for that long is
	// better reported than run late.
	ctx, cancel := context.WithTimeout(ctx, renderTimeout(plan.total))
	defer cancel()
	switch {
	case cfg.Capture == recording.CaptureBursts && len(plan.events) == 0:
		err = errNothingKept // no call to keep a burst around, so the analysis would be wasted
	default:
		select {
		case renderSlot <- struct{}{}:
			defer func() { <-renderSlot }()
		case <-ctx.Done():
			err = ctx.Err()
		}
	}
	// An idle edit with an empty journal still analyses: the picture alone says where nothing happens.
	if err == nil && (cfg.Capture == recording.CaptureBursts || cfg.Idle != "") {
		analysis, err = analyzeVideo(ctx, r.values, work, video)
	}
	if err == nil {
		stage = recording.EditPlanFailed
		err = plan.plan(cfg, rec.FPS, analysis)
	}
	if err == nil && plan.filter != "" {
		stage = recording.EditRenderFailed
		var rendered string
		if rendered, err = renderEdit(ctx, r.values, work, video, plan); err == nil {
			edited, err = publishRecording(rendered, stem+".edited.mp4")
		}
	}
	if err != nil {
		code := stage
		switch {
		case errors.Is(err, errFFmpegUnavailable):
			code = recording.EditFFmpegUnavailable
		case errors.Is(err, errNothingKept):
			code = recording.EditNothingKept
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			code, err = recording.EditTimeout, fmt.Errorf("edit timed out after %s", renderTimeout(plan.total))
		case ctx.Err() != nil:
			code, err = recording.EditCancelled, fmt.Errorf("edit cancelled: %w", context.Cause(ctx))
		}
		failure = &recording.EditError{Code: code, Message: err.Error()}
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: recording %s edit: %v\n", rec.ID, err)
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
		failure = &recording.EditError{Code: recording.EditTimelineFailed, Message: err.Error()}
	}
	return edited, timeline, failure
}

// analyzeVideo asks ffmpeg where the raw video changes: mpdecimate keeps the frames that differ
// from their predecessor. Idle and the settling of bursts both come from that.
func analyzeVideo(ctx context.Context, values RuntimeEnvValues, work string, video *os.File) ([]span, error) {
	var active activeSpans
	err := runFFmpeg(ctx, values, work, video, active.observe, "-loglevel", "info", "-an", "-vf", "setpts=PTS-STARTPTS,mpdecimate,showinfo", "-f", "null", "-")
	return active.spans(), err
}

// renderEdit encodes the planned filter chain into edited.mp4 in the work directory.
func renderEdit(ctx context.Context, values RuntimeEnvValues, work string, video *os.File, plan *recordingPlan) (string, error) {
	if plan.ass != nil {
		if err := os.WriteFile(filepath.Join(work, "captions.ass"), plan.ass, 0o600); err != nil {
			return "", err
		}
	}
	// ffmpeg reads the filter chain from a file (-/vf), so its length does not meet the limit of a command line.
	if err := os.WriteFile(filepath.Join(work, "filter.txt"), []byte(plan.filter), 0o600); err != nil {
		return "", err
	}
	err := runFFmpeg(ctx, values, work, video, nil, "-loglevel", "error", "-xerror", "-y", "-an", "-/vf", "filter.txt",
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

// runFFmpeg runs ffmpeg in the work directory on the video, handing each line of its log to line
// as it comes (an analysis logs a line per frame, too many to hold); the end of the log goes into
// the error. ffmpeg reads the descriptor the wrapper opened, as the one container format and no
// other protocol, so the file cannot name something else to read, and its environment holds
// nothing of the wrapper's.
func runFFmpeg(ctx context.Context, values RuntimeEnvValues, work string, video *os.File, line func(string), args ...string) error {
	if values.RecordingFFmpegExecutable == "" {
		return errFFmpegUnavailable
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
	logs, logWriter := io.Pipe()
	cmd.Stderr = logWriter
	result := make(chan error, 1)
	go func() {
		err := runNiced(cmd)
		_ = logWriter.Close()
		result <- err
	}()
	const tailBytes = 1000
	tail := ""
	scanner := bufio.NewScanner(logs)
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	for scanner.Scan() {
		if line != nil {
			line(scanner.Text())
		}
		tail += scanner.Text() + "\n"
		tail = tail[max(len(tail)-tailBytes, 0):]
	}
	_, _ = io.Copy(io.Discard, logs) // a line past the scanner's limit must not stall ffmpeg's exit
	if err := <-result; err != nil {
		return fmt.Errorf("ffmpeg failed: %w: %s", err, strings.ToValidUTF8(strings.TrimSpace(tail), ""))
	}
	return nil
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
