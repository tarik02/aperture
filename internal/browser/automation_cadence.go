package browser

import (
	"time"

	"github.com/aperture/aperture/internal/recording"
)

// automationCadence is how visibly browser automation acts: immediate keeps raw CDP behavior; the
// paced cadences replace it with real compositor input, the pointer jumping (instant) or
// travelling in Fitts's-law time (fast, slow). They are ordered, so the slowest one asked for wins.
type automationCadence int

const (
	cadenceImmediate automationCadence = iota
	cadenceInstant
	cadenceFast
	cadenceSlow
)

const (
	automationPacingNormal    = "normal"
	automationPacingWatchable = "watchable"
)

// cadenceTiming holds the pacing of one paced cadence. Pointer travel to a target of width W at
// distance D takes fittsA + fittsB * log2(D/W + 1), clamped to glideMin..glideMax; a zero glideMax
// means the pointer jumps.
type cadenceTiming struct {
	fittsA   time.Duration // reaction and settle time every movement pays
	fittsB   time.Duration // time per bit of difficulty
	glideMin time.Duration // shortest glide that still gets eased frames
	glideMax time.Duration
	dwell    time.Duration // pointer rest between arriving and pressing
	hold     time.Duration // button held down before release
}

// Every automation timing lives here so it can be tuned in one place.
//
// The Fitts constants sit at the slow end of measured human mouse pointing (a ≈ 0.1-0.2 s,
// b ≈ 0.1-0.2 s/bit), so a viewer can follow the pointer: slow takes ~0.3 s for an easy hop
// (ID 1) and ~0.85 s across a 1000 px page to a 40 px button (ID ≈ 4.7). Fast is half of slow
// throughout, which matches the 1200 px/s glide that recordings used before. The bounds keep a tiny
// nudge visible and a far jump from dragging on.
var (
	instantTiming = cadenceTiming{dwell: 0, hold: 30 * time.Millisecond}
	fastTiming    = cadenceTiming{fittsA: 75 * time.Millisecond, fittsB: 75 * time.Millisecond, glideMin: 100 * time.Millisecond, glideMax: 700 * time.Millisecond, dwell: 75 * time.Millisecond, hold: 45 * time.Millisecond}
	slowTiming    = cadenceTiming{fittsA: 150 * time.Millisecond, fittsB: 150 * time.Millisecond, glideMin: 200 * time.Millisecond, glideMax: 1400 * time.Millisecond, dwell: 150 * time.Millisecond, hold: 45 * time.Millisecond}
)

const (
	glideFrameInterval = 16 * time.Millisecond
	// Chromium counts clicks of real input itself, so an unrelated second click at the same spot
	// must wait out its double-click window.
	dblclickGuardWindow   = 600 * time.Millisecond
	dblclickGuardDistance = 8.0
	// The wait after a synthetic drag move for Chromium to report Input.dragIntercepted.
	dragInterceptWindow = 60 * time.Millisecond
	// Page round trips made around input must not outlive a page that is blocked by a dialog.
	pageProbeTimeout = time.Second
	deliveryBarrier  = 250 * time.Millisecond

	wheelStepInterval = 50 * time.Millisecond
	wheelBaseDuration = 120 * time.Millisecond
	wheelMaxDuration  = 900 * time.Millisecond
	wheelMsPerPx      = 0.6

	revealPollInterval = 30 * time.Millisecond
	revealStableRuns   = 3
	revealStartGrace   = 250 * time.Millisecond
	revealMaxDuration  = 5 * time.Second
)

func (c automationCadence) timing() cadenceTiming {
	switch c {
	case cadenceInstant:
		return instantTiming
	case cadenceSlow:
		return slowTiming
	default:
		return fastTiming
	}
}

// paceCadence is the cadence a recording's pace asks for.
func paceCadence(pace string) automationCadence {
	switch pace {
	case recording.PaceInstant:
		return cadenceInstant
	case recording.PaceSlow:
		return cadenceSlow
	default:
		return cadenceFast
	}
}

// resolveAutomationCadence is the whole cadence rule: the slowest pace of the running recordings,
// at least fast while a connected client watches, otherwise automation runs at full speed.
func resolveAutomationCadence(recordings automationCadence, watchable bool) automationCadence {
	if watchable {
		return max(recordings, cadenceFast)
	}
	return recordings
}

// hasWatchableClient reports whether a connected client asked for automation it can follow; only
// owners and editors can ask.
func (session *liveSession) hasWatchableClient() bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	for _, client := range session.clients {
		if client.watchable.Load() {
			return true
		}
	}
	return false
}

// automationCadence is evaluated for every intercepted command, so it takes no runtime lock.
func (session *liveSession) automationCadence() automationCadence {
	return resolveAutomationCadence(automationCadence(session.recordingCadence.Load()), session.hasWatchableClient())
}

// automationMotion is the natural motion of the recording that sets the pace, nil for linear paths.
func (session *liveSession) automationMotion() *naturalMotion {
	return session.recordingMotion.Load()
}
