package edit

import (
	"fmt"
	"strings"

	"github.com/aperture/aperture/internal/recording/timeline"
)

// maxFilterBytes bounds the filter chain. A single command line argument is at
// most 128 KiB.
const maxFilterBytes = 100_000

// filterOverheadBytes is what the filters that are always there (and the crop and
// the captions) need of the limit.
const filterOverheadBytes = 512

// maxFPS is the highest frame rate of an edited video.
const maxFPS = 60

// Source is what is known about the video that is edited.
type Source struct {
	// Width and Height are the pixels of the video's frames. Zero takes the
	// timeline's first segment.
	Width, Height int
	// DurationMs is the video's length. Zero takes the timeline's.
	DurationMs int64
}

// Report says what a plan applies.
type Report struct {
	Zooms    int `json:"zooms"`
	Ripples  int `json:"ripples"`
	Captions int `json:"captions"`
	// IdleCutMs is the raw video time the idle mode removes, IdleSpedMs the time
	// it saves by playing stretches faster.
	IdleCutMs   int64 `json:"idleCutMs"`
	IdleSpedMs  int64 `json:"idleSpedMs"`
	IdleRegions int   `json:"idleRegions"`
}

// Plan is what to do to a video: the ffmpeg filter chain, the captions script to
// write next to it as captions.ass, and the map from raw video times to edited
// video times.
type Plan struct {
	// FPS is the constant frame rate of the edited video; Width and Height its
	// frame, the source's.
	FPS, Width, Height int
	// InDurationMs is the source's length and OutDurationMs the edited video's.
	InDurationMs, OutDurationMs int64
	// Filter is the -vf chain. It is empty when the plan is trivial.
	Filter string
	// ASS is the captions script, nil when nothing is captioned.
	ASS     []byte
	TimeMap TimeMap
	// Cues are the captions on the edited video's clock.
	Cues     []Cue
	Report   Report
	Warnings []string
}

// Trivial reports whether the plan changes nothing: no caption to burn, no zoom
// or ripple to draw, and no idle stretch to shorten. Such a video is not worth
// rendering again.
func (p *Plan) Trivial() bool {
	return p.Report.Zooms == 0 && p.Report.Ripples == 0 && p.Report.Captions == 0 && p.Report.IdleRegions == 0
}

// Build plans the edit of a video from its timeline. It is pure. It fails with an
// *Error when the timeline cannot be edited as it is: CodeMixedSizes when the
// recording's frames differ in size. Effects that do not fit in the limit of the
// filter ffmpeg takes (a filter argument of 128 KiB) are left out, and the plan
// says so.
func Build(tl *timeline.Timeline, src Source) (*Plan, error) {
	if len(tl.Segments) == 0 {
		return nil, newError(CodeInternal, "the timeline has no segments")
	}
	first := tl.Segments[0]
	for _, segment := range tl.Segments[1:] {
		if segment.Width != first.Width || segment.Height != first.Height {
			return nil, newError(CodeMixedSizes, "the recording's frames change size (%dx%d and %dx%d), for example after the viewport was resized, which editing does not support", first.Width, first.Height, segment.Width, segment.Height)
		}
	}
	width, height := src.Width, src.Height
	if width <= 0 || height <= 0 {
		width, height = first.Width, first.Height
	}
	if width <= 0 || height <= 0 {
		return nil, newError(CodeSourceUnreadable, "the video's size is unknown")
	}
	total := src.DurationMs
	if total <= 0 {
		total = tl.Recording.DurationMs
	}
	if total <= 0 {
		return nil, newError(CodeSourceUnreadable, "the video's length is unknown")
	}
	fps := tl.Recording.FPS
	if fps <= 0 {
		fps = 30
	}
	fps = min(fps, maxFPS)

	scales := make([]segmentScale, len(tl.Segments))
	for index, segment := range tl.Segments {
		scales[index] = segmentScale{x: float64(width) / float64(segment.Width), y: float64(height) / float64(segment.Height)}
	}
	plan := &Plan{FPS: fps, Width: width, Height: height, InDurationMs: total}

	list, skippedRipples := ripples(tl, scales)
	if skippedRipples > 0 {
		plan.warn("%d click%s made through Playwright input %s no position in the video and %s not marked", skippedRipples, plural(skippedRipples), have(skippedRipples), be(skippedRipples))
	}
	gestures, skippedZooms := zoomGestures(tl, scales)
	if skippedZooms > 0 {
		plan.warn("%d zoomed gesture%s made through Playwright input %s no position in the video and %s not followed", skippedZooms, plural(skippedZooms), have(skippedZooms), be(skippedZooms))
	}
	scenes := planZoomScenes(gestures, float64(width), float64(height), fps)
	cues := buildCues(tl.Captions, total)

	idleMode := ""
	if tl.Recording.Edit != nil {
		idleMode = tl.Recording.Edit.Idle
	}
	shortened := idlePlan{Map: IdentityMap(total)}
	if idleMode != "" {
		busy, known := busyIntervals(tl, cues, list, scenes)
		if known {
			var warnings []string
			shortened, warnings = planIdle(idleMode, mergeIntervals(busy, total), total, fps)
			plan.Warnings = append(plan.Warnings, warnings...)
			if shortened.Regions == 0 && len(warnings) == 0 {
				plan.warn("idle was left as it is: no stretch of %.1f s or more without changes on the screen or gestures", float64(idleMinMs)/1000)
			}
		} else {
			plan.warn("idle was left as it is: the screen could not be watched while recording")
		}
	}
	plan.TimeMap = shortened.Map
	plan.OutDurationMs = shortened.Map.OutDuration()
	plan.Cues = mapCues(cues, shortened.Map)

	var remap []string
	if shortened.Regions > 0 {
		selectExpr, ptsExpr := shortened.Map.remapExpressions(fps)
		remap = []string{"select='" + selectExpr + "'", "setpts='" + ptsExpr + "'", fmt.Sprintf("fps=fps=%d", fps)}
	}
	// The zooms are filters of their own and so are the ripples; what does not fit
	// in the filter limit is left out, the ripples first.
	budget := maxFilterBytes - filterOverheadBytes
	for _, part := range remap {
		budget -= len(part) + 1
	}
	var zooms, ripplesFilters []string
	for _, scene := range scenes {
		filter := scene.filter(float64(width), float64(height), fps)
		if len(zooms) >= maxZoomScenes || len(filter)+1 > budget {
			break
		}
		zooms = append(zooms, filter)
		budget -= len(filter) + 1
	}
	if len(zooms) < len(scenes) {
		plan.warn("only the first %d of %d zooms are applied, the limit of the filter ffmpeg takes", len(zooms), len(scenes))
	}
	for _, item := range list {
		filter := item.filter(width, height, fps)
		if len(ripplesFilters) >= maxRipples || len(filter)+1 > budget {
			break
		}
		ripplesFilters = append(ripplesFilters, filter)
		budget -= len(filter) + 1
	}
	if len(ripplesFilters) < len(list) {
		plan.warn("only the first %d of %d clicks are marked with a ripple, the limit of the filter ffmpeg takes", len(ripplesFilters), len(list))
	}
	plan.Report = Report{
		Zooms: len(zooms), Ripples: len(ripplesFilters), Captions: len(plan.Cues),
		IdleCutMs: shortened.CutMs, IdleSpedMs: shortened.SavedMs, IdleRegions: shortened.Regions,
	}
	if plan.Trivial() {
		plan.OutDurationMs = total
		return plan, nil
	}

	chain := []string{
		"setpts=PTS-STARTPTS",
		fmt.Sprintf("fps=fps=%d:start_time=0", fps),
		"format=yuv420p",
	}
	chain = append(chain, ripplesFilters...)
	chain = append(chain, zooms...)
	chain = append(chain, remap...)
	if width%2 != 0 || height%2 != 0 {
		chain = append(chain, "crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0")
	}
	if len(plan.Cues) > 0 {
		plan.ASS = marshalASS(plan.Cues, width&^1, height&^1)
		chain = append(chain, "ass=captions.ass")
	}
	plan.Filter = strings.Join(chain, ",")
	if len(plan.Filter) > maxFilterBytes {
		// The budget above keeps it within the limit; this only guards its arithmetic.
		return nil, newError(CodeInternal, "the filter of %d bytes is longer than the %d ffmpeg takes", len(plan.Filter), maxFilterBytes)
	}
	return plan, nil
}

func (p *Plan) warn(format string, args ...any) {
	p.Warnings = append(p.Warnings, fmt.Sprintf(format, args...))
}

func plural(count int) string {
	if count == 1 {
		return ""
	}
	return "s"
}

func have(count int) string {
	if count == 1 {
		return "has"
	}
	return "have"
}

func be(count int) string {
	if count == 1 {
		return "was"
	}
	return "were"
}

// rippleWindowMs is how long past its click a ripple keeps the video busy.
const rippleWindowMs = rippleDurationMs

// busyIntervals lists what keeps the video from being idle, on the raw video's
// clock: changes on the screen, gestures, captions, and the ripples and zooms
// themselves, so an effect is never sped through. known is false when the screen
// could not be watched, so nothing can be said about idle time.
func busyIntervals(tl *timeline.Timeline, cues []Cue, list []ripple, scenes []zoomScene) (busy []interval, known bool) {
	if !tl.Activity.Available {
		return nil, false
	}
	busy = append(busy, spanIntervals(tl.Activity.Spans, tl.Activity.MergeGapMs/2)...)
	// Where the screen could not be sampled, missing activity means nothing.
	busy = append(busy, spanIntervals(tl.Activity.Unknown, 0)...)
	for _, gesture := range tl.Gestures {
		busy = append(busy, interval{gesture.StartMs - gesturePadMs, gesture.EndMs + gesture.HoldMs + gesturePadMs})
	}
	for _, cue := range cues {
		busy = append(busy, interval{cue.StartMs, cue.EndMs})
	}
	for _, item := range list {
		busy = append(busy, interval{item.tMs, item.tMs + rippleWindowMs})
	}
	for _, scene := range scenes {
		busy = append(busy, interval{scene.StartMs, scene.EndMs})
	}
	return busy, true
}
