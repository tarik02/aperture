package timeline

import (
	"cmp"
	"errors"
	"math"
	"slices"
	"sync"
	"time"
)

// Limits bounds what a Builder keeps, so a long recording with many gestures
// cannot grow without bound. A part that exceeds its limit is left out and the
// timeline says so in Truncation.
type Limits struct {
	MaxGestures             int
	MaxPathPointsPerGesture int
	MaxPathPointsTotal      int
	MaxActivitySpans        int
	MaxUnknownSpans         int
	// MaxBurstActions bounds the actions kept for bursts recordings.
	MaxBurstActions int
	// SampleInterval is reported in Activity; it is how often the caller samples.
	SampleInterval time.Duration
	// MergeGap is the longest pause between two changes that is still one span.
	MergeGap time.Duration
}

// DefaultLimits are the limits recordings use: room for hours of recording
// with a gesture every few seconds, in about a megabyte of JSON.
func DefaultLimits() Limits {
	return Limits{
		MaxGestures:             2000,
		MaxPathPointsPerGesture: 240,
		MaxPathPointsTotal:      100_000,
		MaxActivitySpans:        20_000,
		MaxUnknownSpans:         1000,
		MaxBurstActions:         5000,
		SampleInterval:          50 * time.Millisecond,
		MergeGap:                250 * time.Millisecond,
	}
}

// pathTolerance is how far, in page pixels, a thinned cursor path may stray
// from the recorded one.
const pathTolerance = 0.5

// Clock places the frames of one segment in wall time, as the capture pipeline
// saw them.
type Clock struct {
	// FirstFrame is the wall time the segment's first frame reached the encoder
	// and FirstPTS that frame's timestamp in the segment's own file.
	FirstFrame time.Time
	FirstPTS   time.Duration
	// Duration is the time from the first frame to the end of the last one, or
	// zero while unknown.
	Duration time.Duration
}

// SegmentInput describes a segment when it starts.
type SegmentInput struct {
	TargetID  string
	CaptureID string
	// Width and Height are the pixels of the segment's frames.
	Width  int
	Height int
	// ScaleX and ScaleY convert page coordinates to frame pixels.
	ScaleX float64
	ScaleY float64
	// Started is the wall time the segment's pipeline was started. It stands in for
	// the first frame when Clock reports none.
	Started time.Time
	// Clock returns the pipeline's account of the segment's frames, and false
	// while there is none. It is called when the timeline is built.
	Clock func() (Clock, bool)
	// Burst is the number of the burst the segment belongs to, starting at 1, or
	// zero for a segment of a continuous recording. Consecutive segments with the
	// same number are one burst.
	Burst uint64
}

// ActionInput is a browser action that ran during a burst, at wall times.
type ActionInput struct {
	Tool     string
	Kind     string
	TargetID string
	Start    time.Time
	End      time.Time
	// Gesture is the ID of the pointer gesture the action made, or zero.
	Gesture uint64
}

// PathInput is a cursor position, Offset after the gesture's Start, in page pixels.
type PathInput struct {
	Offset time.Duration
	X      float64
	Y      float64
}

// PointInput is a position in page pixels.
type PointInput struct {
	X float64
	Y float64
}

// ClickInput is a button press at wall time At, in page pixels.
type ClickInput struct {
	At     time.Time
	X      float64
	Y      float64
	Button string
	Count  int
}

// GestureInput is a finished gesture with wall times and page coordinates.
type GestureInput struct {
	ID       uint64
	Kind     string
	Tool     string
	Mode     string
	TargetID string
	Start    time.Time
	End      time.Time
	Hold     time.Duration
	Path     []PathInput
	Clicks   []ClickInput
	ScrollX  float64
	ScrollY  float64
	// ScrollAt is where a scroll's wheel turned, in page pixels, when known.
	ScrollAt *PointInput
	Caption  string
}

// BuildOptions describe the video a timeline is built for.
type BuildOptions struct {
	// Recording carries the fields the builder cannot know: ID, Video, Mode,
	// Codec, FPS and StartedAt. The others are filled in.
	Recording Recording
	// Segments selects the segments the video contains, by index, in order. Nil
	// means all of them, joined into one video. A video that holds a single
	// segment is not re-timed, so its container timestamps start at that
	// segment's first frame timestamp; several are joined and start at zero.
	Segments []int
	// End is the wall time of unfinished segments' end. It defaults to now.
	End time.Time
}

type wallSpan struct{ start, end time.Time }

type wallSpans struct{ list []wallSpan }

type segmentState struct {
	input    SegmentInput
	ended    time.Time
	closedBy string
}

// Builder collects what happens during a recording, from any goroutine, and
// turns it into a Timeline once the video exists.
type Builder struct {
	mu        sync.Mutex
	limits    Limits
	segments  []*segmentState
	gestures  []GestureInput
	actions   []ActionInput
	pathTotal int
	truncated Truncation
	changes   map[string]*wallSpans
	unknown   map[string]*wallSpans
	samples   int
}

// NewBuilder returns a builder that keeps within limits; zero fields take the defaults.
func NewBuilder(limits Limits) *Builder {
	defaults := DefaultLimits()
	limits.MaxGestures = cmp.Or(limits.MaxGestures, defaults.MaxGestures)
	limits.MaxPathPointsPerGesture = cmp.Or(limits.MaxPathPointsPerGesture, defaults.MaxPathPointsPerGesture)
	limits.MaxPathPointsTotal = cmp.Or(limits.MaxPathPointsTotal, defaults.MaxPathPointsTotal)
	limits.MaxActivitySpans = cmp.Or(limits.MaxActivitySpans, defaults.MaxActivitySpans)
	limits.MaxUnknownSpans = cmp.Or(limits.MaxUnknownSpans, defaults.MaxUnknownSpans)
	limits.MaxBurstActions = cmp.Or(limits.MaxBurstActions, defaults.MaxBurstActions)
	limits.SampleInterval = cmp.Or(limits.SampleInterval, defaults.SampleInterval)
	limits.MergeGap = cmp.Or(limits.MergeGap, defaults.MergeGap)
	return &Builder{
		limits:  limits,
		changes: make(map[string]*wallSpans),
		unknown: make(map[string]*wallSpans),
	}
}

// BeginSegment starts the next segment and returns its index. It is the
// current segment until it ends or is replaced by a later one, and while two
// overlap, as they do when a recording switches targets, the later one is.
func (b *Builder) BeginSegment(input SegmentInput) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.segments = append(b.segments, &segmentState{input: input})
	return len(b.segments) - 1
}

// EndSegment records when a segment's pipeline was stopped. Only the first call
// for a segment counts.
func (b *Builder) EndSegment(index int, at time.Time) {
	b.EndSegmentClosedBy(index, at, "")
}

// EndSegmentClosedBy records when a segment's pipeline was stopped and, for a
// burst segment, why (closedBy is left alone when empty). Only the first call for
// a segment counts.
func (b *Builder) EndSegmentClosedBy(index int, at time.Time, closedBy string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if index < 0 || index >= len(b.segments) || !b.segments[index].ended.IsZero() {
		return
	}
	b.segments[index].ended = at
	if closedBy != "" {
		b.segments[index].closedBy = closedBy
	}
}

// SetSegmentClosedBy records why a burst segment was ended.
func (b *Builder) SetSegmentClosedBy(index int, reason string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if index >= 0 && index < len(b.segments) {
		b.segments[index].closedBy = reason
	}
}

// AddAction records a browser action that ran during a burst. Actions that ran
// outside every segment are dropped when the timeline is built.
func (b *Builder) AddAction(action ActionInput) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.actions) >= b.limits.MaxBurstActions {
		b.truncated.Bursts = true
		return
	}
	b.actions = append(b.actions, action)
}

// DiscardSegment removes the newest segment, which must have the given index,
// when it never produced anything, such as a replacement pipeline that failed.
func (b *Builder) DiscardSegment(index int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if index >= 0 && index == len(b.segments)-1 {
		b.segments = b.segments[:index]
	}
}

// ActiveCaptures are the captures of the segments still being recorded, oldest
// first and without repeats. It is more than one while a segment is being
// replaced: the old pipeline records until the new one has its first frame.
func (b *Builder) ActiveCaptures() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	var captures []string
	for _, segment := range b.segments {
		if segment.ended.IsZero() && !slices.Contains(captures, segment.input.CaptureID) {
			captures = append(captures, segment.input.CaptureID)
		}
	}
	return captures
}

// NoteSample records that the compositor was sampled successfully, whether or
// not it reported a change.
func (b *Builder) NoteSample() {
	b.mu.Lock()
	b.samples++
	b.mu.Unlock()
}

// AddChange records that the content of a capture changed at wall time at.
func (b *Builder) AddChange(capture string, at time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	spans := b.changes[capture]
	if spans == nil {
		spans = &wallSpans{}
		b.changes[capture] = spans
	}
	if !spans.add(wallSpan{start: at, end: at}, b.limits.MergeGap, b.limits.MaxActivitySpans) {
		b.truncated.Activity = true
	}
}

// AddUnknown records that a capture could not be sampled from one wall time to another.
func (b *Builder) AddUnknown(capture string, from, to time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	spans := b.unknown[capture]
	if spans == nil {
		spans = &wallSpans{}
		b.unknown[capture] = spans
	}
	// Unknown intervals are kept apart unless they touch.
	spans.add(wallSpan{start: from, end: to}, 0, b.limits.MaxUnknownSpans)
}

// add merges a span into the list, which is ordered, and reports whether it fit.
func (s *wallSpans) add(span wallSpan, gap time.Duration, limit int) bool {
	if last := len(s.list) - 1; last >= 0 && !span.start.Before(s.list[last].start) && span.start.Sub(s.list[last].end) <= gap {
		if span.end.After(s.list[last].end) {
			s.list[last].end = span.end
		}
		return true
	}
	if len(s.list) >= limit {
		return false
	}
	s.list = append(s.list, span)
	// Spans arrive in order; keep them ordered when one does not.
	if last := len(s.list) - 1; last > 0 && s.list[last].start.Before(s.list[last-1].start) {
		slices.SortFunc(s.list, func(a, b wallSpan) int { return a.start.Compare(b.start) })
	}
	return true
}

// AddGesture records a finished gesture. Its path is thinned right away, so
// memory stays bounded; what the builder keeps does not alias the input.
func (b *Builder) AddGesture(gesture GestureInput) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.gestures) >= b.limits.MaxGestures {
		b.truncated.Gestures = true
		return
	}
	path, thinned := thinPath(gesture.Path, b.limits.MaxPathPointsPerGesture)
	if thinned {
		b.truncated.PathPoints = true
	}
	if b.pathTotal+len(path) > b.limits.MaxPathPointsTotal {
		path = nil
		b.truncated.PathPoints = true
	}
	b.pathTotal += len(path)
	gesture.Path = path
	gesture.Clicks = slices.Clone(gesture.Clicks)
	b.gestures = append(b.gestures, gesture)
}

// thinPath drops the points that interpolating in time between their
// neighbors would reproduce within pathTolerance, and if more than limit
// remain, keeps an evenly spaced subset that includes the first and last. The
// bool is true in the second case, where shape is lost.
//
// The tolerance is measured against the position at the same time, not against
// the line, because pointer motion eases in and out: a straight stretch that is
// crossed at varying speed still needs its points to be replayed on time.
func thinPath(path []PathInput, limit int) ([]PathInput, bool) {
	if len(path) <= 2 {
		return slices.Clone(path), false
	}
	keep := make([]bool, len(path))
	keep[0], keep[len(path)-1] = true, true
	type run struct{ from, to int }
	stack := []run{{0, len(path) - 1}}
	for len(stack) > 0 {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		farthest, distance := -1, pathTolerance
		for index := current.from + 1; index < current.to; index++ {
			if d := interpolationError(path[index], path[current.from], path[current.to]); d > distance {
				farthest, distance = index, d
			}
		}
		if farthest >= 0 {
			keep[farthest] = true
			stack = append(stack, run{current.from, farthest}, run{farthest, current.to})
		}
	}
	thinned := make([]PathInput, 0, len(path))
	for index, point := range path {
		if keep[index] {
			thinned = append(thinned, point)
		}
	}
	if limit < 2 || len(thinned) <= limit {
		return thinned, false
	}
	subset := make([]PathInput, 0, limit)
	for index := range limit {
		subset = append(subset, thinned[index*(len(thinned)-1)/(limit-1)])
	}
	return subset, true
}

// interpolationError is how far a point is from where a straight movement from
// one point to another, at constant speed, would have it at the point's time.
func interpolationError(point, from, to PathInput) float64 {
	span := to.Offset - from.Offset
	if span <= 0 {
		return math.Hypot(point.X-from.X, point.Y-from.Y)
	}
	t := max(0, min(1, float64(point.Offset-from.Offset)/float64(span)))
	return math.Hypot(point.X-(from.X+t*(to.X-from.X)), point.Y-(from.Y+t*(to.Y-from.Y)))
}

// placed is a segment with its place in wall time and in the video.
type placed struct {
	index int
	input SegmentInput
	// first is the wall time of the first frame, length the segment's duration.
	first  time.Time
	length time.Duration
	// pts is the timestamp of the first frame in the segment's own file.
	pts time.Duration
	// videoStart is the video time of the first frame.
	videoStart time.Duration
	clock      string
	closedBy   string
	// ownStart and ownEnd are the wall times of the segment that events belong
	// to. Segments overlap in wall time while the next one starts up; the newer
	// segment owns the overlap.
	ownStart time.Time
	ownEnd   time.Time
}

// video returns the video time of a wall time inside the segment.
func (p *placed) video(at time.Time) time.Duration {
	return p.videoStart + max(0, min(at.Sub(p.first), p.length))
}

func (p *placed) owns(at time.Time) bool {
	return !at.Before(p.ownStart) && !at.After(p.ownEnd)
}

func toMs(d time.Duration) int64 { return d.Round(time.Millisecond).Milliseconds() }

// Build produces the timeline of a video made of the selected segments. It can
// be called while the builder is still collecting; it never modifies it.
func (b *Builder) Build(options BuildOptions) (*Timeline, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	end := options.End
	if end.IsZero() {
		end = time.Now()
	}
	selected := options.Segments
	if selected == nil {
		selected = make([]int, len(b.segments))
		for index := range selected {
			selected[index] = index
		}
	}
	if len(selected) == 0 {
		return nil, errors.New("timeline has no segments")
	}
	segments := make([]*placed, 0, len(selected))
	for _, index := range selected {
		if index < 0 || index >= len(b.segments) {
			return nil, errors.New("timeline refers to a missing segment")
		}
		segments = append(segments, place(index, b.segments[index], end))
		segments[len(segments)-1].closedBy = b.segments[index].closedBy
	}
	joined := len(segments) > 1
	var elapsed time.Duration
	for index, segment := range segments {
		segment.videoStart = elapsed
		elapsed += segment.length
		segment.ownEnd = segment.first.Add(segment.length)
		if index+1 < len(segments) {
			segment.ownEnd = minTime(segment.ownEnd, segments[index+1].first)
		}
	}

	out := &Timeline{
		Version:   Version,
		Recording: options.Recording,
		Segments:  make([]Segment, 0, len(segments)),
		Gestures:  []Gesture{},
		Captions:  []Caption{},
		Truncated: b.truncated,
	}
	first := segments[0]
	out.Recording.Width, out.Recording.Height = first.input.Width, first.input.Height
	out.Recording.DurationMs = toMs(elapsed)
	if !joined {
		out.Recording.ContainerStartMs = toMs(first.firstPTS())
	}
	for position, segment := range segments {
		out.Segments = append(out.Segments, Segment{
			Index:        position,
			TargetID:     segment.input.TargetID,
			StartMs:      toMs(segment.videoStart),
			EndMs:        toMs(segment.videoStart + segment.length),
			Width:        segment.input.Width,
			Height:       segment.input.Height,
			ScaleX:       segment.input.ScaleX,
			ScaleY:       segment.input.ScaleY,
			FirstFrameAt: segment.first,
			Clock:        segment.clock,
		})
	}
	out.Bursts = b.mapBursts(segments)
	out.Gestures, out.Captions = b.mapGestures(segments)
	out.Activity = b.mapActivity(segments)
	return out, nil
}

func minTime(a, b time.Time) time.Time {
	if b.Before(a) {
		return b
	}
	return a
}

// firstPTS is the timestamp of the segment's first frame in its own file.
func (p *placed) firstPTS() time.Duration {
	if p.clock != ClockPipeline {
		return 0
	}
	return p.pts
}

func place(index int, state *segmentState, end time.Time) *placed {
	result := &placed{index: index, input: state.input, first: state.input.Started, clock: ClockEstimated}
	var known Clock
	ok := false
	if state.input.Clock != nil {
		known, ok = state.input.Clock()
	}
	if ok && !known.FirstFrame.IsZero() {
		result.first = known.FirstFrame
		result.pts = known.FirstPTS
		result.length = known.Duration
		result.clock = ClockPipeline
	}
	if result.length <= 0 {
		stop := state.ended
		if stop.IsZero() {
			stop = end
		}
		result.length = max(0, stop.Sub(result.first))
	}
	result.ownStart = result.first
	return result
}
