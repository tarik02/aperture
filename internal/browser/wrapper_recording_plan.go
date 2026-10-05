package browser

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/aperture/aperture/internal/recording"
)

// The planner turns a stopped recording's journal, capture facts and video analysis into an ffmpeg
// filter chain. It is pure. Times are milliseconds of the raw video unless a name says edited:
// the edited video has the raw video's frames at the times its time map gives them, and the
// captions, ripples and zooms are placed on that clock.
const (
	idleMinMS  = 1000 // the shortest stretch idle shortens, after the padding
	idleKeepMS = 300  // padding kept at normal speed around everything that happens
	idleSpeed  = 8
	// Group nearby changed frames; isolated changes still count as activity.
	activeGapMS = 200

	focusEaseMS     = 400
	focusMergeGapMS = 500 // focus windows closer than this share one zoom, so it does not bounce
	rippleMS        = 600
)

var errNothingKept = errors.New("nothing of the recording was kept: no browser call or effect fell in it")

type span struct{ start, end int64 }

// piece is a stretch of the raw video that the edited video keeps, played at speed.
type piece struct {
	start, end int64
	speed      float64
}

// journalEntry is one line of the journal: kind, startMs and endMs plus the kind's own fields.
type journalEntry map[string]any

func (e journalEntry) kind() string           { kind, _ := e["kind"].(string); return kind }
func (e journalEntry) num(key string) float64 { n, _ := e[key].(float64); return n }
func (e journalEntry) span() span             { return span{int64(e.num("startMs")), int64(e.num("endMs"))} }

type timelineSegment struct {
	*recordingSegment
	StartMS int64 `json:"startMs"` // where the segment begins in the raw video
}

type timelinePiece struct {
	RawStartMS    int64   `json:"rawStartMs"`
	RawEndMS      int64   `json:"rawEndMs"`
	Speed         float64 `json:"speed"`
	EditedStartMS int64   `json:"editedStartMs"`
}

// recordingTimeline is published next to the recording: what happened, where in the video.
type recordingTimeline struct {
	Version          int               `json:"version"`
	DurationMS       int64             `json:"durationMs"`
	EditedDurationMS int64             `json:"editedDurationMs,omitempty"`
	Segments         []timelineSegment `json:"segments"`
	Map              []timelinePiece   `json:"map,omitempty"`           // present when the video was edited
	Events           []journalEntry    `json:"events"`                  // journal entries with startMs and endMs in raw video time
	EventsDropped    int               `json:"eventsDropped,omitempty"` // journal entries lost to its budget: the events are incomplete
}

// recordingPlan is placed first (the journal on the video's clock) and then planned.
type recordingPlan struct {
	segments      []timelineSegment
	events        []journalEntry
	eventsDropped int
	total         int64
	pieces        []piece
	filter        string // empty when there is nothing to render
	ass           []byte
}

// placeJournal puts the journal's wall-clock times on the raw video's clock through the first-frame
// clock of the segment each falls in; times between segments land on their boundary.
func placeJournal(segments []*recordingSegment, entries []journalEntry) *recordingPlan {
	p := &recordingPlan{}
	for _, segment := range segments {
		if segment.FirstFrameMS != 0 {
			p.segments = append(p.segments, timelineSegment{segment, p.total})
			p.total += int64(segment.DurationMS)
		}
	}
	for _, entry := range entries {
		wall := entry.span()
		entry["startMs"], entry["endMs"] = float64(p.videoTime(wall.start)), float64(p.videoTime(wall.end))
		p.events = append(p.events, entry)
	}
	slices.SortStableFunc(p.events, func(a, b journalEntry) int { return int(a.span().start - b.span().start) })
	return p
}

func (p *recordingPlan) segmentAt(t int64) timelineSegment {
	at := p.segments[0]
	for _, segment := range p.segments {
		if segment.StartMS <= t {
			at = segment
		}
	}
	return at
}

func (p *recordingPlan) videoTime(wall int64) int64 {
	if len(p.segments) == 0 {
		return 0
	}
	at := p.segments[0]
	for _, segment := range p.segments {
		if segment.FirstFrameMS <= wall {
			at = segment
		}
	}
	return at.StartMS + min(max(wall-at.FirstFrameMS, 0), int64(at.DurationMS))
}

// plan decides the time map and the effects. Nothing to render leaves the filter empty.
func (p *recordingPlan) plan(cfg recording.Config, fps int, active []span) error {
	if p.total <= 0 {
		return nil
	}
	switch {
	case cfg.Capture == "bursts":
		burst := recording.DefaultBurst
		if cfg.Burst != nil {
			burst = *cfg.Burst
		}
		p.pieces = burstPieces(burst, p.events, active, p.total)
	case cfg.Idle != "":
		p.pieces = idlePieces(cfg.Idle, p.events, active, p.total)
	default:
		p.pieces = []piece{{0, p.total, 1}}
	}
	if len(p.pieces) == 0 {
		return errNothingKept
	}
	first := p.segments[0]
	width, height := first.Width, first.Height
	chain := p.frameFilters(width, height)
	mapped := len(p.pieces) != 1 || p.pieces[0] != (piece{0, p.total, 1})
	if mapped {
		chain = append(chain, remapFilters(p.pieces)...)
	}
	chain = append(chain, fmt.Sprintf("fps=%d", fps), "format=yuv420p")

	cues, ripples, zooms := p.effects(cfg.Ripple)
	chain = append(chain, focusFilters(zooms, float64(width), float64(height), fps)...)
	if len(cues)+len(ripples) > 0 {
		p.ass = marshalASS(cues, ripples, width, height)
		chain = append(chain, "ass=captions.ass")
	}
	if !mapped && len(cues)+len(zooms)+len(ripples) == 0 {
		return nil
	}
	p.filter = strings.Join(chain, ",")
	return nil
}

// frameFilters normalizes the timestamp origin and fits every segment into the first frame's size.
func (p *recordingPlan) frameFilters(width, height int) []string {
	chain := []string{"setpts=PTS-STARTPTS"}
	for _, segment := range p.segments {
		if segment.Width != width || segment.Height != height {
			// Later segments are fitted into the first one's size; framePoint maps their coordinates the same way.
			chain = append(chain, fmt.Sprintf("scale=%[1]d:%[2]d:force_original_aspect_ratio=decrease,pad=%[1]d:%[2]d:(ow-iw)/2:(oh-ih)/2", width, height))
			break
		}
	}
	return chain
}

// effects places the journal's captions, clicks and focuses on the edited video: at edited times,
// in frame px, and only those that fall in a kept piece. A caption ends with the piece it starts
// in, so it does not run on across a cut.
func (p *recordingPlan) effects(markClicks bool) (cues []cue, ripples []ripple, zooms []focus) {
	for _, e := range p.events {
		at := e.span()
		segment := p.segmentAt(at.start)
		start := mapTime(p.pieces, at.start)
		switch e.kind() {
		case "caption":
			if pc, kept := pieceAt(p.pieces, at.start); kept {
				end := min(start+int64(e.num("durationMs")), mapTime(p.pieces, pc.end))
				cues = append(cues, cue{start, end, sanitizeCaption(e)})
			}
		case "press":
			if _, kept := pieceAt(p.pieces, at.start); markClicks && kept {
				x, y := p.framePoint(segment, e.num("x"), e.num("y"))
				ripples = append(ripples, ripple{start, x, y})
			}
		case "focus":
			if _, kept := pieceAt(p.pieces, (at.start+at.end)/2); kept {
				if zoom, ok := p.focusAt(e, segment, at); ok {
					zooms = append(zooms, zoom)
				}
			}
		}
	}
	cues = fitCues(cues, mapTime(p.pieces, p.total))
	return cues, ripples, zooms
}

// focusAt places a focus entry on the edited video. Its rect, and every rect its element moved to
// while the focus lasted, is cut to the viewport, since only the visible part can be shown; the
// zoom is lowered so that part fits the frame, and the view follows its centre. A focus whose
// element was still out of view, about to be scrolled to, begins once it is in view.
func (p *recordingPlan) focusAt(e journalEntry, segment timelineSegment, at span) (focus, bool) {
	viewportWidth, viewportHeight := float64(segment.ViewportWidth), float64(segment.ViewportHeight)
	visible := func(raw any) (recording.Rect, bool) {
		fields, _ := raw.(map[string]any)
		num := func(key string) float64 { n, _ := fields[key].(float64); return n }
		x, y, width, height := num("x"), num("y"), num("width"), num("height")
		if viewportWidth > 0 && viewportHeight > 0 {
			left, top := max(x, 0), max(y, 0)
			right, bottom := min(x+width, viewportWidth), min(y+height, viewportHeight)
			x, y, width, height = left, top, right-left, bottom-top
		}
		if width == 0 && height == 0 { // the pointer
			inside := viewportWidth <= 0 || viewportHeight <= 0 || (x >= 0 && y >= 0 && x <= viewportWidth && y <= viewportHeight)
			return recording.Rect{X: x, Y: y}, inside
		}
		return recording.Rect{X: x, Y: y, Width: width, Height: height}, width > 0 && height > 0
	}
	type sample struct {
		at   int64
		rect any
	}
	samples := []sample{{at.start, e["rect"]}}
	track, _ := e["track"].([]any)
	for _, raw := range track {
		point, _ := raw.(map[string]any)
		offset, _ := point["atMs"].(float64)
		samples = append(samples, sample{at.start + int64(offset), point["rect"]})
	}
	f := focus{end: mapTime(p.pieces, at.end)}
	for _, s := range samples {
		rect, ok := visible(s.rect)
		if !ok {
			continue
		}
		t := mapTime(p.pieces, s.at)
		if len(f.path) == 0 {
			f.start, f.zoom = t, e.num("zoom")
			if viewportWidth > 0 && viewportHeight > 0 && rect.Width > 0 && rect.Height > 0 {
				f.zoom = max(1, min(f.zoom, viewportWidth/rect.Width, viewportHeight/rect.Height))
			}
		}
		x, y := p.framePoint(segment, rect.X+rect.Width/2, rect.Y+rect.Height/2)
		f.path = append(f.path, focusPoint{t, x, y})
	}
	if follow, _ := e["follow"].(string); follow == "pointer" && len(f.path) > 0 {
		f.path = deadZone(f.path, float64(p.segments[0].Width)/f.zoom, float64(p.segments[0].Height)/f.zoom)
	}
	return f, len(f.path) > 0 && f.end > f.start
}

// pointerDeadZone is the part of the zoomed view, centred, in which the pointer moves without
// moving the view: a view that chased every move of the pointer would never hold still.
const pointerDeadZone = 0.5

// deadZone turns the pointer's path into the view's: the view moves only as far as keeps the
// pointer inside the dead zone of a view of the given size.
func deadZone(path []focusPoint, viewWidth, viewHeight float64) []focusPoint {
	halfX, halfY := viewWidth*pointerDeadZone/2, viewHeight*pointerDeadZone/2
	view := []focusPoint{path[0]}
	at := path[0]
	for _, point := range path[1:] {
		x := max(point.x-halfX, min(at.x, point.x+halfX))
		y := max(point.y-halfY, min(at.y, point.y+halfY))
		if x == at.x && y == at.y {
			continue
		}
		at = focusPoint{point.t, x, y}
		view = append(view, at)
	}
	return view
}

// framePoint maps a point in a segment's viewport px to the edited frame, whose size is the first
// segment's: the segment's video is fitted into it, keeping its aspect ratio, and centred, as the
// scale and pad filters do.
func (p *recordingPlan) framePoint(segment timelineSegment, x, y float64) (float64, float64) {
	if segment.ViewportWidth <= 0 || segment.ViewportHeight <= 0 || segment.Width <= 0 || segment.Height <= 0 {
		return x, y
	}
	width, height := float64(p.segments[0].Width), float64(p.segments[0].Height)
	segmentWidth, segmentHeight := float64(segment.Width), float64(segment.Height)
	fit := min(width/segmentWidth, height/segmentHeight)
	offsetX, offsetY := (width-segmentWidth*fit)/2, (height-segmentHeight*fit)/2
	return x*segmentWidth/float64(segment.ViewportWidth)*fit + offsetX, y*segmentHeight/float64(segment.ViewportHeight)*fit + offsetY
}

// timeline reports the journal in video time; edited adds the time map and each event's edited times.
func (p *recordingPlan) timeline(edited bool) recordingTimeline {
	t := recordingTimeline{Version: 1, DurationMS: p.total, Segments: p.segments, Events: p.events, EventsDropped: p.eventsDropped}
	if !edited {
		return t
	}
	t.EditedDurationMS = mapTime(p.pieces, p.total)
	for _, pc := range p.pieces {
		t.Map = append(t.Map, timelinePiece{pc.start, pc.end, pc.speed, mapTime(p.pieces, pc.start)})
	}
	for _, e := range p.events {
		at := e.span()
		e["editedStartMs"], e["editedEndMs"] = float64(mapTime(p.pieces, at.start)), float64(mapTime(p.pieces, at.end))
	}
	return t
}

// mapTime is where a raw video time falls in the edited video; a time in a cut stretch falls where it was cut.
func mapTime(pieces []piece, t int64) int64 {
	var out float64
	for _, pc := range pieces {
		if t <= pc.start {
			break
		}
		out += float64(min(t, pc.end)-pc.start) / pc.speed
	}
	return int64(math.Round(out))
}

// pieceAt is the kept piece a raw video time falls in, if any.
func pieceAt(pieces []piece, t int64) (piece, bool) {
	index := slices.IndexFunc(pieces, func(pc piece) bool { return t >= pc.start && t < pc.end })
	if index < 0 {
		return piece{}, false
	}
	return pieces[index], true
}

// mergeSpans pads spans, clamps them to the video and joins those that touch.
func mergeSpans(spans []span, pad, total int64) []span {
	spans = slices.Clone(spans)
	for i := range spans {
		spans[i] = span{max(spans[i].start-pad, 0), min(spans[i].end+pad, total)}
	}
	slices.SortFunc(spans, func(a, b span) int { return int(a.start - b.start) })
	var merged []span
	for _, s := range spans {
		if s.end < s.start {
			continue
		}
		if n := len(merged); n > 0 && s.start <= merged[n-1].end {
			merged[n-1].end = max(merged[n-1].end, s.end)
		} else {
			merged = append(merged, s)
		}
	}
	return merged
}

// burstPieces keeps the stretch around every browser tool call and every explicit focus or
// attention: from lead before it to the end of its tail, which lasts until the screen has settled
// (no change for the settle time) but not longer than maxTail.
func burstPieces(b recording.Burst, events []journalEntry, active []span, total int64) []piece {
	active = mergeSpans(active, 0, total)
	var keep []span
	for _, e := range events {
		if kind := e.kind(); kind != "call" && kind != "focus" && kind != "attention" {
			continue
		}
		at := e.span()
		still := at.end // until when the picture changes, with pauses shorter than the settle time
		for _, a := range active {
			if a.end > at.end && a.start-still < b.SettleMS {
				still = max(still, a.end)
			}
		}
		end := min(max(at.end+b.TailMS, still+b.SettleMS), at.end+b.MaxTailMS)
		keep = append(keep, span{at.start - b.LeadMS, end})
	}
	var pieces []piece
	for _, s := range mergeSpans(keep, 0, total) {
		pieces = append(pieces, piece{s.start, s.end, 1})
	}
	return pieces
}

// idlePieces cuts, or speeds up, the stretches in which nothing happens: no change in the picture
// and no journal entry, apart from a little padding.
func idlePieces(mode string, events []journalEntry, active []span, total int64) []piece {
	busy := slices.Clone(active)
	for _, e := range events {
		busy = append(busy, e.span())
	}
	busy = mergeSpans(busy, idleKeepMS, total)
	var pieces []piece
	var cursor int64
	idle := func(s span) {
		if s.end-s.start < idleMinMS {
			return
		}
		if s.start > cursor {
			pieces = append(pieces, piece{cursor, s.start, 1})
		}
		if mode == "speed" {
			pieces = append(pieces, piece{s.start, s.end, idleSpeed})
		}
		cursor = s.end
	}
	last := int64(0)
	for _, b := range busy {
		idle(span{last, b.start})
		last = b.end
	}
	idle(span{last, total})
	if cursor < total {
		pieces = append(pieces, piece{cursor, total, 1})
	}
	return pieces
}

// remapFilters keep the frames inside the pieces and give each the time it has in the edited
// video: the lengths of the pieces before it, over their speeds, plus its place in its own.
func remapFilters(pieces []piece) []string {
	var keep, times []string
	for _, pc := range pieces {
		from, to := seconds(pc.start), seconds(pc.end)
		keep = append(keep, fmt.Sprintf("gte(t,%s)*lt(t,%s)", from, to))
		term := fmt.Sprintf("(clip(T,%s,%s)-%s)", from, to, from)
		if pc.speed != 1 {
			term += fmt.Sprintf("/%g", pc.speed)
		}
		times = append(times, term)
	}
	return []string{"select='" + strings.Join(keep, "+") + "'", "setpts='(" + strings.Join(times, "+") + ")/TB'"}
}

func seconds(ms int64) string { return strconv.FormatFloat(float64(ms)/1000, 'f', 3, 64) }

// focus is a zoom the recording asked for: a window of edited time, a factor and the path of the
// view's centre in frame px, which has a point at start and one wherever its element moved.
type focus struct {
	start, end int64
	zoom       float64
	path       []focusPoint
}

type focusPoint struct {
	t    int64
	x, y float64
}

type focusKey struct {
	t          int64
	zoom, x, y float64
	steady     bool // reached at a steady pace, not eased: a key of a followed path, so the view does not stop at every sample
}

// focusFilters zooms with perspective, which stretches a source rectangle to the whole frame. A zoom
// eases in and out inside its window; windows closer than focusMergeGapMS stay zoomed in between
// and only pan, so adjacent focuses do not bounce.
func focusFilters(zooms []focus, width, height float64, fps int) []string {
	slices.SortStableFunc(zooms, func(a, b focus) int { return int(a.start - b.start) })
	var filters []string
	for i := 0; i < len(zooms); {
		j := i + 1
		for j < len(zooms) && zooms[j].start-zooms[j-1].end <= focusMergeGapMS {
			j++
		}
		group := zooms[i:j]
		i = j
		whole := focusKey{0, 1, width / 2, height / 2, false}
		ease := min(focusEaseMS, (group[0].end-group[0].start)/3)
		keys := []focusKey{{group[0].start, 1, whole.x, whole.y, false}}
		for k, f := range group {
			// The view's centre keeps the zoomed view inside the frame.
			key := func(t int64, point focusPoint) focusKey {
				x := max(width/(2*f.zoom), min(point.x, width-width/(2*f.zoom)))
				y := max(height/(2*f.zoom), min(point.y, height-height/(2*f.zoom)))
				return focusKey{t, f.zoom, x, y, false}
			}
			hold := f.end
			if k == len(group)-1 {
				hold -= ease
			}
			// The view eases in to where the element is once the ease ends, then follows it.
			arrived := f.start + ease
			at := f.path[0]
			rest := f.path[1:]
			for len(rest) > 0 && rest[0].t <= arrived {
				at, rest = rest[0], rest[1:]
			}
			keys = append(keys, key(arrived, at))
			for _, point := range rest {
				if point.t >= hold {
					break
				}
				followed := key(point.t, point)
				followed.steady = true
				keys = append(keys, followed)
				at = point
			}
			keys = append(keys, key(max(hold, keys[len(keys)-1].t), at))
		}
		keys = append(keys, focusKey{group[len(group)-1].end, 1, whole.x, whole.y, false})
		filters = append(filters, focusFilter(keys, width, height, fps))
	}
	return filters
}

// focusFilter plays keys, each a view the picture eases to from the previous one, or moves to at a
// steady pace when the key is steady. perspective
// counts input frames from one, so key times become frame numbers, whole frames apart.
func focusFilter(keys []focusKey, width, height float64, fps int) string {
	frames := make([]int64, len(keys))
	for i, key := range keys {
		frames[i] = int64(math.Round(float64(key.t) * float64(fps) / 1000))
		if i > 0 {
			frames[i] = max(frames[i], frames[i-1]+1)
		}
	}
	edge := func(value func(focusKey) float64) string {
		expr := strconv.FormatFloat(value(keys[0]), 'f', 2, 64)
		for i := 0; i+1 < len(keys); i++ {
			delta := value(keys[i+1]) - value(keys[i])
			if math.Abs(delta) < 0.005 {
				continue
			}
			if keys[i+1].steady {
				expr += fmt.Sprintf("%+.2f*clip((in-%d)/%d,0,1)", delta, frames[i]+1, frames[i+1]-frames[i])
				continue
			}
			expr += fmt.Sprintf("%+.2f*(1-cos(PI*clip((in-%d)/%d,0,1)))/2", delta, frames[i]+1, frames[i+1]-frames[i])
		}
		return expr
	}
	left := edge(func(k focusKey) float64 { return k.x - width/(2*k.zoom) })
	right := edge(func(k focusKey) float64 { return k.x + width/(2*k.zoom) })
	top := edge(func(k focusKey) float64 { return k.y - height/(2*k.zoom) })
	bottom := edge(func(k focusKey) float64 { return k.y + height/(2*k.zoom) })
	half := 0.5 / float64(fps)
	return fmt.Sprintf("perspective=x0='%s':y0='%s':x1='%s':y1='%s':x2='%s':y2='%s':x3='%s':y3='%s':interpolation=cubic:eval=frame:enable='between(t,%.4f,%.4f)'",
		left, top, right, top, left, bottom, right, bottom,
		float64(frames[0])/float64(fps)-half, float64(frames[len(frames)-1])/float64(fps)+half)
}

var frameLine = regexp.MustCompile(`pts_time:([0-9.]+)`)

func msOf(s string) int64 { f, _ := strconv.ParseFloat(s, 64); return int64(math.Round(f * 1000)) }

// activeSpans reads showinfo's log of the frames mpdecimate kept, a line at a time, and joins those
// that follow each other closely into the stretches in which the picture changed. Isolated frames
// count too: a slow update can be meaningful even when it has no matching input event.
type activeSpans struct {
	active              []span
	start, last, frames int64
}

func (a *activeSpans) observe(line string) {
	m := frameLine.FindStringSubmatch(line)
	if m == nil {
		return
	}
	if t := msOf(m[1]); a.frames > 0 && t-a.last <= activeGapMS {
		a.frames++
		a.last = t
	} else {
		a.flush()
		a.start, a.last, a.frames = t, t, 1
	}
}

func (a *activeSpans) flush() {
	if a.frames > 0 {
		a.active = append(a.active, span{a.start, a.last})
	}
	a.frames = 0
}

// spans ends the run being read and returns the stretches.
func (a *activeSpans) spans() []span {
	a.flush()
	return a.active
}

func parseActive(log string) []span {
	var a activeSpans
	for _, line := range strings.Split(log, "\n") {
		a.observe(line)
	}
	return a.spans()
}
