package edit

import (
	"fmt"
	"strings"
	"testing"

	"github.com/aperture/aperture/internal/recording/timeline"
)

const (
	testWidth  = 1280.0
	testHeight = 720.0
)

func clickGesture(id uint64, startMs int64, x, y float64, zoom float64) timeline.Gesture {
	return timeline.Gesture{
		ID: id, Kind: "click", Mode: "compositor", StartMs: startMs, EndMs: startMs + 400, Zoom: zoom,
		Path:   []timeline.PathPoint{{TMs: startMs, X: x - 50, Y: y - 50}, {TMs: startMs + 300, X: x, Y: y}},
		Clicks: []timeline.Click{{TMs: startMs + 340, X: x, Y: y, Button: "left", Count: 1}},
	}
}

func zoomTimeline(gestures ...timeline.Gesture) *timeline.Timeline {
	return &timeline.Timeline{Segments: []timeline.Segment{{Width: 1280, Height: 720}}, Gestures: gestures}
}

func TestZoomGesturesPickZoomedGesturesWithAPlace(t *testing.T) {
	tl := zoomTimeline(
		clickGesture(1, 2000, 400, 300, 1.6),
		clickGesture(2, 4000, 500, 300, 0),
		timeline.Gesture{ID: 3, Kind: "click", Mode: "cdp", StartMs: 6000, EndMs: 6100, Zoom: 2},
		timeline.Gesture{ID: 4, Kind: "scroll", Mode: "cdp", StartMs: 8000, EndMs: 8050, Zoom: 2, Scroll: &timeline.Scroll{DY: 400, At: &timeline.Point{X: 900, Y: 500}}},
		timeline.Gesture{ID: 5, Kind: "scroll", Mode: "cdp", StartMs: 9000, EndMs: 9050, Zoom: 2, Scroll: &timeline.Scroll{DY: 400}},
		timeline.Gesture{
			ID: 6, Kind: "drag", Mode: "compositor", StartMs: 10000, EndMs: 11000, HoldMs: 500, Zoom: 1.5,
			Path:   []timeline.PathPoint{{TMs: 10000, X: 10, Y: 10}, {TMs: 10400, X: 300, Y: 200}, {TMs: 10900, X: 700, Y: 400}},
			Clicks: []timeline.Click{{TMs: 10450, X: 300, Y: 200, Button: "left", Count: 1}},
		},
		timeline.Gesture{
			ID: 7, Kind: "move", Mode: "compositor", StartMs: 12000, EndMs: 12300, Zoom: 2,
			Path: []timeline.PathPoint{{TMs: 12000, X: 0, Y: 0}, {TMs: 12240, X: 640, Y: 360}},
		},
	)
	gestures, skipped := zoomGestures(tl, []segmentScale{{1, 1}})
	// The unzoomed click is not followed; the Playwright click and the scroll
	// without a position have no place to look at.
	if skipped != 2 {
		t.Errorf("skipped %d, want 2", skipped)
	}
	if len(gestures) != 4 {
		t.Fatalf("%d gestures: %+v", len(gestures), gestures)
	}
	click := gestures[0]
	if len(click.events) != 1 || click.events[0].tMs != 2340 || click.events[0].x != 400 || click.events[0].level != 1.6 {
		t.Errorf("a click's camera arrives at the press: %+v", click)
	}
	scroll := gestures[1]
	if scroll.events[0].tMs != 8000 || scroll.events[0].x != 900 {
		t.Errorf("a scroll looks where the wheel turns, as it starts: %+v", scroll)
	}
	drag := gestures[2]
	if len(drag.events) != 2 || drag.events[0].tMs != 10450 || drag.events[0].x != 300 || drag.events[1].tMs != 10900 || drag.events[1].x != 700 || drag.finishMs != 11500 {
		t.Errorf("a drag looks at the press, then at the release: %+v", drag)
	}
	move := gestures[3]
	if len(move.events) != 1 || move.events[0].tMs != 12240 || move.events[0].x != 640 {
		t.Errorf("a move looks where it ends: %+v", move)
	}
}

func TestZoomGesturesScaleToTheSourceFrame(t *testing.T) {
	tl := zoomTimeline(clickGesture(1, 2000, 400, 300, 2))
	gestures, _ := zoomGestures(tl, []segmentScale{{2, 2}})
	if got := gestures[0].events[0]; got.x != 800 || got.y != 600 {
		t.Errorf("event %+v", got)
	}
}

func oneGesture(startMs, finishMs int64, level, x, y float64) zoomGesture {
	return zoomGesture{startMs: startMs, finishMs: finishMs, events: []zoomEvent{{tMs: startMs, x: x, y: y, level: level}}}
}

func TestPlanZoomScenesMergesGesturesCloserThanTheGap(t *testing.T) {
	scenes := planZoomScenes([]zoomGesture{
		oneGesture(5000, 5400, 1.6, 400, 300),
		oneGesture(6500, 6900, 1.6, 420, 310),   // 1.1 s after the first finished: shares its scene
		oneGesture(8800, 9200, 1.6, 900, 500),   // 1.9 s later: still shares it
		oneGesture(15000, 15400, 1.6, 500, 300), // far later: a scene of its own
	}, testWidth, testHeight, 30)
	if len(scenes) != 2 {
		t.Fatalf("%d scenes", len(scenes))
	}
	if scenes[0].Gestures != 3 || scenes[1].Gestures != 1 {
		t.Errorf("scenes hold %d and %d gestures", scenes[0].Gestures, scenes[1].Gestures)
	}
	if scenes[0].EndMs > scenes[1].StartMs {
		t.Errorf("scenes overlap: %d..%d and %d..%d", scenes[0].StartMs, scenes[0].EndMs, scenes[1].StartMs, scenes[1].EndMs)
	}
}

func TestZoomSceneKeysAreOrderedAndFramed(t *testing.T) {
	scenes := planZoomScenes([]zoomGesture{
		oneGesture(5000, 5400, 2, 400, 300),
		oneGesture(6800, 7200, 2, 1100, 650),
	}, testWidth, testHeight, 30)
	if len(scenes) != 1 {
		t.Fatalf("%d scenes", len(scenes))
	}
	keys := scenes[0].Keys
	first, last := keys[0], keys[len(keys)-1]
	if first.Z != 1 || last.Z != 1 || first.X != testWidth/2 || last.Y != testHeight/2 {
		t.Errorf("the scene starts and ends on the whole frame: %+v ... %+v", first, last)
	}
	for index := 1; index < len(keys); index++ {
		if keys[index].Frame <= keys[index-1].Frame {
			t.Errorf("key frames must increase: %+v", keys)
		}
	}
	for _, key := range keys {
		halfW, halfH := testWidth/(2*key.Z), testHeight/(2*key.Z)
		if key.X-halfW < -0.001 || key.X+halfW > testWidth+0.001 || key.Y-halfH < -0.001 || key.Y+halfH > testHeight+0.001 {
			t.Errorf("key %+v shows outside the frame", key)
		}
	}
	// The second place is outside the first view, so the camera pans to it.
	var pans bool
	for _, key := range keys {
		if key.Z == 2 && key.X > 900 {
			pans = true
		}
	}
	if !pans {
		t.Errorf("no pan toward the second place: %+v", keys)
	}
	// The first place is looked at by the time it is reached.
	arrive := keys[1]
	if arrive.Z != 2 || arrive.X != 400 || arrive.Y != 300 || arrive.Frame != 150 {
		t.Errorf("arrival key %+v, want zoom 2 on (400,300) at frame 150", arrive)
	}
}

func TestZoomSceneClampsTheCameraAtFrameEdges(t *testing.T) {
	for _, test := range []struct {
		x, y         float64
		wantX, wantY float64
	}{
		{10, 10, 320, 180},
		{1275, 715, 960, 540},
		{640, 360, 640, 360},
		{0, 720, 320, 540},
	} {
		scenes := planZoomScenes([]zoomGesture{oneGesture(5000, 5400, 2, test.x, test.y)}, testWidth, testHeight, 30)
		arrive := scenes[0].Keys[1]
		if arrive.X != test.wantX || arrive.Y != test.wantY {
			t.Errorf("a place at (%g,%g) gives a camera at (%g,%g), want (%g,%g)", test.x, test.y, arrive.X, arrive.Y, test.wantX, test.wantY)
		}
	}
}

func TestZoomSceneAtTheStartOfTheVideoNeverBeginsBeforeIt(t *testing.T) {
	scenes := planZoomScenes([]zoomGesture{oneGesture(100, 500, 1.6, 400, 300)}, testWidth, testHeight, 30)
	keys := scenes[0].Keys
	if keys[0].Frame != 0 {
		t.Errorf("first key at frame %d", keys[0].Frame)
	}
	if keys[1].Frame <= keys[0].Frame {
		t.Errorf("zooming in takes at least a few frames: %+v", keys[:2])
	}
}

func TestZoomSceneFollowsALevelChangeWithoutAPan(t *testing.T) {
	scenes := planZoomScenes([]zoomGesture{
		oneGesture(5000, 5400, 1.6, 640, 360),
		oneGesture(6500, 6900, 3, 645, 362),
	}, testWidth, testHeight, 30)
	var levels []float64
	for _, key := range scenes[0].Keys {
		if len(levels) == 0 || levels[len(levels)-1] != key.Z {
			levels = append(levels, key.Z)
		}
	}
	if len(levels) < 4 || levels[1] != 1.6 || levels[2] != 3 {
		t.Errorf("levels %v: expected 1, 1.6, 3, 1", levels)
	}
}

func TestZoomSceneFilterIsAGatedPerspectiveOverItsFrames(t *testing.T) {
	scenes := planZoomScenes([]zoomGesture{oneGesture(5000, 5400, 2, 400, 300)}, testWidth, testHeight, 30)
	filter := scenes[0].filter(testWidth, testHeight, 30)
	for _, part := range []string{"perspective=", "eval=frame", "interpolation=cubic", "enable='between(t,", "x0='", "y3='", "cos(PI*clip((in-"} {
		if !strings.Contains(filter, part) {
			t.Errorf("filter lacks %q: %s", part, filter)
		}
	}
	// The window opens half a frame before the first key frame.
	keys := scenes[0].Keys
	if want := fmt.Sprintf("between(t,%.4f,", (float64(keys[0].Frame)-0.5)/30); !strings.Contains(filter, want) {
		t.Errorf("filter %s lacks the window start %s", filter, want)
	}
	if strings.Count(filter, "'") != 18 {
		t.Errorf("every expression is quoted: %s", filter)
	}
}
