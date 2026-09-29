package edit

import (
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/aperture/aperture/internal/recording/timeline"
)

// Cue is a caption to show from StartMs to EndMs.
type Cue struct {
	StartMs int64  `json:"startMs"`
	EndMs   int64  `json:"endMs"`
	Text    string `json:"text"`
}

// readingTime is how long a caption stays on screen at least: a second and
// something for every character, so a longer text can be read, but never less
// than captionMinMs nor more than five seconds.
func readingTime(text string) int64 {
	return min(max(1000+40*int64(utf8.RuneCountInString(text)), captionMinMs), 5000)
}

// buildCues prepares the timeline's captions for showing: empty ones are dropped,
// each stays on screen for at least its reading time, and an end that runs into
// the next cue's start, or past the video, is cut back. The cues are on the raw
// video's clock.
func buildCues(captions []timeline.Caption, total int64) []Cue {
	cues := make([]Cue, 0, len(captions))
	for _, caption := range captions {
		text := normalizeCueText(caption.Text)
		if text == "" || caption.StartMs >= total {
			continue
		}
		start := max(caption.StartMs, 0)
		cues = append(cues, Cue{StartMs: start, EndMs: max(caption.EndMs, start+readingTime(text)), Text: text})
	}
	slices.SortStableFunc(cues, func(a, b Cue) int { return int(a.StartMs - b.StartMs) })
	out := make([]Cue, 0, len(cues))
	for index, cue := range cues {
		cue.EndMs = min(cue.EndMs, total)
		if index+1 < len(cues) {
			cue.EndMs = min(cue.EndMs, cues[index+1].StartMs)
		}
		// A cue that the next one replaces at the same moment never shows.
		if cue.EndMs <= cue.StartMs {
			continue
		}
		out = append(out, cue)
	}
	return out
}

// normalizeCueText trims the text and its lines and drops blank lines.
func normalizeCueText(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	lines := strings.Split(text, "\n")
	kept := lines[:0]
	for _, line := range lines {
		if line = strings.TrimSpace(line); line != "" {
			kept = append(kept, line)
		}
	}
	return strings.Join(kept, "\n")
}

// mapCues moves cues to the edited video's clock. A cue that the map cuts out
// entirely is dropped.
func mapCues(cues []Cue, timeMap TimeMap) []Cue {
	out := make([]Cue, 0, len(cues))
	for _, cue := range cues {
		start, end := timeMap.MapSpan(cue.StartMs, cue.EndMs)
		if end <= start {
			continue
		}
		cue.StartMs, cue.EndMs = start, end
		out = append(out, cue)
	}
	return out
}

// marshalASS writes cues as an ASS script for a frame of width x height, for the
// ass filter to burn in: white text on a mostly opaque dark box near the bottom edge,
// sized to the frame. The style is set here, so it does not depend on the
// renderer's defaults.
func marshalASS(cues []Cue, width, height int) []byte {
	size := max(round(float64(height)*0.045), 12)
	marginV := round(float64(height) * 0.06)
	marginH := round(float64(width) * 0.06)
	padding := max(round(float64(height)*0.008), 2)
	var out strings.Builder
	fmt.Fprintf(&out, "[Script Info]\nScriptType: v4.00+\nPlayResX: %d\nPlayResY: %d\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n", width, height)
	out.WriteString("[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n")
	// BorderStyle 3 draws the outline colour as an opaque box behind the text.
	fmt.Fprintf(&out, "Style: Default,Noto Sans,%d,&H00FFFFFF,&H00FFFFFF,&H30000000,&H30000000,0,0,0,0,100,100,0,0,3,%d,0,2,%d,%d,%d,1\n\n", size, padding, marginH, marginH, marginV)
	out.WriteString("[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
	for _, cue := range cues {
		fmt.Fprintf(&out, "Dialogue: 0,%s,%s,Default,,0,0,0,,%s\n", assTime(cue.StartMs), assTime(cue.EndMs), escapeASS(cue.Text))
	}
	return []byte(out.String())
}

func round(value float64) int {
	return int(value + 0.5)
}

// assTime formats a time the way ASS scripts write it, in centiseconds.
func assTime(ms int64) string {
	return fmt.Sprintf("%d:%02d:%02d.%02d", ms/3600000, ms/60000%60, ms/1000%60, ms%1000/10)
}

// escapeASS makes text safe to show as it is. A backslash would start an
// override tag and has no escape of its own, so it becomes the fullwidth
// reverse solidus; braces are escaped, and a newline becomes ASS's.
func escapeASS(text string) string {
	text = strings.NewReplacer(`\`, "＼", "{", `\{`, "}", `\}`).Replace(text)
	return strings.ReplaceAll(text, "\n", `\N`)
}
