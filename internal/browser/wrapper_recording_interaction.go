package browser

import (
	"encoding/json"
	"errors"
	"sync"
	"time"
)

type recordingInteractionTempo uint8

const (
	recordingInteractionImmediate recordingInteractionTempo = iota
	recordingInteractionRecorded
	recordingInteractionPresentation
)

type recordingInteraction struct {
	session    *liveSession
	recordings []*wrapperRecording
	tempo      recordingInteractionTempo
	once       sync.Once
}

// beginRecordingInteraction pins the recordings that own a browser call and resolves
// the one tempo the live session's physical pointer can execute.
func (session *liveSession) beginRecordingInteraction() *recordingInteraction {
	interaction := &recordingInteraction{session: session}
	r := session.runtime
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, recording := range session.recordings {
		if recording.Status != wrapperRecordingRunning || recording.finalizing {
			continue
		}
		if recording.interactions == nil {
			recording.interactions = &sync.WaitGroup{}
		}
		recording.interactions.Add(1)
		interaction.recordings = append(interaction.recordings, recording)
		interaction.tempo = max(interaction.tempo, recordingInteractionRecorded)
		if recording.presentation {
			interaction.tempo = recordingInteractionPresentation
		}
	}
	return interaction
}

// recordTimeline keeps direct wrapper callers on the same admission path as browser
// calls. The Playwright adapter uses the scope directly so it can span execution.
func (session *liveSession) recordTimeline(meta map[string]any) {
	session.beginRecordingInteraction().finish(meta)
}

func (interaction *recordingInteraction) applyDefaults(tool string, arguments map[string]any) error {
	tempo := interaction.tempo
	if tool == "browser_focus_viewport" {
		id, _ := arguments["recordingId"].(string)
		found := false
		for _, recording := range interaction.recordings {
			if recording.ID == id {
				found = true
				break
			}
		}
		if !found {
			return errors.New("focus recordingId is not an active recording in this session")
		}
	}
	if tempo == recordingInteractionImmediate {
		return nil
	}
	arguments["smoothScroll"] = true
	pointer := tool == "browser_click" || tool == "browser_move" || tool == "browser_drag" || tool == "browser_scroll" || tool == "browser_cursor_attention"
	if !pointer {
		return nil
	}
	if _, explicit := arguments["motion"]; !explicit {
		arguments["motion"] = "fast"
		if tempo == recordingInteractionPresentation {
			arguments["motion"] = "natural"
		}
	}
	if tool == "browser_click" || tool == "browser_drag" {
		if _, explicit := arguments["arrivalDwellMs"]; !explicit {
			arguments["arrivalDwellMs"] = 40
			if tempo == recordingInteractionPresentation {
				arguments["arrivalDwellMs"] = 80
			}
		}
	}
	if tool == "browser_click" {
		if _, explicit := arguments["holdMs"]; !explicit {
			arguments["holdMs"] = 25
			if tempo == recordingInteractionPresentation {
				arguments["holdMs"] = 45
			}
		}
	}
	if tool == "browser_cursor_attention" {
		if _, explicit := arguments["durationMs"]; !explicit {
			arguments["durationMs"] = 1200
			if tempo == recordingInteractionPresentation {
				arguments["durationMs"] = 1800
			}
		}
	}
	return nil
}

// finish records the browser result exactly once and releases recording stops that
// began after this interaction was admitted.
func (interaction *recordingInteraction) finish(meta map[string]any) {
	if interaction == nil {
		return
	}
	interaction.once.Do(func() {
		defer func() {
			for _, recording := range interaction.recordings {
				recording.interactions.Done()
			}
		}()

		encoded, err := json.Marshal(meta)
		var reported struct {
			Action  *timelineAction  `json:"action"`
			Gesture *timelineGesture `json:"gesture"`
			Focus   *timelineFocus   `json:"focus"`
		}
		if err != nil || json.Unmarshal(encoded, &reported) != nil {
			return
		}
		// Focus is scheduled and returns immediately. Its successful action owns the
		// whole interval so burst capture and captions keep it through zoom-out.
		if reported.Action != nil && reported.Focus != nil {
			reported.Action.End = max(reported.Action.End, reported.Focus.End)
		}
		for _, recording := range interaction.recordings {
			if reported.Focus != nil && reported.Focus.RecordingID != recording.ID {
				continue
			}
			if reported.Focus != nil {
				if delay := time.Until(time.UnixMilli(reported.Focus.End)); delay > 0 {
					recording.interactions.Add(1)
					time.AfterFunc(delay, recording.interactions.Done)
				}
			}
			recording.timeline.add(reported.Action, reported.Gesture, reported.Focus)
		}

		if reported.Action == nil || reported.Action.TargetID == "" {
			return
		}
		r := interaction.session.runtime
		r.mu.Lock()
		defer r.mu.Unlock()
		for _, recording := range interaction.recordings {
			if recording.effects.Burst == nil || recording.finalizing {
				continue
			}
			recording.followWant = reported.Action.TargetID
			if !recording.following && recording.TargetID != recording.followWant {
				recording.following = true
				go interaction.session.followTarget(recording)
			}
		}
	})
}
