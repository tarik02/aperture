package edit

import (
	"math"
	"sort"
)

// Piece is one stretch of the raw video that is kept in the edited one, played at
// Speed. Stretches that are cut out are absent.
type Piece struct {
	// SrcStart and SrcEnd are raw video times in milliseconds, SrcEnd exclusive.
	SrcStart int64 `json:"srcStartMs"`
	SrcEnd   int64 `json:"srcEndMs"`
	// DstStart is where the piece starts in the edited video.
	DstStart int64 `json:"dstStartMs"`
	// Speed is the playback speed, 1 for stretches played as they are.
	Speed float64 `json:"speed"`
}

// DstEnd is where the piece ends in the edited video.
func (p Piece) DstEnd() int64 {
	return p.DstStart + int64(math.Round(float64(p.SrcEnd-p.SrcStart)/p.Speed))
}

// TimeMap maps times of the raw video to the edited one. It is monotone: a time
// inside a cut stretch maps to the point where the stretch was removed, and
// times after the last piece map to the end of the edited video.
type TimeMap struct {
	Pieces []Piece `json:"pieces"`
}

// IdentityMap is the map of a video that keeps all of its duration at normal speed.
func IdentityMap(durationMs int64) TimeMap {
	return TimeMap{Pieces: []Piece{{SrcStart: 0, SrcEnd: durationMs, DstStart: 0, Speed: 1}}}
}

// newTimeMap builds the map of pieces given by their source ranges and speeds,
// laying them out one after another.
func newTimeMap(pieces []Piece) TimeMap {
	var dst int64
	out := make([]Piece, 0, len(pieces))
	for _, piece := range pieces {
		piece.DstStart = dst
		dst = piece.DstEnd()
		out = append(out, piece)
	}
	return TimeMap{Pieces: out}
}

// OutDuration is the length of the edited video.
func (m TimeMap) OutDuration() int64 {
	if len(m.Pieces) == 0 {
		return 0
	}
	return m.Pieces[len(m.Pieces)-1].DstEnd()
}

// Map converts a raw video time to an edited video time.
func (m TimeMap) Map(src int64) int64 {
	if len(m.Pieces) == 0 {
		return 0
	}
	// The first piece that ends after src.
	index := sort.Search(len(m.Pieces), func(i int) bool { return m.Pieces[i].SrcEnd > src })
	if index == len(m.Pieces) {
		return m.OutDuration()
	}
	piece := m.Pieces[index]
	if src <= piece.SrcStart {
		// Before the piece, in a stretch that was cut: it collapses to the piece's start.
		return piece.DstStart
	}
	return min(piece.DstStart+int64(math.Round(float64(src-piece.SrcStart)/piece.Speed)), piece.DstEnd())
}

// MapSpan converts a span of raw video time. The result is never empty unless the
// whole span was cut out.
func (m TimeMap) MapSpan(start, end int64) (int64, int64) {
	from, to := m.Map(start), m.Map(end)
	return from, max(from, to)
}

// removedAndSaved returns how much of a video of the given length the map drops,
// and how much shorter the pieces played faster make it.
func (m TimeMap) removedAndSaved(total int64) (removed, saved int64) {
	var kept int64
	for _, piece := range m.Pieces {
		length := piece.SrcEnd - piece.SrcStart
		kept += length
		if piece.Speed > 1 {
			saved += length - (piece.DstEnd() - piece.DstStart)
		}
	}
	return max(0, total-kept), saved
}
