package edit

import (
	"fmt"
	"slices"

	"github.com/aperture/aperture/internal/recording/timeline"
)

// maxRipples bounds the ripples of one video; each is a filter of its own.
const maxRipples = 200

// ripple is one click to mark, in the source frame.
type ripple struct {
	tMs  int64
	x, y float64
}

// ripples lists the clicks of the rippled click gestures, in time order, scaled
// to the source frame. Input sent through the debugging protocol has no click
// points and makes no ripple; skipped counts the rippled gestures of that kind.
func ripples(tl *timeline.Timeline, scales []segmentScale) (list []ripple, skipped int) {
	for _, gesture := range tl.Gestures {
		if gesture.Kind != "click" || !gesture.Ripple {
			continue
		}
		if len(gesture.Clicks) == 0 {
			skipped++
			continue
		}
		scale := scaleFor(scales, gesture.Segment)
		for _, click := range gesture.Clicks {
			x, y := scale.apply(click.X, click.Y)
			list = append(list, ripple{tMs: click.TMs, x: x, y: y})
		}
	}
	slices.SortStableFunc(list, func(a, b ripple) int { return int(a.tMs - b.tMs) })
	return list, skipped
}

// The ripple is a white ring with a dark halo outside it, so it shows on a light
// page, on a dark one and on a blue or red button alike. It changes the picture's
// luma only: over a coloured button the ring is a lighter shade of it and the
// halo a darker one, which keeps the filter short (a video may have a hundred
// ripples) and cheap to run. Y values are limited range.
const (
	rippleWhiteLuma = 235.0
	rippleDarkLuma  = 24.0
	// rippleWhiteAlpha and rippleDarkAlpha are the rings' strength at the start,
	// when they fade from.
	rippleWhiteAlpha = 0.95
	rippleDarkAlpha  = 0.65
)

// filter returns the geq filter that draws one ripple: a ring that spreads from the
// click point and fades. geq only computes the ring for pixels within its reach
// and passes the rest through; the filter is enabled only while the ripple is on
// screen, and costs nothing otherwise.
func (r ripple) filter(width, height, fps int) string {
	scale := float64(width) / 1280
	final := rippleRadius * scale
	start := final * 0.3
	softness := 3.5 * scale
	// The halo sits just outside the ring.
	gap := 2.6 * scale
	reach := final + gap + 3*softness
	duration := float64(rippleDurationMs) / 1000
	begin := float64(r.tMs) / 1000
	// The variables hold the progress, the distance from the ring, and the two alphas.
	dx := fmt.Sprintf("X-%.1f", r.x)
	dy := fmt.Sprintf("Y-%.1f", r.y)
	luma := fmt.Sprintf("lum='if(gt(abs(%s),%.0f)+gt(abs(%s),%.0f),lum(X,Y),"+
		"st(0,clip((T-%.3f)/%.1f,0,1));st(1,hypot(%s,%s)-%.1f-%.1f*(1-pow(1-ld(0),2)));"+
		"st(2,%.2f*(1-ld(0))*exp(-pow(ld(1)/%.1f,2)));st(3,%.2f*(1-ld(0))*exp(-pow((ld(1)-%.1f)/%.1f,2)));"+
		"(lum(X,Y)+(%.0f-lum(X,Y))*ld(3))*(1-ld(2))+%.0f*ld(2))'",
		dx, reach, dy, reach,
		begin, duration, dx, dy, start, final-start,
		rippleWhiteAlpha, softness, rippleDarkAlpha, gap, softness,
		rippleDarkLuma, rippleWhiteLuma)
	// The window opens and closes between two frames.
	from := begin - 0.5/float64(fps)
	to := begin + duration + 0.5/float64(fps)
	return fmt.Sprintf("geq=%s:cb='cb(X,Y)':cr='cr(X,Y)':enable='between(t,%.3f,%.3f)'", luma, from, to)
}
