package edit

import (
	"fmt"
	"math"
	"slices"
	"strings"

	"github.com/aperture/aperture/internal/recording/timeline"
)

const (
	// gesturePadMs widens each gesture on both sides. The cursor shows up 20 to
	// 40 ms after a gesture starts and the page reacts 50 to 90 ms after a click,
	// so the video around a gesture is never idle.
	gesturePadMs = 100
	// minSpeedPieceMs is the shortest a sped up stretch gets, so a fast section
	// stays readable as a section.
	minSpeedPieceMs = 250
	// maxKeptPieces bounds the pieces of one video, since each is a term in the
	// filter expressions.
	maxKeptPieces = 150
)

type interval struct{ start, end int64 }

// mergeIntervals sorts intervals, clamps them to the video and joins those that
// overlap or touch.
func mergeIntervals(list []interval, total int64) []interval {
	clamped := make([]interval, 0, len(list))
	for _, item := range list {
		item.start = max(item.start, 0)
		item.end = min(item.end, total)
		if item.end < item.start {
			continue
		}
		clamped = append(clamped, item)
	}
	slices.SortFunc(clamped, func(a, b interval) int {
		if a.start != b.start {
			return int(a.start - b.start)
		}
		return int(a.end - b.end)
	})
	merged := make([]interval, 0, len(clamped))
	for _, item := range clamped {
		if last := len(merged) - 1; last >= 0 && item.start <= merged[last].end {
			merged[last].end = max(merged[last].end, item.end)
			continue
		}
		merged = append(merged, item)
	}
	return merged
}

func spanIntervals(spans []timeline.Span, pad int64) []interval {
	out := make([]interval, 0, len(spans))
	for _, span := range spans {
		out = append(out, interval{span.StartMs - pad, span.EndMs + pad})
	}
	return out
}

// gridUp and gridDown round a time to the frame grid of a constant frame rate.
func gridUp(ms int64, fps int) int64 {
	frame := int64(math.Ceil(float64(ms) * float64(fps) / 1000))
	return int64(math.Round(float64(frame) * 1000 / float64(fps)))
}

func gridDown(ms int64, fps int) int64 {
	frame := int64(math.Floor(float64(ms) * float64(fps) / 1000))
	return int64(math.Round(float64(frame) * 1000 / float64(fps)))
}

// idlePlan is what planIdle decides.
type idlePlan struct {
	Map     TimeMap
	Regions int
	// CutMs is the raw video time removed, SavedMs the time played faster saves.
	CutMs, SavedMs int64
}

// planIdle finds the idle stretches between the busy intervals and lays out the
// pieces of the video that remain. busy must be merged and sorted.
func planIdle(mode string, busy []interval, total int64, fps int) (idlePlan, []string) {
	identity := idlePlan{Map: IdentityMap(total)}
	if len(busy) == 0 {
		return identity, []string{"idle was left as it is: the recording has no gestures, captions or screen changes to keep"}
	}
	var regions []interval
	add := func(start, end int64, toEnd bool) {
		// The tail runs to the video's last frame, wherever the grid falls.
		start, end = gridUp(start, fps), gridDown(end, fps)
		if toEnd {
			end = total
		}
		if end-start < 2*1000/int64(fps) {
			return
		}
		regions = append(regions, interval{start, end})
	}
	if head := busy[0].start; head >= idleMinMs+idleKeepMs {
		add(0, head-idleKeepMs, false)
	}
	for index := 1; index < len(busy); index++ {
		if gap := busy[index].start - busy[index-1].end; gap >= idleMinMs+2*idleKeepMs {
			add(busy[index-1].end+idleKeepMs, busy[index].start-idleKeepMs, false)
		}
	}
	if last := busy[len(busy)-1].end; total-last >= idleMinMs+idleKeepMs {
		add(last+idleKeepMs, total, true)
	}
	var warnings []string
	speeds := make(map[interval]float64, len(regions))
	if mode == timeline.IdleSpeed {
		kept := regions[:0]
		for _, region := range regions {
			length := region.end - region.start
			destination := max(int64(math.Round(float64(length)/idleSpeed)), minSpeedPieceMs)
			// A stretch that would barely change speed is not worth a piece.
			if float64(length)/float64(destination) < 1.5 {
				continue
			}
			speeds[region] = math.Round(float64(length)/float64(destination)*10000) / 10000
			kept = append(kept, region)
		}
		regions = kept
	}
	piecesPerRegion := 1
	if mode == timeline.IdleSpeed {
		piecesPerRegion = 2
	}
	if limit := (maxKeptPieces - 1) / piecesPerRegion; len(regions) > limit {
		bySize := slices.Clone(regions)
		slices.SortFunc(bySize, func(a, b interval) int { return int((b.end - b.start) - (a.end - a.start)) })
		keep := make(map[interval]bool, limit)
		for _, region := range bySize[:limit] {
			keep[region] = true
		}
		dropped := len(regions) - limit
		kept := regions[:0]
		for _, region := range regions {
			if keep[region] {
				kept = append(kept, region)
			}
		}
		regions = kept
		warnings = append(warnings, fmt.Sprintf("idle shortened only the %d longest stretches; %d shorter ones were left as they are", limit, dropped))
	}
	if len(regions) == 0 {
		return identity, warnings
	}

	var pieces []Piece
	cursor := int64(0)
	for _, region := range regions {
		if region.start > cursor {
			pieces = append(pieces, Piece{SrcStart: cursor, SrcEnd: region.start, Speed: 1})
		}
		if mode == timeline.IdleSpeed {
			pieces = append(pieces, Piece{SrcStart: region.start, SrcEnd: region.end, Speed: speeds[region]})
		}
		cursor = region.end
	}
	if cursor < total {
		pieces = append(pieces, Piece{SrcStart: cursor, SrcEnd: total, Speed: 1})
	}
	timeMap := newTimeMap(pieces)
	removed, saved := timeMap.removedAndSaved(total)
	return idlePlan{Map: timeMap, Regions: len(regions), CutMs: removed, SavedMs: saved}, warnings
}

// remapExpressions returns the select and setpts expressions that apply a time
// map to a video whose frames sit on a constant frame rate grid.
func (m TimeMap) remapExpressions(fps int) (selectExpr, ptsExpr string) {
	half := 500 / float64(fps)
	selects := make([]string, 0, len(m.Pieces))
	terms := make([]string, 0, len(m.Pieces))
	for _, piece := range m.Pieces {
		// Boundaries sit between two frames, so no frame is decided by rounding noise.
		from := (float64(piece.SrcStart) - half) / 1000
		to := (float64(piece.SrcEnd) - half) / 1000
		selects = append(selects, fmt.Sprintf("gte(t,%.4f)*lt(t,%.4f)", from, to))
		term := fmt.Sprintf("(min(max(T,%.3f),%.3f)-%.3f)", float64(piece.SrcStart)/1000, float64(piece.SrcEnd)/1000, float64(piece.SrcStart)/1000)
		if piece.Speed != 1 {
			term += fmt.Sprintf("/%.4f", piece.Speed)
		}
		terms = append(terms, term)
	}
	return strings.Join(selects, "+"), "(" + strings.Join(terms, "+") + ")/TB"
}
