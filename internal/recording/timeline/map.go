package timeline

import (
	"slices"
	"time"
)

// mapGestures places the gestures on the segments that were recording their
// target while they happened. A gesture on another target is left out. A
// gesture that began before or ended after its segment is cut to it. One that
// spans two segments of its target appears once in each.
func (b *Builder) mapGestures(segments []*placed) ([]Gesture, []Caption) {
	gestures := make([]Gesture, 0, len(b.gestures))
	for index := range b.gestures {
		input := &b.gestures[index]
		for position, segment := range segments {
			// Input sent through the debugging protocol does not know its target.
			if input.TargetID != "" && segment.input.TargetID != "" && input.TargetID != segment.input.TargetID {
				continue
			}
			if mapped, ok := mapGesture(input, segment, position); ok {
				gestures = append(gestures, mapped)
			}
		}
	}
	slices.SortStableFunc(gestures, func(a, b Gesture) int {
		if a.StartMs != b.StartMs {
			return int(a.StartMs - b.StartMs)
		}
		return int(int64(a.ID) - int64(b.ID))
	})
	captions := make([]Caption, 0)
	for _, gesture := range gestures {
		if gesture.Caption == "" {
			continue
		}
		captions = append(captions, Caption{
			StartMs: gesture.StartMs,
			EndMs:   gesture.EndMs + gesture.HoldMs,
			Text:    gesture.Caption,
			Gesture: gesture.ID,
		})
	}
	return gestures, captions
}

func mapGesture(input *GestureInput, segment *placed, position int) (Gesture, bool) {
	start, end := input.Start, input.End
	if end.Before(start) {
		end = start
	}
	finish := end.Add(max(input.Hold, 0))
	// A gesture overlaps the segment when any of its span is inside it. An
	// instant gesture has to be inside.
	if finish.Before(segment.ownStart) || start.After(segment.ownEnd) {
		return Gesture{}, false
	}
	clippedStart := maxTime(start, segment.ownStart)
	clippedEnd := minTime(end, segment.ownEnd)
	if clippedEnd.Before(clippedStart) {
		clippedEnd = clippedStart
	}
	hold := min(max(input.Hold, 0), segment.ownEnd.Sub(clippedEnd))
	if !clippedEnd.Equal(end) {
		hold = 0
	}
	mapped := Gesture{
		ID:       input.ID,
		Kind:     input.Kind,
		Tool:     input.Tool,
		Mode:     input.Mode,
		Segment:  position,
		TargetID: input.TargetID,
		StartMs:  toMs(segment.video(clippedStart)),
		EndMs:    toMs(segment.video(clippedEnd)),
		HoldMs:   toMs(hold),
		Clipped:  !clippedStart.Equal(start) || !clippedEnd.Equal(end) || hold < input.Hold,
		Caption:  input.Caption,
	}
	for _, point := range clipPath(input.Path, start, segment) {
		x, y := segment.point(point.X, point.Y)
		mapped.Path = append(mapped.Path, PathPoint{TMs: toMs(segment.video(start.Add(point.Offset))), X: x, Y: y})
	}
	for _, click := range input.Clicks {
		if !segment.owns(click.At) {
			continue
		}
		x, y := segment.point(click.X, click.Y)
		mapped.Clicks = append(mapped.Clicks, Click{TMs: toMs(segment.video(click.At)), X: x, Y: y, Button: click.Button, Count: click.Count})
	}
	if input.Kind == "scroll" || input.ScrollX != 0 || input.ScrollY != 0 {
		mapped.Scroll = &Scroll{DX: input.ScrollX, DY: input.ScrollY}
		if input.ScrollAt != nil {
			x, y := segment.point(input.ScrollAt.X, input.ScrollAt.Y)
			mapped.Scroll.At = &Point{X: x, Y: y}
		}
	}
	return mapped, true
}

// point converts page coordinates to frame pixels, inside the frame, to a tenth of a pixel.
func (p *placed) point(x, y float64) (float64, float64) {
	scaleX, scaleY := p.input.ScaleX, p.input.ScaleY
	if scaleX <= 0 {
		scaleX = 1
	}
	if scaleY <= 0 {
		scaleY = 1
	}
	fit := func(value, scale float64, size int) float64 {
		value *= scale
		if size > 0 {
			value = max(0, min(value, float64(size)))
		}
		return float64(int64(value*10+0.5)) / 10
	}
	return fit(x, scaleX, p.input.Width), fit(y, scaleY, p.input.Height)
}

func maxTime(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

// mapBursts groups the burst segments of a video into bursts and places the
// actions that ran during them. Consecutive segments with the same burst number
// are one burst. An action lands in the burst whose segments were being recorded
// while it ran; one that ran while nothing was recorded is left out.
func (b *Builder) mapBursts(segments []*placed) []Burst {
	var bursts []Burst
	for from := 0; from < len(segments); {
		number := segments[from].input.Burst
		to := from + 1
		if number != 0 {
			for to < len(segments) && segments[to].input.Burst == number {
				to++
			}
		}
		if number != 0 {
			bursts = append(bursts, b.mapBurst(segments[from:to], from))
		}
		from = to
	}
	return bursts
}

func (b *Builder) mapBurst(group []*placed, offset int) Burst {
	first, last := group[0], group[len(group)-1]
	burst := Burst{
		FirstSegment: offset,
		LastSegment:  offset + len(group) - 1,
		StartMs:      toMs(first.videoStart),
		EndMs:        toMs(last.videoStart + last.length),
		ClosedBy:     last.closedBy,
		Actions:      []BurstAction{},
	}
	var firstStart, lastEnd time.Time
	for _, action := range b.actions {
		end := action.End
		if end.Before(action.Start) {
			end = action.Start
		}
		// The segments an action overlapped, by the time they own.
		var from, to *placed
		for _, segment := range group {
			if end.Before(segment.ownStart) || action.Start.After(segment.ownEnd) {
				continue
			}
			if from == nil {
				from = segment
			}
			to = segment
		}
		if from == nil {
			continue
		}
		burst.Actions = append(burst.Actions, BurstAction{
			Tool:     action.Tool,
			Kind:     action.Kind,
			TargetID: action.TargetID,
			StartMs:  toMs(from.video(maxTime(action.Start, from.ownStart))),
			EndMs:    toMs(to.video(minTime(end, to.ownEnd))),
			Gesture:  action.Gesture,
		})
		if firstStart.IsZero() || action.Start.Before(firstStart) {
			firstStart = action.Start
		}
		if end.After(lastEnd) {
			lastEnd = end
		}
	}
	slices.SortStableFunc(burst.Actions, func(a, b BurstAction) int { return int(a.StartMs - b.StartMs) })
	if len(burst.Actions) > 0 {
		burst.LeadMs = max(0, toMs(firstStart.Sub(first.ownStart)))
		burst.TailMs = max(0, toMs(last.ownEnd.Sub(lastEnd)))
	}
	return burst
}

// mapActivity turns the sampled changes of each segment's capture into spans of
// video time. Spans that touch across a segment boundary, or are closer than the
// merge gap, become one.
func (b *Builder) mapActivity(segments []*placed) Activity {
	activity := Activity{
		Available:        b.samples > 0,
		SampleIntervalMs: b.limits.SampleInterval.Milliseconds(),
		MergeGapMs:       b.limits.MergeGap.Milliseconds(),
		Spans:            []Span{},
	}
	var spans, unknown []Span
	for _, segment := range segments {
		spans = append(spans, mapSpans(b.changes[segment.input.CaptureID], segment)...)
		unknown = append(unknown, mapSpans(b.unknown[segment.input.CaptureID], segment)...)
	}
	activity.Spans = mergeSpans(spans, activity.MergeGapMs)
	if len(activity.Spans) == 0 {
		activity.Spans = []Span{}
	}
	activity.Unknown = mergeSpans(unknown, 0)
	return activity
}

// mapSpans keeps the parts of a capture's wall time spans that lie in the part
// of the segment its events belong to.
func mapSpans(spans *wallSpans, segment *placed) []Span {
	if spans == nil {
		return nil
	}
	var mapped []Span
	for _, span := range spans.list {
		if span.end.Before(segment.ownStart) || span.start.After(segment.ownEnd) {
			continue
		}
		start, end := maxTime(span.start, segment.ownStart), minTime(span.end, segment.ownEnd)
		mapped = append(mapped, Span{StartMs: toMs(segment.video(start)), EndMs: toMs(segment.video(end))})
	}
	return mapped
}

// mergeSpans orders spans and joins those no more than gap apart.
func mergeSpans(spans []Span, gap int64) []Span {
	if len(spans) == 0 {
		return nil
	}
	slices.SortFunc(spans, func(a, b Span) int { return int(a.StartMs - b.StartMs) })
	merged := []Span{spans[0]}
	for _, span := range spans[1:] {
		last := &merged[len(merged)-1]
		if span.StartMs-last.EndMs <= gap {
			last.EndMs = max(last.EndMs, span.EndMs)
			continue
		}
		merged = append(merged, span)
	}
	return merged
}

// clipPath returns the part of a gesture's path that lies in the part of the
// segment its events belong to. Where the segment cuts the path between two
// points, the position at the cut is interpolated and added, so the clipped
// path still starts and ends where the segment does. Thinned paths have long
// straight runs, so this matters.
func clipPath(path []PathInput, start time.Time, segment *placed) []PathInput {
	var clipped []PathInput
	cut := func(previous, next PathInput, boundary time.Time) {
		from, to := start.Add(previous.Offset), start.Add(next.Offset)
		if !to.After(from) {
			return
		}
		fraction := float64(boundary.Sub(from)) / float64(to.Sub(from))
		clipped = append(clipped, PathInput{
			Offset: boundary.Sub(start),
			X:      previous.X + (next.X-previous.X)*fraction,
			Y:      previous.Y + (next.Y-previous.Y)*fraction,
		})
	}
	strictlyBetween := func(boundary time.Time, previous, next PathInput) bool {
		return boundary.After(start.Add(previous.Offset)) && boundary.Before(start.Add(next.Offset))
	}
	for index, point := range path {
		if index > 0 {
			previous := path[index-1]
			if strictlyBetween(segment.ownStart, previous, point) {
				cut(previous, point, segment.ownStart)
			}
			if strictlyBetween(segment.ownEnd, previous, point) {
				cut(previous, point, segment.ownEnd)
			}
		}
		if segment.owns(start.Add(point.Offset)) {
			clipped = append(clipped, point)
		}
	}
	return clipped
}
