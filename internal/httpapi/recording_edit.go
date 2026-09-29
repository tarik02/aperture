package httpapi

import "github.com/aperture/aperture/internal/sessionfiles"

// recordingEditFields report what stopping a recording made of its effects: the edited
// video, or why there is none, and what was left out.
type recordingEditFields struct {
	EditedRelativePath string   `json:"editedRelativePath,omitempty"`
	EditError          string   `json:"editError,omitempty"`
	EditWarnings       []string `json:"editWarnings,omitempty"`
}

// recordingEdit checks the edited video path a wrapper reports.
func recordingEdit(status wrapperRecordingStatus) (recordingEditFields, error) {
	fields := status.recordingEditFields
	if fields.EditedRelativePath == "" {
		return fields, nil
	}
	path, err := recordingFilePath(fields.EditedRelativePath)
	fields.EditedRelativePath = path
	return fields, err
}

// stoppedRecording is the response to stopping a recording: its file, and what became of its effects.
type stoppedRecording struct {
	sessionfiles.File
	recordingEditFields
}
