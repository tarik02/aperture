package browser

import (
	"errors"
	"fmt"
	"os"
	"slices"
	"time"
)

// A bursts recording records continuously like any other and, when it is stopped
// through the API, keeps only the stretches around the actions in its timeline.
const (
	burstMaxMs        = 60_000
	burstFollowTries  = 8
	burstFollowPeriod = 250 * time.Millisecond
)

// RecordingBurst says how much of the recording is kept around each action, in
// milliseconds: LeadMs before it starts, TailMs after it ends (or its gesture's
// hold, if longer), then until the screen has been still for SettleMs, but no more
// than MaxTailMs after it ends. A value of 0 is the default.
type RecordingBurst struct {
	LeadMs    int `json:"leadMs,omitempty"`
	TailMs    int `json:"tailMs,omitempty"`
	SettleMs  int `json:"settleMs,omitempty"`
	MaxTailMs int `json:"maxTailMs,omitempty"`
}

func (b RecordingBurst) withDefaults() RecordingBurst {
	fill := func(v *int, def int) {
		if *v == 0 {
			*v = def
		}
	}
	fill(&b.LeadMs, 400)
	fill(&b.TailMs, 600)
	fill(&b.SettleMs, 500)
	fill(&b.MaxTailMs, 4000)
	return b
}

// validateBursts checks a recording's capture mode, and the burst settings that go with it.
func validateBursts(capture string, burst *RecordingBurst, idle string) error {
	switch capture {
	case "", "continuous":
		if burst != nil {
			return errors.New(`burst needs capture "bursts"`)
		}
		return nil
	case "bursts":
	default:
		return errors.New(`capture must be "continuous" or "bursts"`)
	}
	if idle != "" {
		return errors.New(`idle cannot be combined with capture "bursts": bursts already cut everything but the actions`)
	}
	if burst == nil {
		return nil
	}
	b := burst.withDefaults()
	for _, v := range []int{burst.LeadMs, burst.TailMs, burst.SettleMs, burst.MaxTailMs} {
		if v < 0 || v > burstMaxMs {
			return fmt.Errorf("burst times must be from 0 to %d ms", burstMaxMs)
		}
	}
	if b.MaxTailMs < b.TailMs {
		return errors.New("burst maxTailMs must not be less than tailMs")
	}
	return nil
}

// burstPieces are the stretches of the video that a bursts recording keeps: around
// each action a lead, the action, and a tail that lasts until the screen settles, all
// clamped to the video, with overlapping or touching ones merged.
func burstPieces(doc timelineDoc, burst RecordingBurst, activity []span, complete bool) []piece {
	var keep []span
	for _, action := range doc.Actions {
		var hold int64
		for _, g := range doc.Gestures {
			if g.Start >= action.Start-gesturePadMs && g.Start <= action.End+gesturePadMs {
				hold = max(hold, g.Hold)
			}
		}
		lead, tail, settle, maxTail := int64(burst.LeadMs), int64(burst.TailMs), int64(burst.SettleMs), int64(burst.MaxTailMs)
		end := action.End + max(tail, hold)
		if complete {
			// The first moment after the tail with no change in the last settle ms.
			still := action.End + tail
			for _, a := range activity { // in time order
				if a.end > still-settle && a.start <= still {
					still = a.end + settle
				}
			}
			end = max(end, min(still, action.End+maxTail))
		}
		keep = append(keep, span{max(action.Start-lead, 0), min(end, doc.DurationMS)})
	}
	slices.SortFunc(keep, func(a, b span) int { return int(a.start - b.start) })
	var pieces []piece
	for _, k := range keep {
		if k.end <= k.start {
			continue
		}
		if n := len(pieces); n > 0 && k.start <= pieces[n-1].end {
			pieces[n-1].end = max(pieces[n-1].end, k.end)
		} else {
			pieces = append(pieces, piece{k.start, k.end, 1})
		}
	}
	return pieces
}

// followAction moves a bursts recording to the tab an action ended on, which may
// take a moment to become ready. A recording that cannot follow stays where it is.
func (session *liveSession) followAction(recordingID, targetID string) {
	var err error
	for i := 0; i < burstFollowTries; i++ {
		if _, err = session.retargetRecording(session.runtime.ctx, recordingID, targetID); err == nil || errors.Is(err, errWrapperRecordingNotFound) {
			return
		}
		time.Sleep(burstFollowPeriod)
	}
	fmt.Fprintf(os.Stderr, "browser-session-wrapper: recording %s cannot follow target %s: %v\n", recordingID, targetID, err)
}
