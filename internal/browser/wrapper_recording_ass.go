package browser

import (
	"fmt"
	"slices"
	"strings"
)

const (
	assReferenceWidth  = 1280.0
	captionFontRatio   = 0.045
	captionMarginRatio = 0.06
	captionBoxRatio    = 0.008
	rippleRadius       = 48.0
)

type cue struct {
	start, end int64
	text       string
}

func sanitizeCaption(e journalEntry) string {
	text, _ := e["text"].(string)
	return strings.Join(strings.Fields(text), " ")
}

// fitCues keeps cues inside the video and ends each where the next begins.
func fitCues(cues []cue, total int64) []cue {
	slices.SortStableFunc(cues, func(a, b cue) int { return int(a.start - b.start) })
	for i := range cues {
		cues[i].end = min(cues[i].end, total)
		if i+1 < len(cues) {
			cues[i].end = min(cues[i].end, cues[i+1].start)
		}
	}
	return slices.DeleteFunc(cues, func(c cue) bool { return c.end <= c.start || c.text == "" })
}

// ripple is a click: the edited time it happens and where, in frame px.
type ripple struct {
	start int64
	x, y  float64
}

// marshalASS writes the cues and ripples as an ASS script for the ass filter. A cue is white text
// on a dark box near the bottom edge; a backslash would start an override tag, so it becomes the
// fullwidth one, and braces are escaped. A ripple is a ring, drawn as a vector shape, that spreads
// from the click and fades; its dark shadow shows it on light pages.
func marshalASS(cues []cue, ripples []ripple, width, height int) []byte {
	size := max(int(float64(height)*captionFontRatio+0.5), 12)
	margin := int(float64(width)*captionMarginRatio + 0.5)
	box := max(int(float64(height)*captionBoxRatio+0.5), 2)
	var out strings.Builder
	fmt.Fprintf(&out, "[Script Info]\nScriptType: v4.00+\nPlayResX: %d\nPlayResY: %d\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n", width, height)
	out.WriteString("[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n")
	// BorderStyle 3 draws the outline colour as a box behind the text.
	fmt.Fprintf(&out, "Style: Default,Noto Sans,%d,&H00FFFFFF,&H00FFFFFF,&H30000000,&H30000000,0,0,0,0,100,100,0,0,3,%d,0,2,%d,%d,%d,1\n", size, box, margin, margin, int(float64(height)*captionMarginRatio+0.5))
	out.WriteString("Style: Ripple,Noto Sans,20,&HFF000000,&HFF000000,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,1,1,0,5,0,0,0,1\n\n")
	out.WriteString("[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
	escape := strings.NewReplacer(`\`, "＼", "{", `\{`, "}", `\}`)
	stamp := func(ms int64) string {
		return fmt.Sprintf("%d:%02d:%02d.%02d", ms/3600000, ms/60000%60, ms/1000%60, ms%1000/10)
	}
	for _, c := range cues {
		fmt.Fprintf(&out, "Dialogue: 0,%s,%s,Default,,0,0,0,,%s\n", stamp(c.start), stamp(c.end), escape.Replace(strings.ToValidUTF8(c.text, "")))
	}
	// A circle of radius 100 drawn with four curves, in the positive quarter so that libass centres it on the click.
	const circle = "m 0 100 b 0 45 45 0 100 0 b 155 0 200 45 200 100 b 200 155 155 200 100 200 b 45 200 0 155 0 100"
	scale := float64(width) / assReferenceWidth * rippleRadius
	for _, r := range ripples {
		fmt.Fprintf(&out, "Dialogue: 1,%s,%s,Ripple,,0,0,0,,{\\an5\\pos(%.0f,%.0f)\\bord%.1f\\shad%.1f\\4c&H000000&\\fscx%.0f\\fscy%.0f\\t(0,%d,0.4,\\fscx%.0f\\fscy%.0f)\\t(%d,%d,\\3a&HFF&\\4a&HFF&)\\p1}%s\n",
			stamp(r.start), stamp(r.start+rippleMS), r.x, r.y, 5*float64(width)/assReferenceWidth, 3*float64(width)/assReferenceWidth,
			scale*0.3, scale*0.3, rippleMS, scale, scale, rippleMS/2, rippleMS, circle)
	}
	return []byte(out.String())
}
