package edit

import (
	"fmt"
	"math"
	"slices"
	"strings"

	"github.com/aperture/aperture/internal/recording/timeline"
)

const (
	// minEaseMs is the shortest a zoom or pan takes, used where the video's start
	// or a nearby gesture leaves less room than zoomEaseMs.
	minEaseMs = 150
	// innerViewFraction is the part of the zoomed view, around its centre, in which
	// a gesture needs no pan.
	innerViewFraction = 0.6
	// maxZoomScenes bounds the scenes of one video.
	maxZoomScenes = 120
)

// zoomEvent is a place the camera looks at, at a video time, at a magnification.
type zoomEvent struct {
	tMs   int64
	x, y  float64
	level float64
}

// zoomGesture is a gesture the zoom follows: where it looks and until when the
// gesture is still on.
type zoomGesture struct {
	startMs, finishMs int64
	events            []zoomEvent
}

// zoomKey is one keyframe of the virtual camera: at Frame it sees the view of
// magnification Z centred on (X, Y), in pixels of the source frame.
type zoomKey struct {
	Frame int64
	Z     float64
	X, Y  float64
}

// zoomScene is one zoom in and out, and the frames it changes the picture in.
type zoomScene struct {
	// StartMs and EndMs are the raw video times the scene changes the picture in.
	StartMs, EndMs int64
	Keys           []zoomKey
	Gestures       int
}

// segmentScale maps the coordinates of a timeline segment to the source frame.
type segmentScale struct{ x, y float64 }

func scaleFor(scales []segmentScale, segment int) segmentScale {
	if segment >= 0 && segment < len(scales) {
		return scales[segment]
	}
	return segmentScale{1, 1}
}

// zoomGestures picks the zoomed gestures, with the places the camera looks at in
// the source frame. Where the camera arrives is when the pointer does: at the
// press of a click or drag, at the end of a move, and as the wheel of a scroll
// starts. It returns how many zoomed gestures were left out for having no place:
// input sent through the debugging protocol has none.
func zoomGestures(tl *timeline.Timeline, scales []segmentScale) ([]zoomGesture, int) {
	var out []zoomGesture
	skipped := 0
	for _, gesture := range tl.Gestures {
		if gesture.Zoom <= 0 {
			continue
		}
		scale := scaleFor(scales, gesture.Segment)
		level := gesture.Zoom
		at := func(t int64, x, y float64) zoomEvent {
			return zoomEvent{tMs: t, x: x * scale.x, y: y * scale.y, level: level}
		}
		var events []zoomEvent
		switch gesture.Kind {
		case "click":
			for _, click := range gesture.Clicks {
				events = append(events, at(click.TMs, click.X, click.Y))
			}
		case "drag":
			if len(gesture.Path) > 0 {
				first, last := gesture.Path[0], gesture.Path[len(gesture.Path)-1]
				if len(gesture.Clicks) > 0 {
					first = timeline.PathPoint{TMs: gesture.Clicks[0].TMs, X: gesture.Clicks[0].X, Y: gesture.Clicks[0].Y}
				}
				events = append(events, at(first.TMs, first.X, first.Y), at(last.TMs, last.X, last.Y))
			}
		case "move":
			if len(gesture.Path) > 0 {
				last := gesture.Path[len(gesture.Path)-1]
				events = append(events, at(last.TMs, last.X, last.Y))
			}
		case "scroll":
			if gesture.Scroll != nil && gesture.Scroll.At != nil {
				events = append(events, at(gesture.StartMs, gesture.Scroll.At.X, gesture.Scroll.At.Y))
			}
		}
		if len(events) == 0 {
			skipped++
			continue
		}
		out = append(out, zoomGesture{startMs: gesture.StartMs, finishMs: gesture.EndMs + gesture.HoldMs, events: events})
	}
	slices.SortStableFunc(out, func(a, b zoomGesture) int { return int(a.startMs - b.startMs) })
	return out, skipped
}

// planZoomScenes groups the gestures into scenes and lays out each scene's camera
// keyframes for a frame of width x height at fps. Gestures whose pause is at most
// zoomMergeGapMs share a scene.
func planZoomScenes(gestures []zoomGesture, width, height float64, fps int) []zoomScene {
	var groups [][]zoomGesture
	for _, gesture := range gestures {
		if last := len(groups) - 1; last >= 0 && gesture.startMs-groupFinish(groups[last]) <= zoomMergeGapMs {
			groups[last] = append(groups[last], gesture)
			continue
		}
		groups = append(groups, []zoomGesture{gesture})
	}
	scenes := make([]zoomScene, 0, len(groups))
	var previousEnd int64
	for _, group := range groups {
		scene := buildScene(group, previousEnd, width, height, fps)
		previousEnd = scene.EndMs
		scenes = append(scenes, scene)
	}
	return scenes
}

func groupFinish(group []zoomGesture) int64 {
	var finish int64
	for _, gesture := range group {
		finish = max(finish, gesture.finishMs)
	}
	return finish
}

// buildScene lays out one scene's keyframes: zoom in so the camera arrives as the
// first place is reached, pan when a later place leaves the middle of the view or
// asks for another magnification, stay a while after the last gesture, and zoom
// out.
func buildScene(group []zoomGesture, previousEnd int64, width, height float64, fps int) zoomScene {
	var events []zoomEvent
	for _, gesture := range group {
		events = append(events, gesture.events...)
	}
	slices.SortStableFunc(events, func(a, b zoomEvent) int { return int(a.tMs - b.tMs) })

	centre := func(e zoomEvent) (float64, float64) {
		viewW, viewH := width/e.level, height/e.level
		return clampFloat(e.x, viewW/2, width-viewW/2), clampFloat(e.y, viewH/2, height-viewH/2)
	}
	type msKey struct {
		t    int64
		z    float64
		x, y float64
	}
	// Zooming in starts one ease before the first place is reached, as far as the
	// video's start and the previous scene allow, and never takes less than minEaseMs.
	arrive := events[0].tMs
	begin := max(arrive-zoomEaseMs, previousEnd, 0)
	if arrive-begin < minEaseMs {
		arrive = begin + minEaseMs
	}
	level := events[0].level
	cx, cy := centre(events[0])
	keys := []msKey{{begin, 1, width / 2, height / 2}, {arrive, level, cx, cy}}
	for _, event := range events[1:] {
		viewW, viewH := width/level, height/level
		inside := math.Abs(event.x-cx) <= innerViewFraction*viewW/2 && math.Abs(event.y-cy) <= innerViewFraction*viewH/2
		if inside && math.Abs(event.level-level) < 0.05 {
			continue
		}
		x, y := centre(event)
		// Hold where the camera is until an ease before the place is reached, then pan to it.
		last := keys[len(keys)-1].t
		depart := max(last, event.tMs-zoomEaseMs)
		if depart > last {
			keys = append(keys, msKey{depart, level, cx, cy})
		}
		keys = append(keys, msKey{max(event.tMs, depart+minEaseMs), event.level, x, y})
		level, cx, cy = event.level, x, y
	}
	holdEnd := max(groupFinish(group)+zoomLingerMs, keys[len(keys)-1].t)
	if holdEnd > keys[len(keys)-1].t {
		keys = append(keys, msKey{holdEnd, level, cx, cy})
	}
	keys = append(keys, msKey{holdEnd + zoomEaseMs, 1, width / 2, height / 2})

	scene := zoomScene{Gestures: len(group), StartMs: keys[0].t, EndMs: keys[len(keys)-1].t}
	for index, key := range keys {
		frame := int64(math.Round(float64(key.t) * float64(fps) / 1000))
		// Keyframes are whole frames apart, however close their times are.
		if index > 0 && frame <= scene.Keys[index-1].Frame {
			frame = scene.Keys[index-1].Frame + 1
		}
		scene.Keys = append(scene.Keys, zoomKey{Frame: frame, Z: key.z, X: key.x, Y: key.y})
	}
	// Snapping the keys forward can push the end past the time it was planned for.
	scene.EndMs = max(scene.EndMs, int64(math.Round(float64(scene.Keys[len(scene.Keys)-1].Frame)*1000/float64(fps))))
	return scene
}

func clampFloat(value, low, high float64) float64 {
	if high < low {
		return (low + high) / 2
	}
	return max(low, min(value, high))
}

// filter returns the perspective filter that zooms this scene. The view is the
// source rectangle that perspective maps to the whole frame, so the picture keeps
// its size and no scaling or cropping is involved; positions are sub-pixel and
// interpolated cubically, so slow zooms do not shimmer. Each edge of the view is
// its value at the first key plus one eased step per change of key, so the
// expressions hold no branches, and since an edge moves between two positions
// inside the frame it never leaves the frame.
func (s zoomScene) filter(width, height float64, fps int) string {
	// perspective counts its input frames from one, so frame n is in = n+1.
	edge := func(value func(zoomKey) float64) string {
		var expr strings.Builder
		expr.WriteString(formatNumber(value(s.Keys[0])))
		for index := 0; index+1 < len(s.Keys); index++ {
			from, to := s.Keys[index], s.Keys[index+1]
			delta := value(to) - value(from)
			if math.Abs(delta) < 5e-4 {
				continue
			}
			sign := "+"
			if delta < 0 {
				sign, delta = "-", -delta
			}
			fmt.Fprintf(&expr, "%s%s*(1-cos(PI*clip((in-%d)/%d,0,1)))/2", sign, formatNumber(delta), from.Frame+1, to.Frame-from.Frame)
		}
		return expr.String()
	}
	left := edge(func(k zoomKey) float64 { return k.X - width/(2*k.Z) })
	right := edge(func(k zoomKey) float64 { return k.X + width/(2*k.Z) })
	top := edge(func(k zoomKey) float64 { return k.Y - height/(2*k.Z) })
	bottom := edge(func(k zoomKey) float64 { return k.Y + height/(2*k.Z) })
	// The window opens and closes between two frames.
	first, last := s.Keys[0].Frame, s.Keys[len(s.Keys)-1].Frame
	enable := fmt.Sprintf("between(t,%.4f,%.4f)", (float64(first)-0.5)/float64(fps), (float64(last)+0.5)/float64(fps))
	// The corners are the top left, top right, bottom left and bottom right of the view.
	return "perspective=" + strings.Join([]string{
		"x0='" + left + "'",
		"y0='" + top + "'",
		"x1='" + right + "'",
		"y1='" + top + "'",
		"x2='" + left + "'",
		"y2='" + bottom + "'",
		"x3='" + right + "'",
		"y3='" + bottom + "'",
		"interpolation=cubic",
		"eval=frame",
		"enable='" + enable + "'",
	}, ":")
}

// formatNumber prints a number for an ffmpeg expression without trailing zeros.
func formatNumber(value float64) string {
	text := fmt.Sprintf("%.3f", value)
	text = strings.TrimRight(text, "0")
	return strings.TrimSuffix(text, ".")
}
