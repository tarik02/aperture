package pointer

import (
	"encoding/json"
	"math"
	"testing"
	"time"
)

func TestMotionJSON(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    Motion
		wantErr bool
	}{
		{name: "natural", input: `"natural"`, want: Motion{Kind: KindNatural}},
		{name: "fast", input: `"fast"`, want: Motion{Kind: KindFast}},
		{name: "instant", input: `"instant"`, want: Motion{Kind: KindInstant}},
		{name: "speed", input: `{"speed": 800}`, want: Motion{Kind: KindSpeed, Speed: 800}},
		{name: "duration", input: `{"durationMs": 250}`, want: Motion{Kind: KindDuration, Duration: 250 * time.Millisecond}},
		{name: "zero duration", input: `{"durationMs": 0}`, want: Motion{Kind: KindDuration}},
		{name: "unknown preset", input: `"slow"`, wantErr: true},
		{name: "bare speed", input: `"speed"`, wantErr: true},
		{name: "speed too low", input: `{"speed": 1}`, wantErr: true},
		{name: "duration too long", input: `{"durationMs": 60000}`, wantErr: true},
		{name: "negative duration", input: `{"durationMs": -1}`, wantErr: true},
		{name: "both keys", input: `{"speed": 500, "durationMs": 100}`, wantErr: true},
		{name: "unknown key", input: `{"velocity": 500}`, wantErr: true},
		{name: "number", input: `12`, wantErr: true},
		{name: "text speed", input: `{"speed": "fast"}`, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var got Motion
			err := json.Unmarshal([]byte(test.input), &got)
			if test.wantErr {
				if err == nil {
					t.Fatalf("Unmarshal(%s) = %+v, want error", test.input, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("Unmarshal(%s) error = %v", test.input, err)
			}
			if got != test.want {
				t.Fatalf("Unmarshal(%s) = %+v, want %+v", test.input, got, test.want)
			}
			encoded, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			var roundTrip Motion
			if err := json.Unmarshal(encoded, &roundTrip); err != nil || roundTrip != got {
				t.Fatalf("round trip of %s = %+v, %v", encoded, roundTrip, err)
			}
		})
	}
}

func TestResolvePrecedence(t *testing.T) {
	fast := &Motion{Kind: KindFast}
	instant := &Motion{Kind: KindInstant}
	speed := &Motion{Kind: KindSpeed, Speed: 500}
	tests := []struct {
		name                       string
		parameter, recording, sess *Motion
		want                       Motion
	}{
		{name: "nothing set", want: Natural},
		{name: "session only", sess: speed, want: *speed},
		{name: "recording beats session", recording: instant, sess: speed, want: *instant},
		{name: "parameter beats all", parameter: fast, recording: instant, sess: speed, want: *fast},
		{name: "unset values are skipped", parameter: &Motion{}, recording: nil, sess: speed, want: *speed},
	}
	for _, test := range tests {
		if got := Resolve(test.parameter, test.recording, test.sess); got != test.want {
			t.Errorf("%s: Resolve = %+v, want %+v", test.name, got, test.want)
		}
	}
}

func TestTravelDuration(t *testing.T) {
	tests := []struct {
		name     string
		motion   Motion
		distance float64
		want     time.Duration
	}{
		{name: "already there", motion: Natural, distance: 0.1, want: 0},
		{name: "natural short move takes the minimum", motion: Natural, distance: 20, want: naturalMinDuration},
		{name: "natural at 1200 px/s", motion: Natural, distance: 600, want: 500 * time.Millisecond},
		{name: "natural long move is capped", motion: Natural, distance: 20000, want: naturalMaxDuration},
		{name: "fast is quicker", motion: Motion{Kind: KindFast}, distance: 640, want: 200 * time.Millisecond},
		{name: "fast is capped", motion: Motion{Kind: KindFast}, distance: 20000, want: fastMaxDuration},
		{name: "instant jumps", motion: Motion{Kind: KindInstant}, distance: 900, want: 0},
		{name: "speed", motion: Motion{Kind: KindSpeed, Speed: 500}, distance: 250, want: 500 * time.Millisecond},
		{name: "fixed duration", motion: Motion{Kind: KindDuration, Duration: 750 * time.Millisecond}, distance: 3, want: 750 * time.Millisecond},
	}
	for _, test := range tests {
		if got := test.motion.TravelDuration(test.distance); got != test.want {
			t.Errorf("%s: TravelDuration(%g) = %s, want %s", test.name, test.distance, got, test.want)
		}
	}
}

func TestEaseIsMonotonicAndBounded(t *testing.T) {
	for _, motion := range []Motion{Natural, {Kind: KindFast}, {Kind: KindSpeed, Speed: 300}} {
		if motion.Ease(0) != 0 || math.Abs(motion.Ease(1)-1) > 1e-9 {
			t.Fatalf("%s ease endpoints = %g, %g", motion.Kind, motion.Ease(0), motion.Ease(1))
		}
		if got := motion.Ease(0.5); math.Abs(got-0.5) > 1e-9 {
			t.Fatalf("%s ease midpoint = %g, want 0.5", motion.Kind, got)
		}
		previous := 0.0
		for step := 1; step <= 100; step++ {
			value := motion.Ease(float64(step) / 100)
			if value < previous {
				t.Fatalf("%s ease decreased at step %d: %g < %g", motion.Kind, step, value, previous)
			}
			previous = value
		}
		// Ease-in-out starts and ends slowly.
		if motion.Ease(0.1) >= 0.1 || motion.Ease(0.9) <= 0.9 {
			t.Fatalf("%s ease is not ease-in-out", motion.Kind)
		}
	}
}

func TestPathEndpointsAndCurve(t *testing.T) {
	from := Point{X: 100, Y: 100}
	to := Point{X: 700, Y: 400}
	path := NewPath(from, to, Natural)
	if got := path.At(0); got != from {
		t.Fatalf("At(0) = %+v, want %+v", got, from)
	}
	if got := path.At(1); got != to {
		t.Fatalf("At(1) = %+v, want %+v", got, to)
	}
	if again := NewPath(from, to, Natural); again != path {
		t.Fatal("path is not deterministic")
	}

	// The natural path bows away from the straight line but stays close to it.
	length := from.Distance(to)
	maxDeviation := 0.0
	for step := 1; step < 100; step++ {
		point := path.At(float64(step) / 100)
		deviation := math.Abs((to.X-from.X)*(from.Y-point.Y)-(from.X-point.X)*(to.Y-from.Y)) / length
		maxDeviation = max(maxDeviation, deviation)
	}
	if maxDeviation < 1 {
		t.Fatalf("natural path is a straight line (max deviation %.2f px)", maxDeviation)
	}
	if maxDeviation > 40 {
		t.Fatalf("natural path strays %.2f px from the line", maxDeviation)
	}

	straight := NewPath(from, to, Motion{Kind: KindInstant})
	for step := 1; step < 100; step++ {
		point := straight.At(float64(step) / 100)
		deviation := math.Abs((to.X-from.X)*(from.Y-point.Y)-(from.X-point.X)*(to.Y-from.Y)) / length
		if deviation > 1e-6 {
			t.Fatalf("instant path deviates %.6f px from the line", deviation)
		}
	}

	short := NewPath(Point{X: 10, Y: 10}, Point{X: 14, Y: 12}, Natural)
	if mid := short.At(0.5); math.Abs(mid.X-12) > 1e-6 || math.Abs(mid.Y-11) > 1e-6 {
		t.Fatalf("short move should stay straight, midpoint = %+v", mid)
	}
}

func TestBoundedPathStaysInsideBoundsAndKeepsCurving(t *testing.T) {
	bounds := Bounds{MinX: 0, MinY: 0, MaxX: 1279, MaxY: 719}
	cases := []struct{ from, to Point }{
		{Point{X: 0, Y: 0}, Point{X: 1279, Y: 0}},
		{Point{X: 3, Y: 300}, Point{X: 3, Y: 700}},
		{Point{X: 1279, Y: 719}, Point{X: 10, Y: 719}},
		{Point{X: 0, Y: 360}, Point{X: 0, Y: 5}},
		{Point{X: 640, Y: 0}, Point{X: 900, Y: 0}},
	}
	for _, motion := range []Motion{Natural, {Kind: KindFast}} {
		for _, c := range cases {
			path := NewBoundedPath(c.from, c.to, motion, bounds)
			maxDeviation := 0.0
			length := c.from.Distance(c.to)
			for step := 0; step <= 200; step++ {
				p := path.At(float64(step) / 200)
				if p.X < 0 || p.Y < 0 || p.X > 1279 || p.Y > 719 {
					t.Fatalf("%s %+v: point %+v left the bounds", motion.Kind, c, p)
				}
				dev := math.Abs((c.to.X-c.from.X)*(c.from.Y-p.Y)-(c.from.X-p.X)*(c.to.Y-c.from.Y)) / length
				maxDeviation = max(maxDeviation, dev)
			}
			if motion.Kind == KindNatural && maxDeviation < 1 {
				t.Fatalf("%+v: bounded path flattened to a line (deviation %.2f)", c, maxDeviation)
			}
		}
	}
}

func TestBoundedPathKeepsEndpointsOutsideBounds(t *testing.T) {
	bounds := Bounds{MaxX: 100, MaxY: 100}
	to := Point{X: 100.5, Y: 50}
	path := NewBoundedPath(Point{X: 10, Y: 10}, to, Natural, bounds)
	if got := path.At(1); got != to {
		t.Fatalf("At(1) = %+v, want %+v", got, to)
	}
}
