package browser

import (
	"errors"
	"fmt"
	"slices"
	"time"
)

// A bursts recording records continuously like any other and, when it is stopped
// through the API, keeps only the stretches around the actions in its timeline.
const burstMaxMs = 60_000

const (
	burstDefaultLeadMs    = 150
	burstDefaultTailMs    = 250
	burstDefaultSettleMs  = 200
	burstDefaultMaxTailMs = 1200
)

// RecordingBurst says how much of the recording is kept around each action, in
// milliseconds: LeadMs before it starts, TailMs after it ends, then until the screen
// has been still for SettleMs, but no more than MaxTailMs after it ends. A setting
// that is not given has its default (150, 250, 200, and 1200 or TailMs if more).
type RecordingBurst struct {
	LeadMs    *int `json:"leadMs,omitempty"`
	TailMs    *int `json:"tailMs,omitempty"`
	SettleMs  *int `json:"settleMs,omitempty"`
	MaxTailMs *int `json:"maxTailMs,omitempty"`
}

func (b RecordingBurst) times() (lead, tail, settle, maxTail int64) {
	or := func(v *int, def int) int64 {
		if v == nil {
			return int64(def)
		}
		return int64(*v)
	}
	tail = or(b.TailMs, burstDefaultTailMs)
	return or(b.LeadMs, burstDefaultLeadMs), tail, or(b.SettleMs, burstDefaultSettleMs), or(b.MaxTailMs, max(burstDefaultMaxTailMs, int(tail)))
}

// validateBursts checks a recording's capture mode, and the burst settings that go with it.
func validateBursts(capture string, burst *RecordingBurst, idle string) error {
	if capture != "bursts" {
		if capture != "" && capture != "continuous" {
			return errors.New(`capture must be "continuous" or "bursts"`)
		}
		if burst != nil {
			return errors.New(`burst needs capture "bursts"`)
		}
		return nil
	}
	if idle != "" {
		return errors.New(`idle cannot be combined with capture "bursts": bursts already cut everything but the actions`)
	}
	if burst == nil {
		return nil
	}
	for _, v := range []*int{burst.LeadMs, burst.TailMs, burst.SettleMs, burst.MaxTailMs} {
		if v != nil && (*v < 0 || *v > burstMaxMs) {
			return fmt.Errorf("burst times must be from 0 to %d ms", burstMaxMs)
		}
	}
	if _, tail, _, maxTail := burst.times(); maxTail < tail {
		return errors.New("burst maxTailMs must not be less than tailMs")
	}
	return nil
}

// burstPieces are the stretches of the video that a bursts recording keeps: around
// each successful action a lead, the action, and a tail that lasts until the screen
// settles, all clamped to the video. Failed calls stay in the diagnostic timeline but
// do not make a presentation freeze around an action that never happened. Stretches
// that overlap or are no more than gap apart merge.
func burstPieces(doc timelineDoc, burst RecordingBurst, gap int64) []piece {
	lead, tail, settle, maxTail := burst.times()
	// With too many spans to hold them all, quiet does not mean still.
	watched := doc.Activity.Complete && len(doc.Activity.Spans) < timelineMaxSpans
	var keep []span
	for _, action := range doc.Actions {
		if !action.OK {
			continue
		}
		end := action.End + tail
		if watched {
			// The first moment after the tail with no change in the last settle ms.
			still := end
			for _, a := range doc.Activity.Spans { // in time order
				if a.End > still-settle && a.Start <= still {
					still = a.End + settle
				}
			}
			end = min(still, action.End+maxTail)
		}
		keep = append(keep, span{max(action.Start-lead, 0), min(end, doc.DurationMS)})
	}
	slices.SortFunc(keep, func(a, b span) int { return int(a.start - b.start) })
	var pieces []piece
	for _, k := range keep {
		if k.end <= k.start {
			continue
		}
		if n := len(pieces); n > 0 && k.start <= pieces[n-1].end+gap {
			pieces[n-1].end = max(pieces[n-1].end, k.end)
		} else {
			pieces = append(pieces, piece{k.start, k.end, 1})
		}
	}
	return pieces
}

// followTarget moves a bursts recording to the tab the latest action ended on, which
// may take a moment to become ready, and gives up quietly after a few seconds. One
// goroutine per recording does it, for whichever tab is wanted when it looks.
func (session *liveSession) followTarget(recording *wrapperRecording) {
	r := session.runtime
	deadline := time.Now().Add(5 * time.Second)
	for failed := false; ; {
		r.mu.Lock()
		want, registry := recording.followWant, r.targets
		if failed || recording.Status != wrapperRecordingRunning || recording.finalizing || recording.TargetID == want || time.Now().After(deadline) {
			recording.following = false
			r.mu.Unlock()
			return
		}
		r.mu.Unlock()
		_, err := session.retargetRecording(r.ctx, recording.ID, want)
		if failed = err != nil && !errors.Is(err, errTargetNotReady); failed || err == nil {
			continue
		}
		_ = registry.reconcileSettledWindows(r.ctx) // the tab may only be waiting to be noticed
		select {
		case <-r.ctx.Done():
			failed = true
		case <-time.After(100 * time.Millisecond):
		}
	}
}
