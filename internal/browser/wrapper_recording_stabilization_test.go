package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aperture/aperture/internal/recording"
	"golang.org/x/sys/unix"
)

func TestBurstsSettleWithUnsortedOverlappingChanges(t *testing.T) {
	events := []journalEntry{{"kind": "call", "startMs": 1000.0, "endMs": 1200.0}}
	got := burstPieces(recording.Burst{LeadMS: 100, TailMS: 200, SettleMS: 400, MaxTailMS: 3000}, events, []span{{1700, 2100}, {1300, 1800}, {1900, 2300}}, 4000)
	if !slices.Equal(got, []piece{{900, 2700, 1}}) {
		t.Fatalf("kept %v, want 900..2700", got)
	}
}

func TestJournalSkipsFramelessSegments(t *testing.T) {
	segments := []*recordingSegment{
		{TargetID: "A", FirstFrameMS: 1_000_000, DurationMS: 1000},
		{TargetID: "empty", DurationMS: 500},
		{TargetID: "B", FirstFrameMS: 1_002_000, DurationMS: 2000},
	}
	p := placeJournal(segments, []journalEntry{entry("caption", 2500, 2500, nil)})
	if p.total != 3000 || len(p.segments) != 2 || p.segments[1].StartMS != 1000 || p.events[0].span() != (span{1500, 1500}) {
		t.Fatalf("placed %+v, events %v", p, p.events)
	}
}

func TestIdleKeepsSlowPictureUpdates(t *testing.T) {
	active := parseActive("pts_time:2\npts_time:5\n")
	if got := idlePieces("cut", nil, active, 8000); !slices.Equal(got, []piece{{1700, 2300, 1}, {4700, 5300, 1}}) {
		t.Fatalf("kept slow updates %v", got)
	}
}

func TestCancelKillsLiveFFmpegAndCleansWork(t *testing.T) {
	ffmpeg := ffmpegForTest(t)
	session, rec, raw := finalizeFixture(t, ffmpeg, recording.Config{Idle: "cut"})
	rec.operationMu = &sync.Mutex{}
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Fatal(err)
	}
	pidFile := filepath.Join(t.TempDir(), "ffmpeg.pid")
	wrapper := filepath.Join(t.TempDir(), "ffmpeg")
	script := fmt.Sprintf("#!%s\nprintf '%%s' \"$$\" > %q\nexec %q -re \"$@\"\n", bash, pidFile, ffmpeg)
	if err := os.WriteFile(wrapper, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	session.runtime.values.RecordingFFmpegExecutable = wrapper
	video, err := openRecordingVideo(raw)
	if err != nil {
		t.Fatal(err)
	}
	session.runtime.mu.Lock()
	rec.Status, rec.Path = wrapperRecordingStopped, raw
	session.startEditLocked(rec, video, raw)
	session.runtime.mu.Unlock()
	t.Cleanup(func() { _, _ = session.cancelRecording(rec.ID) })
	var pid int
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		body, _ := os.ReadFile(pidFile)
		pid, _ = strconv.Atoi(string(body))
		if cmdline, _ := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid)); pid > 0 && strings.Contains(string(cmdline), "-re\x00-hide_banner") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cmdline, _ := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if pid == 0 || !strings.Contains(string(cmdline), "-re\x00-hide_banner") {
		t.Fatalf("real ffmpeg did not start: pid %d %q", pid, cmdline)
	}
	status, err := session.cancelRecording(rec.ID)
	if err != nil || status.Editing || status.EditError == nil || status.EditError.Code != recording.EditCancelled || status.EditedPath != "" {
		t.Fatalf("cancel %+v, %v", status, err)
	}
	if err := unix.Kill(pid, 0); err != unix.ESRCH {
		t.Fatalf("ffmpeg %d survived cancellation: %v", pid, err)
	}
	if _, err := os.Stat(raw); err != nil {
		t.Fatalf("raw lost: %v", err)
	}
	if _, err := os.Stat(rec.segmentDir); !os.IsNotExist(err) {
		t.Fatalf("work directory remains: %v", err)
	}
}

func TestCaptionTimelineIgnoresNonzeroContainerStart(t *testing.T) {
	ffmpeg := ffmpegForTest(t)
	root := t.TempDir()
	raw := filepath.Join(root, "offset.mkv")
	cmd := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=320x240:r=30:d=2", "-c:v", "libx264", "-output_ts_offset", "0.267", raw)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, out)
	}
	probe, _ := exec.Command(ffmpeg, "-hide_banner", "-i", raw).CombinedOutput()
	if !strings.Contains(string(probe), "start: 0.267000") {
		t.Fatalf("fixture has no timestamp offset: %s", probe)
	}
	session := newJournalSession(t, &wrapperRecording{ID: "offset", Status: wrapperRecordingStopped})
	session.runtime.values.RecordingFFmpegExecutable = ffmpeg
	rec := session.recordings["offset"]
	rec.FPS = 30
	rec.segments = []*recordingSegment{{FirstFrameMS: 1_000_000, DurationMS: 2000, Width: 320, Height: 240, ViewportWidth: 320, ViewportHeight: 240}}
	journal, _ := json.Marshal(entry("caption", 400, 400, map[string]any{"text": "Timeline", "durationMs": 400.0}))
	if err := os.WriteFile(filepath.Join(rec.segmentDir, recordingJournalFile), journal, 0600); err != nil {
		t.Fatal(err)
	}
	video, err := openRecordingVideo(raw)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = video.Close() }()
	edited, timeline, failure := session.finalizeRecording(context.Background(), rec, video, raw)
	if failure != nil {
		t.Fatalf("edit: %+v", failure)
	}
	pixels, err := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-i", edited, "-pix_fmt", "gray", "-f", "rawvideo", "-").Output()
	if err != nil {
		t.Fatal(err)
	}
	const frameBytes = 320 * 240
	if len(pixels) < 25*frameBytes {
		t.Fatalf("short decoded video: %d bytes", len(pixels))
	}
	for frame, want := range map[int]bool{0: false, 11: false, 12: true, 23: true, 24: false} {
		visible := false
		for _, pixel := range pixels[frame*frameBytes : (frame+1)*frameBytes] {
			if pixel > 200 {
				visible = true
				break
			}
		}
		if visible != want {
			t.Errorf("caption at frame %d visible=%v, want %v", frame, visible, want)
		}
	}
	var published struct {
		Events []journalEntry `json:"events"`
	}
	body, _ := os.ReadFile(timeline)
	if err := json.Unmarshal(body, &published); err != nil {
		t.Fatal(err)
	}
	if published.Events[0].num("startMs") != 400 || published.Events[0].num("editedStartMs") != 400 {
		t.Fatalf("timeline event %v", published.Events[0])
	}
}
