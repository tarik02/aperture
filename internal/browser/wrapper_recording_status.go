package browser

import (
	"encoding/json"
	"github.com/aperture/aperture/internal/sessionfiles"
	"path/filepath"
	"time"

	"github.com/aperture/aperture/internal/recording"
)

// recordingStatus is a snapshot of the published state, without capture or edit machinery.
type recordingStatus struct {
	ID                string                 `json:"recordingId"`
	Mode              wrapperRecordingMode   `json:"mode"`
	TargetID          string                 `json:"targetId"`
	CaptureGeneration uint64                 `json:"captureGeneration"`
	Status            wrapperRecordingStatus `json:"status"`
	StopReason        string                 `json:"stopReason,omitempty"`
	Path              string                 `json:"-"`
	StartedAt         time.Time              `json:"startedAt"`
	StoppedAt         *time.Time             `json:"stoppedAt,omitempty"`
	SizeBytes         int64                  `json:"sizeBytes,omitempty"`
	FPS               int                    `json:"fps"`
	BitrateKbps       int                    `json:"bitrateKbps"`
	Codec             string                 `json:"codec"`
	MotionSeed        *int64                 `json:"motionSeed,omitempty"`
	Editing           bool                   `json:"editing"`
	EditedPath        string                 `json:"-"`
	TimelinePath      string                 `json:"-"`
	EditError         *recording.EditError   `json:"editError,omitempty"`
	filesRoot         string
}

// statusLocked reads only fields protected by the runtime lock.
func (rec *wrapperRecording) statusLocked() recordingStatus {
	var motionSeed *int64
	if rec.config.Motion != nil {
		motionSeed = rec.config.Motion.Seed
	}
	return recordingStatus{
		ID: rec.ID, Mode: rec.Mode, TargetID: rec.TargetID,
		CaptureGeneration: rec.CaptureGeneration, Status: rec.Status, StopReason: rec.StopReason,
		Path: rec.Path, filesRoot: rec.filesRoot, StartedAt: rec.StartedAt, StoppedAt: rec.StoppedAt,
		SizeBytes: rec.SizeBytes, FPS: rec.FPS, BitrateKbps: rec.BitrateKbps, Codec: rec.Codec, MotionSeed: motionSeed,
		Editing: rec.Editing, EditedPath: rec.EditedPath, TimelinePath: rec.TimelinePath, EditError: rec.EditError,
	}
}

// MarshalJSON reports the recording's file relative to the session files root;
// host paths never leave the wrapper.
func (recording recordingStatus) MarshalJSON() ([]byte, error) {
	type fields recordingStatus
	relative := func(path string) string {
		if rel, err := filepath.Rel(recording.filesRoot, path); err == nil && path != "" {
			return filepath.ToSlash(rel)
		}
		return ""
	}
	path := relative(recording.Path)
	sandboxPath := ""
	if path != "" {
		sandboxPath = sessionfiles.SandboxPath(path)
	}
	return json.Marshal(struct {
		fields
		RelativePath string `json:"relativePath"`
		SandboxPath  string `json:"sandboxPath,omitempty"`
		// Path repeats RelativePath for clients that still read the field it replaced.
		// It used to carry a host path, which it never does now.
		Path                 string `json:"path"`
		EditedRelativePath   string `json:"editedRelativePath,omitempty"`
		TimelineRelativePath string `json:"timelineRelativePath,omitempty"`
	}{fields: fields(recording), RelativePath: path, SandboxPath: sandboxPath, Path: path,
		EditedRelativePath: relative(recording.EditedPath), TimelineRelativePath: relative(recording.TimelinePath)})
}
