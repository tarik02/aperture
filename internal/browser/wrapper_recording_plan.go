package browser

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// The planner turns a stopped recording's journal, capture facts and video analysis into an ffmpeg
// filter chain. It is pure. Times are milliseconds of the raw video unless a name says edited:
// the edited video has the raw video's frames at the times its time map gives them, and the
// captions, ripples and zooms are placed on that clock.
const (
	idleMinMS  = 1000 // the shortest stretch idle shortens, after the padding
	idleKeepMS = 300  // padding kept at normal speed around everything that happens
	idleSpeed  = 8
	// Frames of a real change are closer than this; a blinking caret's are not.
	activeGapMS = 200

	focusEaseMS     = 400
	focusMergeGapMS = 500 // focus windows closer than this share one zoom, so it does not bounce
	rippleMS        = 600
	rippleRadius    = 48 // px of a 1280 px wide frame

	filterMaxBytes = 100_000 // one command line argument may be 128 KiB
)

var errTooManyEdits = errors.New("the recording has too many cuts and effects to render")

type span struct{ start, end int64 }

// piece is a stretch of the raw video that the edited video keeps, played at speed.
type piece struct {
	start, end int64
	speed      float64
}

// videoAnalysis is what ffmpeg saw in the raw video: where the picture changed (idle) or stood
// still for the settle time (bursts).
type videoAnalysis struct{ active, frozen []span }

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
	Map              []timelinePiece   `json:"map,omitempty"` // present when the video was edited
	Events           []journalEntry    `json:"events"`        // journal entries with startMs and endMs in raw video time
}

// recordingPlan is placed first (the journal on the video's clock) and then planned.
type recordingPlan struct {
	segments []timelineSegment
	events   []journalEntry
	total    int64
	pieces   []piece
	filter   string // empty when there is nothing to render
	ass      []byte
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
func (p *recordingPlan) plan(cfg recordingConfig, fps int, a videoAnalysis) error {
	if p.total <= 0 {
		return nil
	}
	switch {
	case cfg.Capture == "bursts":
		p.pieces = burstPieces(*cfg.Burst, p.events, a.frozen, p.total)
	case cfg.Idle != "":
		p.pieces = idlePieces(cfg.Idle, p.events, a.active, p.total)
	default:
		p.pieces = []piece{{0, p.total, 1}}
	}
	if len(p.pieces) == 0 {
		return nil
	}
	first := p.segments[0]
	width, height := first.Width, first.Height
	chain := []string{"setpts=PTS-STARTPTS"}
	for _, segment := range p.segments {
		if segment.Width != width || segment.Height != height {
			chain = append(chain, fmt.Sprintf("scale=%d:%d", width, height)) // later segments take the first one's size
			break
		}
	}
	mapped := len(p.pieces) != 1 || p.pieces[0] != (piece{0, p.total, 1})
	if mapped {
		chain = append(chain, remapFilters(p.pieces)...)
	}
	chain = append(chain, fmt.Sprintf("fps=%d", fps), "format=yuv420p")

	effects := 0
	var cues []cue
	var zooms []focus
	for _, e := range p.events {
		at, scaleX, scaleY := e.span(), 1.0, 1.0
		if segment := p.segmentAt(at.start); segment.ViewportWidth > 0 && segment.ViewportHeight > 0 {
			scaleX, scaleY = float64(width)/float64(segment.ViewportWidth), float64(height)/float64(segment.ViewportHeight)
		}
		start := mapTime(p.pieces, at.start)
		switch e.kind() {
		case "caption":
			cues = append(cues, cue{start, start + int64(e.num("durationMs")), sanitizeCaption(e)})
		case "press":
			if cfg.Ripple && inPieces(p.pieces, at.start) {
				chain = append(chain, rippleFilter(start, e.num("x")*scaleX, e.num("y")*scaleY, width, fps))
				effects++
			}
		case "focus":
			rect, _ := e["rect"].(map[string]any)
			num := func(key string) float64 { n, _ := rect[key].(float64); return n }
			if inPieces(p.pieces, (at.start+at.end)/2) {
				zooms = append(zooms, focus{start, mapTime(p.pieces, at.end), e.num("zoom"), (num("x") + num("width")/2) * scaleX, (num("y") + num("height")/2) * scaleY})
			}
		}
	}
	chain = append(chain, focusFilters(zooms, float64(width), float64(height), fps)...)
	cues = fitCues(cues, mapTime(p.pieces, p.total))
	if len(cues) > 0 {
		p.ass = marshalASS(cues, width, height)
		chain = append(chain, "ass=captions.ass")
	}
	if !mapped && len(cues)+len(zooms)+effects == 0 {
		return nil
	}
	p.filter = strings.Join(chain, ",")
	if len(p.filter) > filterMaxBytes {
		return errTooManyEdits
	}
	return nil
}

// timeline reports the journal in video time; edited adds the time map and each event's edited times.
func (p *recordingPlan) timeline(edited bool) recordingTimeline {
	t := recordingTimeline{Version: 1, DurationMS: p.total, Segments: p.segments, Events: p.events}
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

func inPieces(pieces []piece, t int64) bool {
	return slices.ContainsFunc(pieces, func(pc piece) bool { return t >= pc.start && t < pc.end })
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
// (stood still for the settle time) but not longer than maxTail.
func burstPieces(b burstConfig, events []journalEntry, frozen []span, total int64) []piece {
	var keep []span
	for _, e := range events {
		if kind := e.kind(); kind != "call" && kind != "focus" && kind != "attention" {
			continue
		}
		at := e.span()
		end := at.end + b.TailMS
		if i := slices.IndexFunc(frozen, func(f span) bool { return f.end >= end }); i >= 0 {
			end = max(end, frozen[i].start+b.SettleMS)
		} else {
			end = at.end + b.MaxTailMS // the screen was still changing when the video ended
		}
		keep = append(keep, span{at.start - b.LeadMS, min(end, at.end+b.MaxTailMS)})
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

type cue struct {
	start, end int64
	text       string
}

func sanitizeCaption(e journalEntry) string {
	text, _ := e["text"].(string)
	return strings.Join(strings.Fields(text), " ")
}

// fitCues keeps cues inside the video and ends each where the next begins.
func fitCues(cues []cue, total int64) []cue {
	slices.SortStableFunc(cues, func(a, b cue) int { return int(a.start - b.start) })
	for i := range cues {
		cues[i].end = min(cues[i].end, total)
		if i+1 < len(cues) {
			cues[i].end = min(cues[i].end, cues[i+1].start)
		}
	}
	return slices.DeleteFunc(cues, func(c cue) bool { return c.end <= c.start || c.text == "" })
}

// marshalASS writes the cues as an ASS script for the ass filter: white text on a dark box near
// the bottom edge. A backslash would start an override tag, so it becomes the fullwidth one, and
// braces are escaped.
func marshalASS(cues []cue, width, height int) []byte {
	size := max(int(float64(height)*0.045+0.5), 12)
	margin := int(float64(width)*0.06 + 0.5)
	box := max(int(float64(height)*0.008+0.5), 2)
	var out strings.Builder
	fmt.Fprintf(&out, "[Script Info]\nScriptType: v4.00+\nPlayResX: %d\nPlayResY: %d\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n", width, height)
	out.WriteString("[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n")
	// BorderStyle 3 draws the outline colour as a box behind the text.
	fmt.Fprintf(&out, "Style: Default,Noto Sans,%d,&H00FFFFFF,&H00FFFFFF,&H30000000,&H30000000,0,0,0,0,100,100,0,0,3,%d,0,2,%d,%d,%d,1\n\n", size, box, margin, margin, int(float64(height)*0.06+0.5))
	out.WriteString("[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
	escape := strings.NewReplacer(`\`, "＼", "{", `\{`, "}", `\}`)
	stamp := func(ms int64) string {
		return fmt.Sprintf("%d:%02d:%02d.%02d", ms/3600000, ms/60000%60, ms/1000%60, ms%1000/10)
	}
	for _, c := range cues {
		fmt.Fprintf(&out, "Dialogue: 0,%s,%s,Default,,0,0,0,,%s\n", stamp(c.start), stamp(c.end), escape.Replace(strings.ToValidUTF8(c.text, "")))
	}
	return []byte(out.String())
}

// rippleFilter draws a ring that spreads from a click and fades, with a dark halo outside it so it
// shows on light and dark pages. It changes luma only; geq passes every pixel out of the ring's
// reach through, and the filter is enabled only while the ripple shows.
func rippleFilter(startMS int64, x, y float64, width, fps int) string {
	scale := float64(width) / 1280
	final := rippleRadius * scale
	soft, gap := 3.5*scale, 2.6*scale
	reach := final + gap + 3*soft
	begin, duration := float64(startMS)/1000, float64(rippleMS)/1000
	// Y values are limited range: white is 235 and the halo's dark 24.
	luma := fmt.Sprintf("if(gt(abs(X-%[1]g),%[3]g)+gt(abs(Y-%[2]g),%[3]g),lum(X,Y),"+
		"st(0,clip((T-%[4]g)/%[5]g,0,1));st(1,hypot(X-%[1]g,Y-%[2]g)-%[6]g-%[7]g*(1-pow(1-ld(0),2)));"+
		"st(2,0.95*(1-ld(0))*exp(-pow(ld(1)/%[8]g,2)));st(3,0.65*(1-ld(0))*exp(-pow((ld(1)-%[9]g)/%[8]g,2)));"+
		"(lum(X,Y)+(24-lum(X,Y))*ld(3))*(1-ld(2))+235*ld(2))",
		math.Round(x*10)/10, math.Round(y*10)/10, math.Round(reach), begin, duration, final*0.3, final*0.7, soft, gap)
	half := 0.5 / float64(fps)
	return fmt.Sprintf("geq=lum='%s':cb='cb(X,Y)':cr='cr(X,Y)':enable='between(t,%.3f,%.3f)'", luma, begin-half, begin+duration+half)
}

// focus is a zoom the recording asked for: a window of edited time, a factor and the view's centre in frame px.
type focus struct {
	start, end int64
	zoom, x, y float64
}

type focusKey struct {
	t          int64
	zoom, x, y float64
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
		whole := focusKey{0, 1, width / 2, height / 2}
		ease := min(focusEaseMS, (group[0].end-group[0].start)/3)
		keys := []focusKey{{group[0].start, 1, whole.x, whole.y}}
		for k, f := range group {
			// The view's centre keeps the zoomed view inside the frame.
			x := max(width/(2*f.zoom), min(f.x, width-width/(2*f.zoom)))
			y := max(height/(2*f.zoom), min(f.y, height-height/(2*f.zoom)))
			hold := f.end
			if k == len(group)-1 {
				hold -= ease
			}
			keys = append(keys, focusKey{f.start + ease, f.zoom, x, y}, focusKey{max(hold, f.start+ease), f.zoom, x, y})
		}
		keys = append(keys, focusKey{group[len(group)-1].end, 1, whole.x, whole.y})
		filters = append(filters, focusFilter(keys, width, height, fps))
	}
	return filters
}

// focusFilter plays keys, each a view the picture eases to from the previous one. perspective
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

var (
	freezeLine = regexp.MustCompile(`freeze_(start|end): ([0-9.]+)`)
	frameLine  = regexp.MustCompile(`pts_time:([0-9.]+)`)
)

func msOf(s string) int64 { f, _ := strconv.ParseFloat(s, 64); return int64(math.Round(f * 1000)) }

// parseFreezes reads freezedetect's log: the stretches in which the picture stood still. A freeze
// still running when the video ended has no end.
func parseFreezes(log string, total int64) []span {
	var frozen []span
	for _, m := range freezeLine.FindAllStringSubmatch(log, -1) {
		switch {
		case m[1] == "start":
			frozen = append(frozen, span{msOf(m[2]), total})
		case len(frozen) > 0:
			frozen[len(frozen)-1].end = msOf(m[2])
		}
	}
	return frozen
}

// parseActive reads showinfo's log of the frames mpdecimate kept and joins those that follow each
// other closely into the stretches in which the picture changed. A frame that stands alone, like a
// blinking caret's, is not a change; the journal covers the single-frame effects of real input.
func parseActive(log string) []span {
	var active []span
	var start, last, frames int64
	flush := func() {
		if frames >= 2 {
			active = append(active, span{start, last})
		}
	}
	for _, m := range frameLine.FindAllStringSubmatch(log, -1) {
		if t := msOf(m[1]); frames > 0 && t-last <= activeGapMS {
			frames++
			last = t
		} else {
			flush()
			start, last, frames = t, t, 1
		}
	}
	flush()
	return active
}
