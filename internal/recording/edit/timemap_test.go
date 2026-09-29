package edit

import "testing"

func TestIdentityMap(t *testing.T) {
	m := IdentityMap(5000)
	for _, ms := range []int64{0, 1, 2500, 5000} {
		if got := m.Map(ms); got != ms {
			t.Errorf("Map(%d) = %d", ms, got)
		}
	}
	if m.OutDuration() != 5000 {
		t.Errorf("duration %d", m.OutDuration())
	}
	if got := m.Map(9000); got != 5000 {
		t.Errorf("a time past the end maps to the end, got %d", got)
	}
}

func TestTimeMapCutsCollapseAndSpeedsCompress(t *testing.T) {
	// Keep [0,2000) as it is, play [2000,6000) at 4x, cut [6000,8000), keep [8000,10000).
	m := newTimeMap([]Piece{
		{SrcStart: 0, SrcEnd: 2000, Speed: 1},
		{SrcStart: 2000, SrcEnd: 6000, Speed: 4},
		{SrcStart: 8000, SrcEnd: 10000, Speed: 1},
	})
	if got := m.OutDuration(); got != 5000 {
		t.Fatalf("duration %d, want 5000", got)
	}
	for _, test := range []struct{ src, dst int64 }{
		{0, 0}, {1000, 1000}, {2000, 2000},
		{4000, 2500}, {6000, 3000},
		// Inside the cut, everything lands where the cut was.
		{6001, 3000}, {7000, 3000}, {7999, 3000}, {8000, 3000},
		{9000, 4000}, {10000, 5000}, {12000, 5000},
	} {
		if got := m.Map(test.src); got != test.dst {
			t.Errorf("Map(%d) = %d, want %d", test.src, got, test.dst)
		}
	}
}

func TestTimeMapIsMonotone(t *testing.T) {
	m := newTimeMap([]Piece{
		{SrcStart: 500, SrcEnd: 1800, Speed: 1},
		{SrcStart: 2200, SrcEnd: 7000, Speed: 7.5},
		{SrcStart: 7900, SrcEnd: 8400, Speed: 1},
	})
	var previous int64 = -1
	for ms := int64(-100); ms < 9000; ms++ {
		got := m.Map(ms)
		if got < previous {
			t.Fatalf("Map(%d) = %d after %d", ms, got, previous)
		}
		previous = got
	}
	if m.Map(0) != 0 {
		t.Errorf("a time before the first piece maps to 0, got %d", m.Map(0))
	}
}

func TestTimeMapSpanIsEmptyOnlyWhenCutOut(t *testing.T) {
	m := newTimeMap([]Piece{
		{SrcStart: 0, SrcEnd: 1000, Speed: 1},
		{SrcStart: 3000, SrcEnd: 4000, Speed: 1},
	})
	if from, to := m.MapSpan(500, 900); to-from != 400 {
		t.Errorf("kept span maps to %d..%d", from, to)
	}
	if from, to := m.MapSpan(1200, 2800); to != from {
		t.Errorf("a span inside a cut is empty, got %d..%d", from, to)
	}
	// A span across a cut keeps only what is not cut.
	if from, to := m.MapSpan(800, 3200); from != 800 || to != 1200 {
		t.Errorf("span across a cut maps to %d..%d, want 800..1200", from, to)
	}
}

func TestRemapExpressionsCoverEveryPiece(t *testing.T) {
	m := newTimeMap([]Piece{
		{SrcStart: 0, SrcEnd: 2000, Speed: 1},
		{SrcStart: 2000, SrcEnd: 6000, Speed: 4},
		{SrcStart: 8000, SrcEnd: 10000, Speed: 1},
	})
	selectExpr, ptsExpr := m.remapExpressions(30)
	// One selector and one term per piece, the sped piece divided by its speed.
	if got := len(splitTop(selectExpr, '+')); got != 3 {
		t.Errorf("select %q has %d terms, want 3", selectExpr, got)
	}
	if want := "/4.0000"; !contains(ptsExpr, want) {
		t.Errorf("setpts %q lacks %q", ptsExpr, want)
	}
	if !contains(ptsExpr, "/TB") {
		t.Errorf("setpts %q must end in the time base", ptsExpr)
	}
}

func contains(text, part string) bool {
	for index := 0; index+len(part) <= len(text); index++ {
		if text[index:index+len(part)] == part {
			return true
		}
	}
	return false
}

// splitTop splits at a separator outside parentheses.
func splitTop(text string, separator byte) []string {
	var parts []string
	depth, start := 0, 0
	for index := 0; index < len(text); index++ {
		switch text[index] {
		case '(':
			depth++
		case ')':
			depth--
		case separator:
			if depth == 0 {
				parts = append(parts, text[start:index])
				start = index + 1
			}
		}
	}
	return append(parts, text[start:])
}
