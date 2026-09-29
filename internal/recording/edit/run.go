package edit

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/aperture/aperture/internal/recording/timeline"
)

const (
	// probeTimeout bounds each ffprobe run.
	probeTimeout = 30 * time.Second
	// minRenderTimeout and defaultMaxRenderTimeout bound the time an edit may take,
	// which is 30 seconds and ten times the video's length in between.
	minRenderTimeout        = 2 * time.Minute
	defaultMaxRenderTimeout = 30 * time.Minute
	// niceness is the priority ffmpeg runs at, so it yields to the live session.
	niceness = 10
	// stderrTail is how much of ffmpeg's error output an error message keeps.
	stderrTail = 2048
	// OutputName is the video Run writes in its work directory.
	OutputName = "edited.mp4"
	// captionsName is the captions script Run writes there, which the filter chain names.
	captionsName = "captions.ass"
)

// RunOptions say what Run works on and with.
type RunOptions struct {
	// FFmpeg is the ffmpeg executable. FFprobe is ffprobe, and defaults to the one
	// beside ffmpeg.
	FFmpeg  string
	FFprobe string
	// Source is the video to edit, a .webm, .mkv or .mp4 file. It is opened once,
	// without following a symbolic link, and ffmpeg reads that file even if the
	// name is moved or replaced meanwhile.
	Source string
	// WorkDir is an existing directory for the output and scratch files, which
	// belong to the caller to remove.
	WorkDir string
	// Threads limits ffmpeg's threads; zero leaves it to ffmpeg.
	Threads int
	// MaxTime is the longest ffmpeg may take; zero means 30 minutes. A video is
	// given 30 seconds and ten times its length, at least two minutes, up to that.
	MaxTime time.Duration
}

// Result is what Run made.
type Result struct {
	// Output is the edited video in the work directory, empty when the plan is
	// trivial and nothing was rendered.
	Output string
	Plan   *Plan
}

// Run edits the source video as its timeline asks. It probes the video, plans the
// edit, and, unless the plan is trivial, renders it into the work directory. The
// source and the timeline are only read. Failures are *Error.
func Run(ctx context.Context, options RunOptions, tl *timeline.Timeline) (*Result, error) {
	if options.FFmpeg == "" {
		return nil, newError(CodeUnavailable, "no ffmpeg is configured for editing recordings")
	}
	if options.FFprobe == "" {
		options.FFprobe = filepath.Join(filepath.Dir(options.FFmpeg), "ffprobe")
	}
	format, err := demuxerFor(options.Source)
	if err != nil {
		return nil, err
	}
	source, err := openSource(options.Source)
	if err != nil {
		return nil, err
	}
	defer func() { _ = source.Close() }()

	probed, err := probeSource(ctx, options, format, source)
	if err != nil {
		return nil, err
	}
	if probed.mixedSizes {
		return nil, newError(CodeMixedSizes, "the video's frames change size, for example after the viewport was resized, which editing does not support")
	}
	plan, err := Build(tl, Source{Width: probed.width, Height: probed.height, DurationMs: probed.durationMs})
	if err != nil {
		return nil, err
	}
	if plan.Trivial() {
		return &Result{Plan: plan}, nil
	}
	if plan.ASS != nil {
		if err := os.WriteFile(filepath.Join(options.WorkDir, captionsName), plan.ASS, 0o600); err != nil {
			return nil, newError(CodeInternal, "write captions: %v", err)
		}
	}
	timeout := renderTimeout(plan.InDurationMs, options.MaxTime)
	if err := render(ctx, options, format, source, plan, timeout); err != nil {
		return nil, err
	}
	output := filepath.Join(options.WorkDir, OutputName)
	if info, err := os.Stat(output); err != nil || info.Size() == 0 {
		return nil, newError(CodeFFmpegFailed, "ffmpeg wrote no video")
	}
	return &Result{Output: output, Plan: plan}, nil
}

// renderTimeout is the time an edit of a video of the given length may take.
func renderTimeout(durationMs int64, maxTime time.Duration) time.Duration {
	if maxTime <= 0 {
		maxTime = defaultMaxRenderTimeout
	}
	timeout := 30*time.Second + 10*time.Duration(durationMs)*time.Millisecond
	return min(max(timeout, minRenderTimeout), max(maxTime, time.Second))
}

// demuxerFor names the one container format ffmpeg may read the source as, so the
// contents cannot make it pick another (a playlist, say, that names other files).
func demuxerFor(path string) (string, error) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".webm", ".mkv":
		return "matroska,webm", nil
	case ".mp4":
		return "mov,mp4,m4a,3gp,3g2,mj2", nil
	default:
		return "", newError(CodeSourceUnreadable, "only .webm, .mkv and .mp4 videos can be edited")
	}
}

// openSource opens the source without following a link and checks it is a regular file.
func openSource(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, newError(CodeSourceUnreadable, "open the video: %v", err)
	}
	file := os.NewFile(uintptr(fd), path)
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		_ = file.Close()
		return nil, newError(CodeSourceUnreadable, "the video is not a regular, non-empty file")
	}
	return file, nil
}

// inputArguments make ffmpeg or ffprobe read the source, which is passed as file
// descriptor 3, as the given format and nothing else. /dev/fd/3 opens the very
// file that was checked, whatever happens to its name.
func inputArguments(format string) []string {
	return []string{"-protocol_whitelist", "file", "-f", format, "-i", "file:/dev/fd/3"}
}

// toolEnvironment is the environment ffmpeg and ffprobe run in: the work
// directory for whatever they write, and the fonts the captions need.
func toolEnvironment(workDir string) []string {
	env := []string{
		"HOME=" + workDir,
		"TMPDIR=" + workDir,
		"XDG_CACHE_HOME=" + filepath.Join(workDir, "cache"),
	}
	for _, name := range []string{"PATH", "FONTCONFIG_FILE", "FONTCONFIG_PATH", "LANG"} {
		if value := os.Getenv(name); value != "" {
			env = append(env, name+"="+value)
		}
	}
	return env
}

type probed struct {
	width, height int
	durationMs    int64
	mixedSizes    bool
}

// probeSource reads the video's frame size and length, and looks at the size of
// its key frames, which is where a change of size shows.
func probeSource(ctx context.Context, options RunOptions, format string, source *os.File) (probed, error) {
	var result probed
	streams, err := runProbe(ctx, options, source, append([]string{"-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "json"}, inputArguments(format)...))
	if err != nil {
		return result, err
	}
	var parsed struct {
		Streams []struct {
			Codec  string `json:"codec_name"`
			Width  int    `json:"width"`
			Height int    `json:"height"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(streams, &parsed); err != nil || len(parsed.Streams) == 0 || parsed.Streams[0].Width <= 0 || parsed.Streams[0].Height <= 0 {
		return result, newError(CodeSourceUnreadable, "the video has no picture ffprobe can read")
	}
	result.width, result.height = parsed.Streams[0].Width, parsed.Streams[0].Height
	if seconds, err := strconv.ParseFloat(parsed.Format.Duration, 64); err == nil && seconds > 0 && !math.IsInf(seconds, 0) {
		result.durationMs = int64(math.Round(seconds * 1000))
	}
	frames, err := runProbe(ctx, options, source, append([]string{"-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=width,height", "-of", "csv=p=0"}, inputArguments(format)...))
	if err != nil {
		return result, err
	}
	sizes := map[string]bool{}
	for _, line := range strings.Fields(string(frames)) {
		sizes[line] = true
	}
	result.mixedSizes = len(sizes) > 1
	return result, nil
}

func runProbe(parent context.Context, options RunOptions, source *os.File, arguments []string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(parent, probeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, options.FFprobe, append([]string{"-v", "error"}, arguments...)...)
	cmd.Dir = options.WorkDir
	cmd.Env = toolEnvironment(options.WorkDir)
	cmd.ExtraFiles = []*os.File{source}
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	cmd.WaitDelay = 5 * time.Second
	var stdout bytes.Buffer
	stderr := &tailBuffer{limit: stderrTail}
	cmd.Stdout, cmd.Stderr = &stdout, stderr
	if err := cmd.Run(); err != nil {
		if code := contextError(parent, ctx); code != nil {
			return nil, code
		}
		return nil, newError(CodeSourceUnreadable, "ffprobe failed: %v: %s", err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

// render runs ffmpeg on the plan.
func render(parent context.Context, options RunOptions, format string, source *os.File, plan *Plan, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	arguments := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-y"}
	arguments = append(arguments, inputArguments(format)...)
	arguments = append(arguments,
		"-map", "0:v:0", "-an", "-sn", "-dn",
		"-vf", plan.Filter,
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
		// The filters already make the frame rate constant; add nothing on top.
		"-fps_mode", "passthrough",
	)
	if options.Threads > 0 {
		threads := strconv.Itoa(options.Threads)
		arguments = append(arguments, "-threads", threads, "-filter_threads", threads)
	}
	// The name has no .mp4 extension to go by while it is being written.
	arguments = append(arguments, "-movflags", "+faststart", "-f", "mp4", OutputName)

	cmd := exec.CommandContext(ctx, options.FFmpeg, arguments...)
	cmd.Dir = options.WorkDir
	cmd.Env = toolEnvironment(options.WorkDir)
	cmd.ExtraFiles = []*os.File{source}
	// ffmpeg does not outlive the wrapper that started it.
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	cmd.WaitDelay = 5 * time.Second
	stderr := &tailBuffer{limit: stderrTail}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return newError(CodeFFmpegFailed, "start ffmpeg: %v", err)
	}
	// ffmpeg starts its threads afterwards and they inherit the priority.
	_ = unix.Setpriority(unix.PRIO_PROCESS, cmd.Process.Pid, niceness)
	if err := cmd.Wait(); err != nil {
		if code := contextError(parent, ctx); code != nil {
			return code
		}
		return newError(CodeFFmpegFailed, "ffmpeg failed: %v: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// contextError says why a command was stopped: the caller gave up (parent is
// done) or the command's own time ran out (ctx is). It is nil while both are alive.
func contextError(parent, ctx context.Context) *Error {
	switch {
	case parent.Err() != nil:
		return newError(CodeCanceled, "the edit was cancelled")
	case ctx.Err() != nil:
		return newError(CodeTimeout, "ffmpeg did not finish in time")
	default:
		return nil
	}
}

// tailBuffer keeps the last limit bytes written to it.
type tailBuffer struct {
	mu    sync.Mutex
	limit int
	data  []byte
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data = append(b.data, p...)
	if extra := len(b.data) - b.limit; extra > 0 {
		b.data = slices.Delete(b.data, 0, extra)
	}
	return len(p), nil
}

func (b *tailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.data)
}
