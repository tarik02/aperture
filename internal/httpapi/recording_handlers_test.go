package httpapi

import (
	"errors"
	"net/http"
	"testing"
)

func TestRecordingEditSettingsAndPathsFromTheWrapper(t *testing.T) {
	t.Parallel()
	// The wrapper rejects contradicting settings with 400, which is a validation failure here.
	err := mapWrapperRecordingRequestError(&wrapperRecordingRequestError{StatusCode: http.StatusBadRequest, Message: "invalid recording config"})
	if !errors.Is(err, errValidation) {
		t.Fatalf("err = %v", err)
	}
	status := wrapperRecordingStatus{recordingEdit: recordingEdit{EditedRelativePath: "recordings/a.edited.mp4", TimelineRelativePath: "recordings/a.timeline.json"}}
	if edit, err := status.validEdit(); err != nil || edit.EditedRelativePath != "recordings/a.edited.mp4" {
		t.Fatalf("edit = %+v, %v", edit, err)
	}
	for _, escaped := range []string{"../a.mp4", "downloads/a.mp4"} {
		if _, err := (wrapperRecordingStatus{recordingEdit: recordingEdit{EditedRelativePath: escaped}}).validEdit(); err == nil {
			t.Errorf("%s was accepted", escaped)
		}
	}
}
