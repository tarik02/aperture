package edit

import (
	"strings"
	"testing"

	"github.com/aperture/aperture/internal/recording/timeline"
)

func TestReadingTime(t *testing.T) {
	if got := readingTime("Hi"); got != captionMinMs {
		t.Errorf("a short caption stays %d ms, got %d", captionMinMs, got)
	}
	if got := readingTime(strings.Repeat("x", 40)); got != 2600 {
		t.Errorf("40 characters: %d", got)
	}
	if got := readingTime(strings.Repeat("x", 500)); got != 5000 {
		t.Errorf("a long caption stays five seconds at most, got %d", got)
	}
	// Characters, not bytes.
	if got := readingTime(strings.Repeat("字", 40)); got != 2600 {
		t.Errorf("40 wide characters: %d", got)
	}
}

func TestBuildCuesExtendsClampsAndDropsCaptions(t *testing.T) {
	cues := buildCues([]timeline.Caption{
		{StartMs: 2000, EndMs: 2100, Text: "second"},
		{StartMs: 500, EndMs: 600, Text: "first"},
		{StartMs: 4000, EndMs: 4100, Text: "  \n "},
		{StartMs: 9500, EndMs: 9600, Text: "late"},
		{StartMs: 20000, EndMs: 20100, Text: "after the video"},
		{StartMs: 2000, EndMs: 2000, Text: "replaced at once"},
	}, 10000)
	if len(cues) != 3 {
		t.Fatalf("cues %+v", cues)
	}
	// Sorted, each shown for its reading time unless the next one comes first.
	if cues[0].Text != "first" || cues[0].StartMs != 500 || cues[0].EndMs != 1700 {
		t.Errorf("first %+v", cues[0])
	}
	if cues[1].Text != "replaced at once" && cues[1].Text != "second" {
		t.Errorf("second %+v", cues[1])
	}
	last := cues[len(cues)-1]
	if last.Text != "late" || last.EndMs != 10000 {
		t.Errorf("a caption near the end is cut at the end of the video: %+v", last)
	}
	for index := 1; index < len(cues); index++ {
		if cues[index].StartMs < cues[index-1].EndMs {
			t.Errorf("cues overlap: %+v", cues)
		}
	}
}

func TestBuildCuesWithNothingToShow(t *testing.T) {
	if cues := buildCues(nil, 1000); len(cues) != 0 {
		t.Errorf("cues %+v", cues)
	}
}

func TestMapCuesFollowsTheTimeMapAndDropsCutCues(t *testing.T) {
	m := newTimeMap([]Piece{
		{SrcStart: 0, SrcEnd: 2000, Speed: 1},
		{SrcStart: 6000, SrcEnd: 9000, Speed: 1},
	})
	mapped := mapCues([]Cue{
		{StartMs: 500, EndMs: 1500, Text: "kept"},
		{StartMs: 3000, EndMs: 5000, Text: "cut"},
		{StartMs: 7000, EndMs: 8000, Text: "later"},
	}, m)
	if len(mapped) != 2 || mapped[0].StartMs != 500 || mapped[1].StartMs != 3000 || mapped[1].EndMs != 4000 {
		t.Errorf("mapped %+v", mapped)
	}
}

func TestEscapeASSKeepsTextLiteral(t *testing.T) {
	for _, test := range []struct{ in, want string }{
		{"plain", "plain"},
		{"a{b}c", `a\{b\}c`},
		{`{\an8}top`, `\{＼an8\}top`},
		{`back\slash`, "back＼slash"},
		{"two\nlines", `two\Nlines`},
		{"comma, and: colon", "comma, and: colon"},
		{"emoji 🙂 and 日本語", "emoji 🙂 and 日本語"},
	} {
		if got := escapeASS(test.in); got != test.want {
			t.Errorf("escapeASS(%q) = %q, want %q", test.in, got, test.want)
		}
	}
}

func TestMarshalASSDescribesTheFrameAndEveryCue(t *testing.T) {
	script := string(marshalASS([]Cue{
		{StartMs: 1234, EndMs: 5678, Text: "Hello {world}"},
		{StartMs: 3723450, EndMs: 3725000, Text: "line one\nline two"},
	}, 1280, 720))
	for _, part := range []string{
		"PlayResX: 1280", "PlayResY: 720", "Style: Default,Noto Sans,32,",
		"Dialogue: 0,0:00:01.23,0:00:05.67,Default,,0,0,0,,Hello \\{world\\}",
		"Dialogue: 0,1:02:03.45,1:02:05.00,Default,,0,0,0,,line one\\Nline two",
	} {
		if !strings.Contains(script, part) {
			t.Errorf("script lacks %q:\n%s", part, script)
		}
	}
	// The box near the bottom edge: alignment 2, margin 6% of the height.
	if !strings.Contains(script, ",3,6,0,2,77,77,43,1") {
		t.Errorf("style line: %s", script)
	}
}
