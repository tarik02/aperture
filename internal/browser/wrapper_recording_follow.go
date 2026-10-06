package browser

import (
	"context"
	"fmt"
	"time"

	"github.com/aperture/aperture/internal/recording"
)

func (session *liveSession) followsAutomation() bool {
	session.runtime.mu.Lock()
	defer session.runtime.mu.Unlock()
	for _, rec := range session.recordings {
		if rec.config.Capture == recording.CaptureBursts && rec.Status == wrapperRecordingRunning && !rec.stopping {
			return true
		}
	}
	return false
}

// prepareRecordingTarget runs inside the browser-call gate. New tabs must have their own
// compositor output and a captured frame before navigation or input can change their picture.
func (session *liveSession) prepareRecordingTarget(ctx context.Context, targetID string) error {
	r := session.runtime
	r.mu.Lock()
	var ids []string
	for _, rec := range session.recordings {
		if rec.config.Capture == recording.CaptureBursts && rec.Status == wrapperRecordingRunning && !rec.stopping {
			ids = append(ids, rec.ID)
		}
	}
	registry := r.targets
	r.mu.Unlock()
	if len(ids) == 0 {
		return nil
	}
	if registry == nil {
		return fmt.Errorf("recording target registry is unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, liveSessionTargetReadyTimeout)
	defer cancel()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, ready := registry.readyTarget(targetID); ready {
			break
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("wait for recording target %s: %w", targetID, ctx.Err())
		case <-ticker.C:
		}
	}
	for _, id := range ids {
		if _, err := session.retargetRecording(ctx, id, targetID); err != nil {
			return fmt.Errorf("prepare recording %s: %w", id, err)
		}
	}
	return nil
}
