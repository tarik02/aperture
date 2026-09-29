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
	// MixedSizes says the video's frames were found to change size, which the
	// timeline may not have noticed.
	MixedSizes bool
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
	// FitFilter is the -vf chain of the pass that comes before the edit when the
	// video's frames change size (the viewport was resized between segments, or
	// between the bursts of a bursts recording): every frame is fitted into the
	// first one's size, keeping its aspect ratio. It is empty when the frames
	// keep their size. It is a pass of its own since ffmpeg rebuilds a filter
	// graph when the frame size changes, which restarts the timestamps the edit's
	// filters rely on.
	FitFilter string
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
// *Error when the timeline cannot be edited as it is. Frames of different sizes
// are fitted into the first one's, with black bars where the aspect ratio
// differs. Effects that do not fit in the limit of the
// filter ffmpeg takes (a filter argument of 128 KiB), or that the timeline had
// no room for, are left out, and the plan says so.
func Build(tl *timeline.Timeline, src Source) (*Plan, error) {
	geometry, err := sourceGeometry(tl, src)
	if err != nil {
		return nil, err
	}
	width, height, total, fps := geometry.width, geometry.height, geometry.total, geometry.fps
	plan := &Plan{FPS: fps, Width: width, Height: height, InDurationMs: total, FitFilter: geometry.fitFilter()}
	plan.noteTruncation(tl)
	if plan.FitFilter != "" {
		plan.warn("the recording's frames change size (the viewport was resized), so all of them were fitted into the first frame's %dx%d with black bars where the shape differs", width, height)
	}

	list, skippedRipples := ripples(tl, geometry.scales)
	if skippedRipples > 0 {
		plan.warn("clicks made through Playwright input have no position in the video and were not marked with a ripple (%d)", skippedRipples)
	}
	gestures, skippedZooms := zoomGestures(tl, geometry.scales)
	if skippedZooms > 0 {
		plan.warn("zoomed gestures made through Playwright input have no position in the video and were not followed (%d)", skippedZooms)
	}
	scenes := planZoomScenes(gestures, float64(width), float64(height), fps)
	cues := buildCues(tl.Captions, total)
	if len(tl.Captions) > 0 && len(cues) == 0 && captionsWithText(tl.Captions) > 0 {
		plan.warn("no caption was burned in: they all fall after the end of the video")
	}

	shortened := plan.planIdleStretches(tl, cues, list, scenes)
	plan.TimeMap = shortened.Map
	plan.OutDurationMs = shortened.Map.OutDuration()
	plan.Cues = mapCues(cues, shortened.Map)

	remap := remapFilters(shortened, fps)
	zooms, ripplesFilters := plan.budgetFilters(scenes, list, remap, width, height, fps)
	plan.Report = Report{
		Zooms: len(zooms), Ripples: len(ripplesFilters), Captions: len(plan.Cues),
		IdleCutMs: shortened.CutMs, IdleSpedMs: shortened.SavedMs, IdleRegions: shortened.Regions,
	}
	if plan.Trivial() {
		plan.OutDurationMs = total
		return plan, nil
	}
	if err := plan.assembleChain(ripplesFilters, zooms, remap); err != nil {
		return nil, err
	}
	return plan, nil
}

// geometry is the frame and clock the plan is made for.
type geometry struct {
	width, height int
	total         int64
	fps           int
	scales        []segmentScale
	// fitted is set when frames of different sizes are fitted into one.
	fitted bool
}

func (g geometry) fitFilter() string {
	if !g.fitted {
		return ""
	}
	return fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease:flags=bicubic,pad=%d:%d:(ow-iw)/2:(oh-ih)/2:black,setsar=1", g.width, g.height, g.width, g.height)
}

// sourceGeometry checks the timeline's segments and settles the source's size,
// length and frame rate.
func sourceGeometry(tl *timeline.Timeline, src Source) (geometry, error) {
	if len(tl.Segments) == 0 {
		return geometry{}, newError(CodeInternal, "the timeline has no segments")
	}
	first := tl.Segments[0]
	fitted := src.MixedSizes
	for _, segment := range tl.Segments[1:] {
		if segment.Width != first.Width || segment.Height != first.Height {
			fitted = true
		}
	}
	width, height := src.Width, src.Height
	if width <= 0 || height <= 0 {
		width, height = first.Width, first.Height
	}
	if width <= 0 || height <= 0 {
		return geometry{}, newError(CodeSourceUnreadable, "the video's size is unknown")
	}
	if fitted {
		// The pass that fits the frames encodes them, which needs even sizes.
		width, height = max(width&^1, 2), max(height&^1, 2)
	}
	total := src.DurationMs
	if total <= 0 {
		total = tl.Recording.DurationMs
	}
	if total <= 0 {
		return geometry{}, newError(CodeSourceUnreadable, "the video's length is unknown")
	}
	fps := tl.Recording.FPS
	if fps <= 0 {
		fps = 30
	}
	scales := make([]segmentScale, len(tl.Segments))
	for index, segment := range tl.Segments {
		scales[index] = fitSegment(segment.Width, segment.Height, width, height, fitted)
	}
	return geometry{width: width, height: height, total: total, fps: min(fps, maxFPS), scales: scales, fitted: fitted}, nil
}

// fitSegment maps a segment of the given size into a frame. Frames of one size all
// through are stretched to the source, which only matters when the timeline
// and the video disagree on the size. Frames of different sizes are fitted, as
// the fitting filter does: scaled by the largest factor that keeps them inside
// the frame and centered.
func fitSegment(segmentWidth, segmentHeight, width, height int, fitted bool) segmentScale {
	if segmentWidth <= 0 || segmentHeight <= 0 {
		return segmentScale{x: 1, y: 1}
	}
	x, y := float64(width)/float64(segmentWidth), float64(height)/float64(segmentHeight)
	if !fitted {
		return segmentScale{x: x, y: y}
	}
	factor := min(x, y)
	return segmentScale{
		x: factor, y: factor,
		ox: (float64(width) - factor*float64(segmentWidth)) / 2,
		oy: (float64(height) - factor*float64(segmentHeight)) / 2,
	}
}

func captionsWithText(captions []timeline.Caption) int {
	count := 0
	for _, caption := range captions {
		if normalizeCueText(caption.Text) != "" {
			count++
		}
	}
	return count
}

// noteTruncation says what the timeline had no room for: gestures and captions
// beyond its limits are not in it, so their effects cannot be applied.
func (p *Plan) noteTruncation(tl *timeline.Timeline) {
	if tl.Truncated.Gestures {
		p.warn("the timeline had room for only some of the gestures; the zooms and ripples of the ones past its limit were not applied")
	}
	if tl.Truncated.Captions {
		p.warn("the timeline had room for only some of the captions; the ones past its limit were not burned in")
	}
}

// planIdleStretches shortens the recording's idle stretches when its idle mode
// asks for it, and otherwise returns the identity plan. Nothing is said about
// idle time when the timeline cannot vouch for what is idle.
func (p *Plan) planIdleStretches(tl *timeline.Timeline, cues []Cue, list []ripple, scenes []zoomScene) idlePlan {
	identity := idlePlan{Map: IdentityMap(p.InDurationMs)}
	mode := idleMode(tl)
	if mode == "" {
		if tl.Recording.Edit != nil && tl.Recording.Edit.Idle != "" {
			p.warn("idle has no effect on a bursts recording, which captures nothing between its actions")
		}
		return identity
	}
	busy, unknown := busyIntervals(tl, cues, list, scenes)
	if unknown != "" {
		p.warn("idle was left as it is: %s", unknown)
		return identity
	}
	shortened, warnings := planIdle(mode, mergeIntervals(busy, p.InDurationMs), p.InDurationMs, p.FPS)
	p.Warnings = append(p.Warnings, warnings...)
	if shortened.Regions == 0 && len(warnings) == 0 {
		p.warn("idle was left as it is: no stretch of %.1f s or more without changes on the screen or gestures", float64(idleMinMs)/1000)
	}
	return shortened
}

// remapFilters are the filters that cut or speed up the idle stretches, none when
// there are none.
func remapFilters(shortened idlePlan, fps int) []string {
	if shortened.Regions == 0 {
		return nil
	}
	selectExpr, ptsExpr := shortened.Map.remapExpressions(fps)
	return []string{"select='" + selectExpr + "'", "setpts='" + ptsExpr + "'", fmt.Sprintf("fps=fps=%d", fps)}
}

// budgetFilters returns the zoom and ripple filters that fit in the filter limit
// next to the remap; what does not fit is left out, the ripples first, and the
// plan says so.
func (p *Plan) budgetFilters(scenes []zoomScene, list []ripple, remap []string, width, height, fps int) (zooms, marks []string) {
	budget := maxFilterBytes - filterOverheadBytes
	for _, part := range remap {
		budget -= len(part) + 1
	}
	for _, scene := range scenes {
		filter := scene.filter(float64(width), float64(height), fps)
		if len(zooms) >= maxZoomScenes || len(filter)+1 > budget {
			break
		}
		zooms = append(zooms, filter)
		budget -= len(filter) + 1
	}
	if len(zooms) < len(scenes) {
		p.warn("only the first %d of %d zooms are applied, the limit of the filter ffmpeg takes", len(zooms), len(scenes))
	}
	for _, item := range list {
		filter := item.filter(width, height, fps)
		if len(marks) >= maxRipples || len(filter)+1 > budget {
			break
		}
		marks = append(marks, filter)
		budget -= len(filter) + 1
	}
	if len(marks) < len(list) {
		p.warn("only the first %d of %d clicks are marked with a ripple, the limit of the filter ffmpeg takes", len(marks), len(list))
	}
	return zooms, marks
}

// assembleChain joins the filters in their order: ripples and zooms while frames
// still have their raw times, then the idle remap, then the crop to even sizes and
// the captions.
func (p *Plan) assembleChain(marks, zooms, remap []string) error {
	chain := []string{
		"setpts=PTS-STARTPTS",
		fmt.Sprintf("fps=fps=%d:start_time=0", p.FPS),
		"format=yuv420p",
	}
	chain = append(chain, marks...)
	chain = append(chain, zooms...)
	chain = append(chain, remap...)
	if p.Width%2 != 0 || p.Height%2 != 0 {
		chain = append(chain, "crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0")
	}
	if len(p.Cues) > 0 {
		p.ASS = marshalASS(p.Cues, p.Width&^1, p.Height&^1)
		chain = append(chain, "ass=captions.ass")
	}
	p.Filter = strings.Join(chain, ",")
	if len(p.Filter) > maxFilterBytes {
		// The budget keeps it within the limit; this only guards its arithmetic.
		return newError(CodeInternal, "the filter of %d bytes is longer than the %d ffmpeg takes", len(p.Filter), maxFilterBytes)
	}
	return nil
}

func (p *Plan) warn(format string, args ...any) {
	p.Warnings = append(p.Warnings, fmt.Sprintf(format, args...))
}

// rippleWindowMs is how long past its click a ripple keeps the video busy.
const rippleWindowMs = rippleDurationMs

// busyIntervals lists what keeps the video from being idle, on the raw video's
// clock: changes on the screen, gestures, captions, and the ripples and zooms
// themselves, so an effect is never sped through. unknown says why nothing can
// be said about idle time, and is empty when something can: the screen could not
// be watched, or the timeline is missing activity or gestures beyond its limits,
// so the stretches between the ones it has are not known to be idle.
func busyIntervals(tl *timeline.Timeline, cues []Cue, list []ripple, scenes []zoomScene) (busy []interval, unknown string) {
	switch {
	case !tl.Activity.Available:
		return nil, "the screen could not be watched while recording"
	case tl.Truncated.Activity:
		return nil, "the timeline had room for only some of the screen changes, so no stretch is known to be idle"
	case tl.Truncated.Gestures:
		return nil, "the timeline had room for only some of the gestures, so no stretch is known to be idle"
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
	return busy, ""
}
