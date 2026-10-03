package browser

import "time"

// automationCadence is how visibly browser automation acts: immediate keeps raw
// CDP behavior, recorded and presentation replace it with real, followable input.
type automationCadence int

const (
	cadenceImmediate automationCadence = iota
	cadenceRecorded
	cadencePresentation
)

const (
	automationPacingNormal    = "normal"
	automationPacingWatchable = "watchable"
)

// cadenceTiming holds the pacing of one non-immediate cadence.
type cadenceTiming struct {
	glideSpeed float64       // pointer travel in surface px per second
	glideMin   time.Duration // shortest glide that still gets eased frames
	glideMax   time.Duration
	dwell      time.Duration // pointer rest between arriving and pressing
	hold       time.Duration // button held down before release
}

// Every automation timing lives here so it can be tuned in one place.
var (
	recordedTiming     = cadenceTiming{glideSpeed: 1200, glideMin: 120 * time.Millisecond, glideMax: 1200 * time.Millisecond, dwell: 60 * time.Millisecond, hold: 45 * time.Millisecond}
	presentationTiming = cadenceTiming{glideSpeed: 800, glideMin: 150 * time.Millisecond, glideMax: 1500 * time.Millisecond, dwell: 150 * time.Millisecond, hold: 45 * time.Millisecond}
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
	if c == cadencePresentation {
		return presentationTiming
	}
	return recordedTiming
}

// resolveAutomationCadence is the whole cadence rule: a presentation recording wins, then any
// recording or watchable editor, otherwise automation runs at full speed.
func resolveAutomationCadence(recording, presentation, watchable bool) automationCadence {
	switch {
	case presentation:
		return cadencePresentation
	case recording || watchable:
		return cadenceRecorded
	default:
		return cadenceImmediate
	}
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
	return resolveAutomationCadence(session.activeRecordings.Load() > 0, session.presentationRecordings.Load() > 0, session.hasWatchableClient())
}
