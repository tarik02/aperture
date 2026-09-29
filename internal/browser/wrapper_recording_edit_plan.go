package browser

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"unicode/utf8"
)

// The effects a recording can render when it stops. Every time in the plan is
// milliseconds of the raw video, which the filters see as `t`; they run before the
// idle time map, and the captions run after it.
const (
	zoomDefault    = 1.6
	zoomMin        = 1.1
	zoomMax        = 4
	zoomEaseMs     = 600
	zoomLingerMs   = 800
	zoomMergeGapMs = 2000 // pauses up to this long between zoomed gestures share one zoom
	zoomMinEaseMs  = 150
	// A gesture needs no pan while it stays within this part of the zoomed view.
	zoomInnerFraction = 0.6

	rippleMs     = 600
	rippleRadius = 48 // in pixels of a 1280 wide frame

	idleMinMs  = 1500
	idleKeepMs = 300 // left at normal speed at each end of an idle stretch
	idleSpeed  = 8
	// idleMaxRegions bounds the terms in the select and setpts expressions.
	idleMaxRegions = 100
	// gesturePadMs widens gestures: the pointer shows 20 to 40 ms late and the page reacts up to 90 ms after a click.
	gesturePadMs = 100

	editMaxFilterBytes = 100_000 // one command line argument is at most 128 KiB
	editMaxFPS         = 60
)

// recordingEffects are a recording's defaults for gestures that do not say otherwise.
type recordingEffects struct {
	Idle   string // "cut", "speed" or "" for none
	Zoom   float64
	Ripple bool
}

func (fx recordingEffects) any() bool { return fx.Idle != "" || fx.Zoom > 0 || fx.Ripple }

// ParseRecordingZoom resolves a zoom argument as it is given: absent is def, true is
// the default level, false is 0 (off), and a number is a level.
func ParseRecordingZoom(zoom any, def float64) (float64, error) {
	switch zoom := zoom.(type) {
	case nil:
		return def, nil
	case bool:
		if zoom {
			return zoomDefault, nil
		}
		return 0, nil
	case float64:
		if zoom >= zoomMin && zoom <= zoomMax {
			return zoom, nil
		}
	}
	return 0, fmt.Errorf("zoom must be true, false, or a level from %g to %d", zoomMin, zoomMax)
}

// ValidateRecordingEffects checks the effect defaults a recording starts with.
func ValidateRecordingEffects(idle string, zoom any) error {
	if idle != "" && idle != "cut" && idle != "speed" {
		return errors.New(`idle must be "cut" or "speed"`)
	}
	_, err := ParseRecordingZoom(zoom, 0)
	return err
}

// editPlan is what to render: the ffmpeg filter chain and the captions script it burns in.
type editPlan struct {
	filter     string // empty when nothing needs rendering
	ass        []byte
	fps        int
	durationMS int64
	warnings   []string
}

type span struct{ start, end int64 }

type zoomPoint struct {
	t     int64
	x, y  float64
	level float64
}

// zoomedGesture is a pointer gesture the camera follows.
type zoomedGesture struct {
	start, finish int64
	points        []zoomPoint
}

type zoomKey struct {
	t    int64
	zoom float64
	x, y float64 // the centre of the view, in frame pixels
}

type zoomScene struct{ keys []zoomKey }

type ripple struct {
	t    int64
	x, y float64
}

type cue struct {
	start, end int64
	text       string
}

// piece is a stretch of the raw video that stays, played at speed; stretches between
// pieces are cut.
type piece struct {
	start, end int64
	speed      float64
}

// buildEditPlan plans the effects a recording's timeline asks for, given its
// defaults. It returns nil when nothing applies, and a plan without a filter when
// what applies could not be planned. It is pure.
func buildEditPlan(doc timelineDoc, fx recordingEffects, fps int) (*editPlan, error) {
	total := doc.DurationMS
	cues := captionCues(doc.Actions, total)
	gestures, skipped := zoomedGestures(doc.Gestures, fx)
	marks := ripples(doc.Gestures, fx)
	if len(cues) == 0 && len(gestures) == 0 && len(marks) == 0 && fx.Idle == "" {
		return nil, nil
	}
	if len(doc.Segments) == 0 || total <= 0 {
		return nil, errors.New("the recording has no frames")
	}
	width, height := doc.Segments[0].Width, doc.Segments[0].Height
	for _, segment := range doc.Segments {
		if segment.Width != width || segment.Height != height {
			return nil, errors.New("the recording's frames change size (its target was resized or replaced by a differently sized one), which effects cannot follow")
		}
	}
	p := &editPlan{fps: min(fps, editMaxFPS), durationMS: total}
	if skipped > 0 {
		p.warnings = append(p.warnings, fmt.Sprintf("%d zoomed gestures went through Playwright's mouse, which has no position in the video, and were not followed", skipped))
	}

	scenes := zoomScenes(gestures, float64(width), float64(height))
	var busy []span
	for _, gesture := range doc.Gestures {
		busy = append(busy, span{gesture.Start - gesturePadMs, gesture.End + gesture.Hold + gesturePadMs})
	}
	for _, c := range cues {
		busy = append(busy, span{c.start, c.end})
	}
	for _, m := range marks {
		busy = append(busy, span{m.t, m.t + rippleMs})
	}
	for _, scene := range scenes {
		busy = append(busy, span{scene.keys[0].t, scene.keys[len(scene.keys)-1].t})
	}
	activity, complete := activitySpans(doc)
	for _, a := range activity {
		busy = append(busy, span{a.start - timelineSpanGap.Milliseconds()/2, a.end + timelineSpanGap.Milliseconds()/2})
	}
	pieces := []piece{{0, total, 1}}
	var remap []string
	switch {
	case fx.Idle == "":
	case !complete || len(activity) >= timelineMaxSpans || len(doc.Gestures) >= timelineMaxGestures:
		p.warnings = append(p.warnings, "idle was left as it is: the screen could not be watched all the time, or the timeline had room for only some of the screen changes or gestures, so no stretch is known to be idle")
	default:
		var regions []span
		if pieces, regions = idlePieces(fx.Idle, busy, total); len(regions) == 0 {
			p.warnings = append(p.warnings, "idle was left as it is: no stretch of 1.5 s or more without changes or gestures")
		} else {
			remap = remapFilters(pieces, p.fps)
		}
	}

	chain := []string{"setpts=PTS-STARTPTS", fmt.Sprintf("fps=fps=%d:start_time=0", p.fps), "format=yuv420p"}
	for _, m := range marks {
		chain = append(chain, m.filter(width, p.fps))
	}
	for _, scene := range scenes {
		chain = append(chain, scene.filter(float64(width), float64(height), p.fps))
	}
	chain = append(chain, remap...)
	chain = append(chain, "crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0") // libx264 needs even sizes
	if len(cues) > 0 {
		for i := range cues {
			cues[i].start, cues[i].end = mapTime(pieces, cues[i].start), mapTime(pieces, cues[i].end)
		}
		p.ass = marshalASS(cues, width, height)
		chain = append(chain, "ass=captions.ass")
	}
	if len(cues)+len(scenes)+len(marks)+len(remap) == 0 {
		return p, nil
	}
	if p.filter = strings.Join(chain, ","); len(p.filter) > editMaxFilterBytes {
		return nil, fmt.Errorf("the recording has too many effects to render (%d bytes of filters)", len(p.filter))
	}
	return p, nil
}

// activitySpans are the spans in which the page's content changed, and whether they
// are all of them: where the screen could not be sampled, quiet does not mean idle.
func activitySpans(doc timelineDoc) (spans []span, complete bool) {
	for _, a := range doc.Activity {
		spans = append(spans, span{a.Start, a.End})
	}
	return spans, len(doc.Unknown) == 0
}

// captionCues turns captioned actions into cues that stay long enough to read and
// never overlap.
func captionCues(actions []timelineAction, total int64) []cue {
	var cues []cue
	for _, action := range actions {
		text := strings.Join(strings.Fields(action.Caption), " ")
		if text == "" || action.Start >= total {
			continue
		}
		reading := min(max(1000+40*int64(utf8.RuneCountInString(text)), 1200), 5000)
		cues = append(cues, cue{action.Start, min(max(action.End, action.Start+reading), total), text})
	}
	slices.SortStableFunc(cues, func(a, b cue) int { return int(a.start - b.start) })
	for i := 0; i+1 < len(cues); i++ {
		cues[i].end = min(cues[i].end, cues[i+1].start)
	}
	return slices.DeleteFunc(cues, func(c cue) bool { return c.end <= c.start })
}

// zoomedGestures lists the gestures that zoom, with where the camera looks: at the
// press of a click or drag, the end of a drag or move, and where a scroll wheels.
// skipped counts zoomed gestures that have no position.
func zoomedGestures(gestures []timelineGesture, fx recordingEffects) (out []zoomedGesture, skipped int) {
	for _, gesture := range gestures {
		level, _ := ParseRecordingZoom(gesture.Zoom, fx.Zoom)
		if level == 0 {
			continue
		}
		var points []zoomPoint
		at := func(t int64, x, y float64) { points = append(points, zoomPoint{t, x, y, level}) }
		last := len(gesture.Path) - 1
		switch gesture.Tool {
		case "browser_click":
			for _, click := range gesture.Clicks {
				at(click.T, click.X, click.Y)
			}
		case "browser_drag":
			if last >= 0 && len(gesture.Clicks) > 0 {
				at(gesture.Clicks[0].T, gesture.Clicks[0].X, gesture.Clicks[0].Y)
				at(int64(gesture.Path[last][0]), gesture.Path[last][1], gesture.Path[last][2])
			}
		case "browser_move":
			if last >= 0 {
				at(int64(gesture.Path[last][0]), gesture.Path[last][1], gesture.Path[last][2])
			}
		case "browser_scroll":
			if gesture.Scroll != nil {
				at(gesture.Start, gesture.Scroll.X, gesture.Scroll.Y)
			}
		}
		if len(points) == 0 {
			skipped++
			continue
		}
		out = append(out, zoomedGesture{gesture.Start, gesture.End + gesture.Hold, points})
	}
	slices.SortStableFunc(out, func(a, b zoomedGesture) int { return int(a.start - b.start) })
	return out, skipped
}

func ripples(gestures []timelineGesture, fx recordingEffects) []ripple {
	var out []ripple
	for _, gesture := range gestures {
		if gesture.Tool != "browser_click" || (gesture.Ripple == nil && !fx.Ripple) || (gesture.Ripple != nil && !*gesture.Ripple) {
			continue
		}
		for _, click := range gesture.Clicks {
			out = append(out, ripple{click.T, click.X, click.Y})
		}
	}
	slices.SortStableFunc(out, func(a, b ripple) int { return int(a.t - b.t) })
	return out
}

// zoomScenes groups gestures separated by short pauses into scenes: zoom in as the
// pointer arrives, pan when it leaves the middle of the view, linger, zoom out.
func zoomScenes(gestures []zoomedGesture, width, height float64) []zoomScene {
	var scenes []zoomScene
	var previousEnd int64
	for i := 0; i < len(gestures); {
		group, finish := []zoomedGesture{gestures[i]}, gestures[i].finish
		for i++; i < len(gestures) && gestures[i].start-finish <= zoomMergeGapMs; i++ {
			group, finish = append(group, gestures[i]), max(finish, gestures[i].finish)
		}
		var points []zoomPoint
		for _, gesture := range group {
			points = append(points, gesture.points...)
		}
		slices.SortStableFunc(points, func(a, b zoomPoint) int { return int(a.t - b.t) })
		centre := func(pt zoomPoint) (float64, float64) {
			w, h := width/pt.level, height/pt.level
			return clampView(pt.x, w/2, width-w/2), clampView(pt.y, h/2, height-h/2)
		}
		// Zooming in starts an ease before the pointer arrives, as far as the video's
		// start and the previous scene allow.
		arrive := points[0].t
		begin := max(arrive-zoomEaseMs, previousEnd, 0)
		arrive = max(arrive, begin+zoomMinEaseMs)
		x, y := centre(points[0])
		level := points[0].level
		keys := []zoomKey{{begin, 1, width / 2, height / 2}, {arrive, level, x, y}}
		for _, pt := range points[1:] {
			if math.Abs(pt.x-x) <= zoomInnerFraction*width/level/2 && math.Abs(pt.y-y) <= zoomInnerFraction*height/level/2 && math.Abs(pt.level-level) < 0.05 {
				continue
			}
			// Hold until an ease before the pointer gets there, then pan.
			depart := max(keys[len(keys)-1].t, pt.t-zoomEaseMs)
			keys = append(keys, zoomKey{depart, level, x, y})
			x, y = centre(pt)
			level = pt.level
			keys = append(keys, zoomKey{max(pt.t, depart+zoomMinEaseMs), level, x, y})
		}
		hold := max(finish+zoomLingerMs, keys[len(keys)-1].t)
		keys = append(keys, zoomKey{hold, level, x, y}, zoomKey{hold + zoomEaseMs, 1, width / 2, height / 2})
		previousEnd = keys[len(keys)-1].t
		scenes = append(scenes, zoomScene{keys})
	}
	return scenes
}

func clampView(v, low, high float64) float64 {
	if high < low {
		return (low + high) / 2
	}
	return max(low, min(v, high))
}

// filter is the perspective filter that plays this scene. The view is the source
// rectangle that perspective stretches to the whole frame, so the picture keeps its
// size; each edge is its first value plus one eased step per change of key, and
// since an edge moves between positions inside the frame it never leaves it.
func (s zoomScene) filter(width, height float64, fps int) string {
	frames := make([]int64, len(s.keys)) // whole frames apart, however close the times are
	for i, key := range s.keys {
		frames[i] = int64(math.Round(float64(key.t) * float64(fps) / 1000))
		if i > 0 {
			frames[i] = max(frames[i], frames[i-1]+1)
		}
	}
	edge := func(value func(zoomKey) float64) string {
		expr := formatNumber(value(s.keys[0]))
		for i := 0; i+1 < len(s.keys); i++ {
			delta := value(s.keys[i+1]) - value(s.keys[i])
			if math.Abs(delta) < 5e-4 {
				continue
			}
			sign := "+"
			if delta < 0 {
				sign, delta = "-", -delta
			}
			// perspective counts input frames from one.
			expr += fmt.Sprintf("%s%s*(1-cos(PI*clip((in-%d)/%d,0,1)))/2", sign, formatNumber(delta), frames[i]+1, frames[i+1]-frames[i])
		}
		return expr
	}
	left := edge(func(k zoomKey) float64 { return k.x - width/(2*k.zoom) })
	right := edge(func(k zoomKey) float64 { return k.x + width/(2*k.zoom) })
	top := edge(func(k zoomKey) float64 { return k.y - height/(2*k.zoom) })
	bottom := edge(func(k zoomKey) float64 { return k.y + height/(2*k.zoom) })
	// The window opens and closes between two frames.
	enable := fmt.Sprintf("between(t,%.4f,%.4f)", (float64(frames[0])-0.5)/float64(fps), (float64(frames[len(frames)-1])+0.5)/float64(fps))
	return fmt.Sprintf("perspective=x0='%s':y0='%s':x1='%s':y1='%s':x2='%s':y2='%s':x3='%s':y3='%s':interpolation=cubic:eval=frame:enable='%s'",
		left, top, right, top, left, bottom, right, bottom, enable)
}

func formatNumber(v float64) string {
	return strings.TrimSuffix(strings.TrimRight(fmt.Sprintf("%.3f", v), "0"), ".")
}

// filter draws a ripple: a white ring that spreads from the click and fades, with a
// dark halo outside it so it shows on light and dark pages alike. It changes luma
// only, which keeps the filter short and cheap; geq passes every pixel out of the
// ring's reach through, and the filter is enabled only while the ripple shows.
func (r ripple) filter(width, fps int) string {
	scale := float64(width) / 1280
	final := rippleRadius * scale
	start := final * 0.3
	softness := 3.5 * scale
	gap := 2.6 * scale // the halo sits just outside the ring
	reach := final + gap + 3*softness
	begin := float64(r.t) / 1000
	duration := float64(rippleMs) / 1000
	dx, dy := fmt.Sprintf("X-%.1f", r.x), fmt.Sprintf("Y-%.1f", r.y)
	// Y values are limited range: white is 235 and the halo's dark 24.
	luma := fmt.Sprintf("lum='if(gt(abs(%s),%.0f)+gt(abs(%s),%.0f),lum(X,Y),"+
		"st(0,clip((T-%.3f)/%.1f,0,1));st(1,hypot(%s,%s)-%.1f-%.1f*(1-pow(1-ld(0),2)));"+
		"st(2,0.95*(1-ld(0))*exp(-pow(ld(1)/%.1f,2)));st(3,0.65*(1-ld(0))*exp(-pow((ld(1)-%.1f)/%.1f,2)));"+
		"(lum(X,Y)+(24-lum(X,Y))*ld(3))*(1-ld(2))+235*ld(2))'",
		dx, reach, dy, reach, begin, duration, dx, dy, start, final-start, softness, gap, softness)
	return fmt.Sprintf("geq=%s:cb='cb(X,Y)':cr='cr(X,Y)':enable='between(t,%.3f,%.3f)'",
		luma, begin-0.5/float64(fps), begin+duration+0.5/float64(fps))
}

// idlePieces cuts or speeds up the stretches of at least idleMinMs that nothing busy
// touches, and returns the pieces that remain and the stretches it shortened.
func idlePieces(mode string, busy []span, total int64) (pieces []piece, regions []span) {
	slices.SortFunc(busy, func(a, b span) int { return int(a.start - b.start) })
	var merged []span
	for _, b := range busy {
		b.start, b.end = max(b.start, 0), min(b.end, total)
		if b.end < b.start {
			continue
		}
		if n := len(merged); n > 0 && b.start <= merged[n-1].end {
			merged[n-1].end = max(merged[n-1].end, b.end)
		} else {
			merged = append(merged, b)
		}
	}
	if len(merged) == 0 {
		return []piece{{0, total, 1}}, nil
	}
	if head := merged[0].start; head >= idleMinMs+idleKeepMs {
		regions = append(regions, span{0, head - idleKeepMs})
	}
	for i := 1; i < len(merged); i++ {
		if merged[i].start-merged[i-1].end >= idleMinMs+2*idleKeepMs {
			regions = append(regions, span{merged[i-1].end + idleKeepMs, merged[i].start - idleKeepMs})
		}
	}
	if tail := merged[len(merged)-1].end; total-tail >= idleMinMs+idleKeepMs {
		regions = append(regions, span{tail + idleKeepMs, total})
	}
	if len(regions) > idleMaxRegions { // keep the longest
		longest := slices.Clone(regions)
		slices.SortFunc(longest, func(a, b span) int { return int((b.end - b.start) - (a.end - a.start)) })
		longest = longest[:idleMaxRegions]
		regions = slices.DeleteFunc(regions, func(r span) bool { return !slices.Contains(longest, r) })
	}
	var cursor int64
	for _, region := range regions {
		if region.start > cursor {
			pieces = append(pieces, piece{cursor, region.start, 1})
		}
		if mode == "speed" {
			pieces = append(pieces, piece{region.start, region.end, idleSpeed})
		}
		cursor = region.end
	}
	if cursor < total {
		pieces = append(pieces, piece{cursor, total, 1})
	}
	return pieces, regions
}

// remapFilters keep the frames inside the pieces and give them the times they have
// in the edited video: each piece adds its own length, over its speed, once passed.
func remapFilters(pieces []piece, fps int) []string {
	half := 500 / float64(fps) // boundaries sit between two frames, out of reach of rounding
	var selects, times []string
	for _, p := range pieces {
		selects = append(selects, fmt.Sprintf("gte(t,%.4f)*lt(t,%.4f)", float64(p.start)/1000-half/1000, float64(p.end)/1000-half/1000))
		term := fmt.Sprintf("(min(max(T,%.3f),%.3f)-%.3f)", float64(p.start)/1000, float64(p.end)/1000, float64(p.start)/1000)
		if p.speed != 1 {
			term += fmt.Sprintf("/%g", p.speed)
		}
		times = append(times, term)
	}
	return []string{
		"select='" + strings.Join(selects, "+") + "'",
		"setpts='(" + strings.Join(times, "+") + ")/TB'",
		fmt.Sprintf("fps=fps=%d", fps),
	}
}

// mapTime is where a raw video time falls in the edited video; a time in a cut
// stretch falls where the stretch was removed.
func mapTime(pieces []piece, t int64) int64 {
	var out float64
	for _, p := range pieces {
		if t <= p.start {
			break
		}
		out += float64(min(t, p.end)-p.start) / p.speed
	}
	return int64(math.Round(out))
}

// marshalASS writes the cues as an ASS script for the ass filter: white text on a
// mostly opaque dark box near the bottom edge, sized to the frame.
func marshalASS(cues []cue, width, height int) []byte {
	size := max(int(float64(height)*0.045+0.5), 12)
	marginV, marginH := int(float64(height)*0.06+0.5), int(float64(width)*0.06+0.5)
	padding := max(int(float64(height)*0.008+0.5), 2)
	var out strings.Builder
	fmt.Fprintf(&out, "[Script Info]\nScriptType: v4.00+\nPlayResX: %d\nPlayResY: %d\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n", width, height)
	out.WriteString("[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n")
	// BorderStyle 3 draws the outline colour as a box behind the text.
	fmt.Fprintf(&out, "Style: Default,Noto Sans,%d,&H00FFFFFF,&H00FFFFFF,&H30000000,&H30000000,0,0,0,0,100,100,0,0,3,%d,0,2,%d,%d,%d,1\n\n", size, padding, marginH, marginH, marginV)
	out.WriteString("[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
	// A backslash would start an override tag and has no escape, so it becomes the fullwidth one.
	escape := strings.NewReplacer(`\`, "＼", "{", `\{`, "}", `\}`)
	stamp := func(ms int64) string {
		return fmt.Sprintf("%d:%02d:%02d.%02d", ms/3600000, ms/60000%60, ms/1000%60, ms%1000/10)
	}
	for _, c := range cues {
		fmt.Fprintf(&out, "Dialogue: 0,%s,%s,Default,,0,0,0,,%s\n", stamp(c.start), stamp(c.end), escape.Replace(c.text))
	}
	return []byte(out.String())
}
