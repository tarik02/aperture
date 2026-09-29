// Package timeline defines the timeline.json file saved next to every
// recording, and the builder that produces it.
//
// The timeline records what happened while the video was being captured:
// where the segments of the video came from, which pointer gestures were made
// and where, the captions attached to them, when the recorded screen changed,
// and, in a recording that captures only around browser actions, which bursts of
// video it holds and the actions in them. Later stages, such as ffmpeg based
// editing, load it with Read and cut, zoom and annotate the video from it
// without having to look at pixels.
//
// # Time
//
// Every time in a timeline is an integer number of milliseconds on the video's
// own clock, which starts at 0 with the video's first frame and is the clock
// ffmpeg and players use: a value can be passed to -ss or a trim filter as it
// is. A video published as it was written, which is one made of a single
// segment, has timestamps that start a few tens of milliseconds after zero
// instead; Recording.ContainerStartMs says by how much, for readers that use the
// container's timestamps, as ffprobe reports them.
//
// A time is where the moment lands on the frames that are captured at that
// moment. What a gesture causes on screen takes a little longer to reach the
// video than the gesture itself (the browser has to react, and the frame has to
// pass the compositor and the encoder), so a page's reaction appears some tens
// of milliseconds after the time of the click that caused it.
//
// # Coordinates
//
// Coordinates are pixels of the video frame, with the origin at its top left
// corner. Each Segment says how it scales the page (CSS pixels at default
// zoom) to the frame; the coordinates in gestures are already scaled.
package timeline

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"

	"github.com/aperture/aperture/internal/sessionfiles"
)

// Version is the schema version written to and required from timeline files.
// It changes only when a change breaks readers of the older schema; new
// optional fields do not.
const Version = 1

// FileSuffix ends the name of every timeline file.
const FileSuffix = ".timeline.json"

// PathFor returns where the timeline of a video is saved: the video's whole
// name, extension included, followed by FileSuffix (`demo.webm` has
// `demo.webm.timeline.json`). Keeping the extension means videos that differ only
// in it (`demo.webm`, `demo.mkv`) never share a timeline, and a numbered video
// (`demo-1.webm`) has a numbered timeline. It is a pure name change, so it
// applies to relative and absolute paths alike.
func PathFor(videoPath string) string {
	return videoPath + FileSuffix
}

// Timeline is the content of a timeline file.
type Timeline struct {
	Version   int       `json:"version"`
	Recording Recording `json:"recording"`
	Segments  []Segment `json:"segments"`
	// Bursts is present in a recording made with capture "bursts": the stretches
	// of the video that were recorded around browser actions, in order.
	Bursts    []Burst    `json:"bursts,omitempty"`
	Gestures  []Gesture  `json:"gestures"`
	Captions  []Caption  `json:"captions"`
	Activity  Activity   `json:"activity"`
	Truncated Truncation `json:"truncated"`
}

// Recording describes the video the timeline belongs to.
type Recording struct {
	ID string `json:"id"`
	// Video is the video's path below the session files root, with forward slashes.
	Video string `json:"video"`
	Mode  string `json:"mode"`
	// Capture says when frames were captured: "continuous" for the whole
	// recording, or "bursts" for only the stretches around browser actions.
	Capture string `json:"capture,omitempty"`
	Codec   string `json:"codec"`
	// FPS is the frame rate the recording was asked for. The video has variable
	// frame timing and never more frames per second than this.
	FPS int `json:"fps"`
	// Width and Height are the pixels of the first segment. Segments of other
	// targets or viewport sizes can differ, so read Segment.Width and Height when
	// drawing.
	Width  int `json:"width"`
	Height int `json:"height"`
	// StartedAt is the wall time the recording was requested.
	StartedAt time.Time `json:"startedAt"`
	// DurationMs is the time from the video's first frame to the end of its last.
	DurationMs int64 `json:"durationMs"`
	// ContainerStartMs is the timestamp the video file gives its first frame: 0
	// for a video joined from several segments and a few tens of milliseconds for
	// one that holds a single segment. Add it to a time to get the frame's
	// timestamp as ffprobe reports it.
	ContainerStartMs int64 `json:"containerStartMs"`
	// Salvaged is set on the timeline of a video that is only part of a recording
	// that failed; the other parts are published as videos of their own, each
	// with its own timeline.
	Salvaged bool `json:"salvaged,omitempty"`
	// Edit holds the effect defaults the recording was started with. It is absent
	// when it was started without any, and lets the edited video be reproduced
	// from the timeline alone.
	Edit *EditOptions `json:"edit,omitempty"`
}

// Idle modes of EditOptions.Idle.
const (
	// IdleSpeed plays the stretches in which nothing happens faster.
	IdleSpeed = "speed"
	// IdleCut removes them.
	IdleCut = "cut"
)

// EditOptions are the recording-level defaults of the effects that are applied
// to the video when the recording stops. Effects that a gesture asked for itself
// are on the gesture; the defaults here are what its omitted arguments were
// resolved against, so Gesture.Zoom and Gesture.Ripple already hold the
// effective values.
type EditOptions struct {
	// Idle is "speed" or "cut" to shorten the stretches in which nothing happens,
	// and empty to leave them.
	Idle string `json:"idle,omitempty"`
	// Ripple marks clicks that did not say otherwise.
	Ripple bool `json:"ripple,omitempty"`
	// Zoom is the magnification of gestures that did not say otherwise; zero is off.
	Zoom float64 `json:"zoom,omitempty"`
}

// Empty reports whether the options ask for nothing.
func (o *EditOptions) Empty() bool {
	return o == nil || (o.Idle == "" && !o.Ripple && o.Zoom == 0)
}

// Clock source values of Segment.Clock.
const (
	// ClockPipeline means the segment's start and length come from the frames
	// the capture pipeline reported, accurate to a few milliseconds.
	ClockPipeline = "pipeline"
	// ClockEstimated means the pipeline reported nothing, so the segment's first
	// frame is assumed to be at the start of the pipeline process. The error is
	// its start-up time, typically 0.1 to 0.3 seconds, and it does not accumulate
	// over the recording.
	ClockEstimated = "estimated"
)

// Segment is one piece of the video: a capture of one target at one size. A
// recording has a new segment whenever it follows another target, the target's
// output is replaced, or the viewport size changes. Segments follow each other
// without a gap in video time; in a bursts recording the wall time between two
// bursts is not in the video at all.
type Segment struct {
	Index    int    `json:"index"`
	TargetID string `json:"targetId"`
	// StartMs and EndMs are the video times of the segment's first frame and of
	// the end of its last frame.
	StartMs int64 `json:"startMs"`
	EndMs   int64 `json:"endMs"`
	// Width and Height are the pixels of the segment's frames.
	Width  int `json:"width"`
	Height int `json:"height"`
	// ScaleX and ScaleY convert page coordinates (CSS pixels at default zoom) to
	// pixels of the frame. They are the device pixel ratio the page was captured at.
	ScaleX float64 `json:"scaleX"`
	ScaleY float64 `json:"scaleY"`
	// FirstFrameAt is the wall time of the segment's first frame. Segments overlap
	// in wall time by the time the next one needed to produce its first frame; the
	// video contains no such overlap. In a bursts recording, segments are apart in
	// wall time by however long nothing was captured.
	FirstFrameAt time.Time `json:"firstFrameAt"`
	Clock        string    `json:"clock"`
}

// Gesture is one pointer gesture made on the recorded target while it was recorded.
type Gesture struct {
	ID   uint64 `json:"id"`
	Kind string `json:"kind"`
	Tool string `json:"tool"`
	// Mode is "compositor" for real pointer input, whose cursor path is recorded
	// and visible in the video, and "cdp" for input sent through the browser's
	// debugging protocol, which has no path and no visible cursor.
	Mode string `json:"mode"`
	// Segment is the index of the segment the gesture is mapped into.
	Segment  int    `json:"segment"`
	TargetID string `json:"targetId,omitempty"`
	// StartMs and EndMs are the video times of the physical gesture. HoldMs is
	// the extra time the caller asked to stay on the result afterwards.
	StartMs int64 `json:"startMs"`
	EndMs   int64 `json:"endMs"`
	HoldMs  int64 `json:"holdMs,omitempty"`
	// Clipped is set when the gesture began before or ended after the segment it
	// is mapped into. Its times are cut to the segment and its points outside it are dropped.
	Clipped bool   `json:"clipped,omitempty"`
	Caption string `json:"caption,omitempty"`
	// Zoom is the magnification the video zooms to while the gesture is made, and
	// absent when it does not. It is the gesture's own zoom argument, or else the
	// recording's default. Only gestures with a position in the video can zoom.
	Zoom float64 `json:"zoom,omitempty"`
	// Ripple is set on a click that is marked with a ripple in the edited video.
	Ripple bool `json:"ripple,omitempty"`
	// Path is where the cursor was, in order, thinned to what the shape of the
	// motion needs. It contains the gesture's first and last position.
	Path   []PathPoint `json:"path,omitempty"`
	Clicks []Click     `json:"clicks,omitempty"`
	// Scroll is the wheel movement of a scroll gesture.
	Scroll *Scroll `json:"scroll,omitempty"`
}

// PathPoint is one cursor position.
type PathPoint struct {
	TMs int64   `json:"t"`
	X   float64 `json:"x"`
	Y   float64 `json:"y"`
}

// Click is one button press.
type Click struct {
	TMs    int64   `json:"t"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Button string  `json:"button"`
	// Count is the press's position in a multi-click, starting at 1.
	Count int `json:"count"`
}

// Scroll is a wheel movement.
type Scroll struct {
	// DX and DY are the requested distance in CSS pixels, not scaled.
	DX float64 `json:"dx"`
	DY float64 `json:"dy"`
	// At is where the wheel turned, in pixels of the frame. It is absent when the
	// position is not known.
	At *Point `json:"at,omitempty"`
}

// Point is a position in pixels of the video frame.
type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// Caption is text to show for a span of the video.
type Caption struct {
	StartMs int64  `json:"startMs"`
	EndMs   int64  `json:"endMs"`
	Text    string `json:"text"`
	// Gesture is the ID of the gesture the caption came with. It is 0 for a
	// caption that came with another page-changing tool, which Tool names.
	Gesture uint64 `json:"gesture"`
	// Tool is the tool the caption came with, when it is not a pointer gesture.
	Tool string `json:"tool,omitempty"`
}

// Activity says when the recorded screen changed.
//
// It comes from sampling the compositor, which counts a change whenever the
// recorded page committed new content. Moving the mouse does not count, and a
// repaint without new content does not either, so an unchanged page has no
// activity however often the compositor repainted it.
type Activity struct {
	// Available is false when the compositor could not be sampled at all, so
	// nothing is known about the screen; Spans is then empty and does not mean
	// the screen was still.
	Available bool `json:"available"`
	// SampleIntervalMs is how often the compositor was asked. A change is placed
	// within about a millisecond of when it happened, but the change that was last
	// before a sample is the only one the sample reports, so activity that stops
	// and restarts within one interval is one span.
	SampleIntervalMs int64 `json:"sampleIntervalMs"`
	// MergeGapMs is the longest pause between changes that still counts as the
	// same span. Consumers that want to cut out idle time should not treat a
	// pause shorter than this as one.
	MergeGapMs int64 `json:"mergeGapMs"`
	// Spans are the intervals with changes, in order and without overlap. A
	// single change is a span of length zero.
	Spans []Span `json:"spans"`
	// Unknown lists intervals the compositor could not be sampled in, where
	// missing activity means nothing.
	Unknown []Span `json:"unknown,omitempty"`
}

// Span is an interval of video time.
type Span struct {
	StartMs int64 `json:"startMs"`
	EndMs   int64 `json:"endMs"`
}

// Burst is one stretch of video recorded around browser actions, in a recording
// made with capture "bursts". It covers one or more consecutive segments (it
// spans several when the recorded page was replaced or resized while the burst
// ran). Nothing is recorded between bursts, so the video jumps from one burst's
// end to the next one's start.
type Burst struct {
	// FirstSegment and LastSegment are the indexes of the segments the burst is
	// made of.
	FirstSegment int `json:"firstSegment"`
	LastSegment  int `json:"lastSegment"`
	// StartMs and EndMs are the video times of the burst's first frame and of the
	// end of its last frame.
	StartMs int64 `json:"startMs"`
	EndMs   int64 `json:"endMs"`
	// LeadMs is the video before the first action started, and TailMs the video
	// after the last one ended (the page settling).
	LeadMs int64 `json:"leadMs"`
	TailMs int64 `json:"tailMs"`
	// ClosedBy says why the burst ended: "settled" (the screen stopped changing),
	// "max_tail" (it was still changing when the longest tail passed), "stopped"
	// (the recording was stopped), "target_closed", "target_changed" (the
	// automation moved to another page or the page's capture was replaced) or
	// "pipeline_failed".
	ClosedBy string `json:"closedBy,omitempty"`
	// Actions are the browser actions that ran during the burst, in order.
	Actions []BurstAction `json:"actions"`
}

// BurstAction is one browser action that ran during a burst.
type BurstAction struct {
	Tool string `json:"tool"`
	// Kind is "pointer" for the pointer tools, "change" for actions that change
	// the page, and "observe" for waiting.
	Kind     string `json:"kind"`
	TargetID string `json:"targetId,omitempty"`
	// StartMs and EndMs are the video times the action ran between.
	StartMs int64 `json:"startMs"`
	EndMs   int64 `json:"endMs"`
	// Gesture is the ID of the pointer gesture the action made, when it made one.
	Gesture uint64 `json:"gesture,omitempty"`
}

// Truncation says which parts were cut to keep the file's size bounded.
type Truncation struct {
	// Gestures is set when gestures beyond the limit were left out.
	Gestures bool `json:"gestures"`
	// PathPoints is set when cursor paths were dropped or thinned beyond what
	// their shape needs to stay within the limit.
	PathPoints bool `json:"pathPoints"`
	// Activity is set when activity spans beyond the limit were left out.
	Activity bool `json:"activity"`
	// Captions is set when captions of other tools than the pointer tools, beyond
	// the limit, were left out.
	Captions bool `json:"captions,omitempty"`
	// Bursts is set when burst actions beyond the limit were left out.
	Bursts bool `json:"bursts,omitempty"`
}

// Validate checks what a reader relies on: the version, and that segments,
// spans and gestures are ordered and inside the video.
func (t *Timeline) Validate() error {
	if t.Version != Version {
		return fmt.Errorf("unsupported timeline version %d", t.Version)
	}
	end := t.Recording.DurationMs
	for index, segment := range t.Segments {
		if segment.Index != index {
			return fmt.Errorf("segment %d has index %d", index, segment.Index)
		}
		if segment.EndMs < segment.StartMs {
			return fmt.Errorf("segment %d ends before it starts", index)
		}
		if index > 0 && segment.StartMs < t.Segments[index-1].EndMs-1 {
			return fmt.Errorf("segment %d starts before segment %d ends", index, index-1)
		}
	}
	for index, burst := range t.Bursts {
		if burst.FirstSegment < 0 || burst.LastSegment < burst.FirstSegment || burst.LastSegment >= len(t.Segments) {
			return fmt.Errorf("burst %d refers to a missing segment", index)
		}
		if burst.EndMs < burst.StartMs || burst.StartMs < 0 || burst.EndMs > end {
			return fmt.Errorf("burst %d is outside the video", index)
		}
		if index > 0 && burst.StartMs < t.Bursts[index-1].EndMs-1 {
			return fmt.Errorf("burst %d starts before burst %d ends", index, index-1)
		}
	}
	for _, gesture := range t.Gestures {
		if gesture.EndMs < gesture.StartMs || gesture.StartMs < 0 || gesture.EndMs > end {
			return fmt.Errorf("gesture %d is outside the video", gesture.ID)
		}
		if gesture.Segment < 0 || gesture.Segment >= len(t.Segments) {
			return fmt.Errorf("gesture %d refers to a missing segment", gesture.ID)
		}
	}
	for _, list := range [][]Span{t.Activity.Spans, t.Activity.Unknown} {
		for index, span := range list {
			if span.EndMs < span.StartMs || span.StartMs < 0 || span.EndMs > end {
				return fmt.Errorf("span %d is outside the video", index)
			}
			if index > 0 && span.StartMs < list[index-1].EndMs {
				return errors.New("spans overlap or are out of order")
			}
		}
	}
	return nil
}

// Marshal encodes a timeline as it is saved.
func (t *Timeline) Marshal() ([]byte, error) {
	body, err := json.Marshal(t)
	if err != nil {
		return nil, fmt.Errorf("encode timeline: %w", err)
	}
	return append(body, '\n'), nil
}

// Parse decodes and validates a timeline.
func Parse(body []byte) (*Timeline, error) {
	var t Timeline
	if err := json.Unmarshal(body, &t); err != nil {
		return nil, fmt.Errorf("decode timeline: %w", err)
	}
	if err := t.Validate(); err != nil {
		return nil, err
	}
	return &t, nil
}

// Read loads and validates a timeline file.
func Read(path string) (*Timeline, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read timeline: %w", err)
	}
	return Parse(body)
}

// Write saves a timeline atomically and without replacing anything: it is
// written to a hidden file in the same directory and renamed to path, so readers
// see the whole file or none of it. When path is already taken, by an earlier
// timeline or a file of the user's, the name is numbered instead
// (`demo.webm.timeline.json`, `demo.webm.1.timeline.json`, ...), the way videos
// are. It returns the path the timeline was saved at.
func Write(path string, t *Timeline) (string, error) {
	body, err := t.Marshal()
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return "", fmt.Errorf("create timeline file: %w", err)
	}
	tempPath := temp.Name()
	fail := func(err error) (string, error) {
		_ = temp.Close()
		_ = os.Remove(tempPath)
		return "", err
	}
	if _, err := temp.Write(body); err != nil {
		return fail(fmt.Errorf("write timeline: %w", err))
	}
	if err := temp.Chmod(0o644); err != nil {
		return fail(fmt.Errorf("write timeline: %w", err))
	}
	if err := temp.Sync(); err != nil {
		return fail(fmt.Errorf("write timeline: %w", err))
	}
	if err := temp.Close(); err != nil {
		return fail(fmt.Errorf("write timeline: %w", err))
	}
	stem := strings.TrimSuffix(path, FileSuffix)
	for sequence := 0; ; sequence++ {
		candidate := path
		if sequence > 0 {
			candidate = fmt.Sprintf("%s.%d%s", stem, sequence, FileSuffix)
		}
		err := sessionfiles.RenameNoReplace(tempPath, candidate)
		if errors.Is(err, unix.EEXIST) {
			continue
		}
		if err != nil {
			return fail(fmt.Errorf("publish timeline: %w", err))
		}
		return candidate, nil
	}
}
