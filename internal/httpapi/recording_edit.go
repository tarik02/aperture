package httpapi

import (
	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/sessionfiles"
)

// recordingEdit checks the edited video path a wrapper reports.
func recordingEdit(status wrapperRecordingStatus) (browser.RecordingEdit, error) {
	edit := status.RecordingEdit
	if edit.EditedRelativePath == "" {
		return edit, nil
	}
	path, err := recordingFilePath(edit.EditedRelativePath)
	edit.EditedRelativePath = path
	return edit, err
}

// stoppedRecording is the response to stopping a recording: its file, and what became of its effects.
type stoppedRecording struct {
	sessionfiles.File
	browser.RecordingEdit
}
