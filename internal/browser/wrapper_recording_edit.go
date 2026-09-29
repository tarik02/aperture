package browser

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/recording/edit"
	"github.com/aperture/aperture/internal/recording/timeline"
)

// editWorkPrefix starts the name of the hidden directory an edit is rendered in,
// inside the recordings directory next to the video: the edited video becomes
// visible only once it is complete, the way recordings do.
const editWorkPrefix = ".edit-"

// editedVideoSuffix replaces the extension of a raw video's name to name its
// edited video: recording-<id>.webm has recording-<id>.edited.mp4.
const editedVideoSuffix = ".edited.mp4"

// runRecordingEdit renders an edit. It is a variable so tests can replace ffmpeg.
var runRecordingEdit = edit.Run

// recordingEditError says why a recording's edit failed; the raw recording is
// kept and returned all the same.
type recordingEditError struct {
	// Code is one of unavailable, unsupported_mixed_sizes, source_unreadable,
	// ffmpeg_failed, timeout or internal.
	Code    string `json:"code"`
	Message string `json:"message"`
}

// recordingEdit is what a recording knows about its edit: the effect defaults it
// was started with, and what came of the edit made when it stopped.
type recordingEdit struct {
	effects recordingEffects
	// editAttempted is set once the edit has been made or found to have nothing to
	// do. An edit that was cancelled has not been attempted, and the next stop
	// makes it.
	editAttempted bool

	// EditedRelativePath is the edited video, below the session files root, once
	// it is published.
	EditedRelativePath string `json:"editedRelativePath,omitempty"`
	// EditError is why the recording has no edited video although it has effects to
	// apply.
	EditError *recordingEditError `json:"editError,omitempty"`
	// EditWarnings say what of the effects could not be applied or left as they were.
	EditWarnings []string `json:"editWarnings,omitempty"`
}

// resolveRecordingEffects validates the effects a recording is started with, and
// that this host can apply them.
func (session *liveSession) resolveRecordingEffects(request recordingEffectsRequest) (recordingEffects, error) {
	effects, err := request.resolve()
	if err != nil {
		return effects, fmt.Errorf("%w: %w", errWrapperRecordingInvalid, err)
	}
	if effects.any() && strings.TrimSpace(session.runtime.values.RecordingFFmpegExecutable) == "" {
		return effects, errWrapperRecordingEditUnavailable
	}
	return effects, nil
}

// editStoppedRecording makes the edit of a recording that has just been stopped
// on request and returns its status. It blocks until the edit is rendered, which
// takes up to minutes. A recording with nothing to apply is not touched, and
// takes no time. However the edit ends, the raw recording and its timeline stay
// as they were; a failed edit is reported in the status.
//
// A recording that stopped by itself (its tab closed, its client left) is edited
// by the request that stops it after that, since nobody is waiting for the edit
// when it stops.
func (session *liveSession) editStoppedRecording(ctx context.Context, status wrapperRecording) wrapperRecording {
	r := session.runtime
	r.mu.Lock()
	recording := session.recordings[status.ID]
	r.mu.Unlock()
	if recording == nil {
		return status
	}
	recording.operationMu.Lock()
	defer recording.operationMu.Unlock()

	var tl *timeline.Timeline
	if recording.timeline != nil {
		tl = recording.timeline.builtTimeline()
	}
	r.mu.Lock()
	if recording.Status != wrapperRecordingStopped || recording.editAttempted || tl == nil {
		current := *recording
		r.mu.Unlock()
		return current
	}
	rawPath, filesRoot := recording.Path, recording.filesRoot
	r.mu.Unlock()

	outcome := session.renderRecordingEdit(ctx, recording.ID, tl, rawPath, filesRoot)
	r.mu.Lock()
	if !outcome.canceled {
		recording.editAttempted = true
		recording.EditedRelativePath = outcome.relativePath
		recording.EditError = outcome.err
		recording.EditWarnings = outcome.warnings
	}
	current := *recording
	r.mu.Unlock()
	if !outcome.canceled {
		recording.timeline.releaseBuilt()
		session.broadcastRecordings()
	}
	return current
}

// editOutcome is what an edit came to.
type editOutcome struct {
	// relativePath is the edited video's path below the files root, empty when there is none.
	relativePath string
	err          *recordingEditError
	warnings     []string
	// canceled is set when the edit was given up because the request ended or the
	// session closed; it says nothing about the recording.
	canceled bool
}

func (session *liveSession) renderRecordingEdit(ctx context.Context, id string, tl *timeline.Timeline, rawPath, filesRoot string) editOutcome {
	r := session.runtime
	if !edit.Wanted(tl) {
		return editOutcome{}
	}
	// Closing the session ends the edit too.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer context.AfterFunc(r.ctx, cancel)()

	files := paths.SessionFiles(r.values.FilesDir)
	work := filepath.Join(files.Recordings, editWorkPrefix+id)
	_ = os.RemoveAll(work)
	if err := os.MkdirAll(work, 0o700); err != nil {
		return editFailure(edit.CodeInternal, fmt.Sprintf("create the edit's work directory: %v", err))
	}
	defer func() { _ = os.RemoveAll(work) }()

	started := time.Now()
	result, err := runRecordingEdit(ctx, edit.RunOptions{
		FFmpeg:  strings.TrimSpace(r.values.RecordingFFmpegExecutable),
		Source:  rawPath,
		WorkDir: work,
		Threads: r.values.RecordingEditThreads,
		MaxTime: r.values.RecordingEditTimeout,
	}, tl)
	if err != nil {
		var failure *edit.Error
		if !errors.As(err, &failure) {
			failure = &edit.Error{Code: edit.CodeInternal, Message: err.Error()}
		}
		if failure.Code == edit.CodeCanceled {
			return editOutcome{canceled: true}
		}
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: recording %s edit failed after %s: %s: %s\n", id, time.Since(started).Round(time.Millisecond), failure.Code, failure.Message)
		return editFailure(failure.Code, failure.Message)
	}
	outcome := editOutcome{warnings: result.Plan.Warnings}
	if result.Output == "" {
		return outcome
	}
	target := strings.TrimSuffix(rawPath, filepath.Ext(rawPath)) + editedVideoSuffix
	published, err := publishRecording(result.Output, target)
	if err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: recording %s edit: %v\n", id, err)
		return editFailure(edit.CodeInternal, err.Error())
	}
	relative, err := filepath.Rel(filesRoot, published)
	if err != nil {
		return editFailure(edit.CodeInternal, err.Error())
	}
	outcome.relativePath = filepath.ToSlash(relative)
	fmt.Fprintf(os.Stderr, "browser-session-wrapper: recording %s edited in %s: %+v\n", id, time.Since(started).Round(time.Millisecond), result.Plan.Report)
	return outcome
}

func editFailure(code, message string) editOutcome {
	return editOutcome{err: &recordingEditError{Code: code, Message: message}}
}

// sweepRecordingEdits removes the work directories of edits that a previous
// wrapper process left behind; no edit of this process has started yet.
func sweepRecordingEdits(recordingsDir string) {
	entries, _ := os.ReadDir(recordingsDir)
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), editWorkPrefix) {
			_ = os.RemoveAll(filepath.Join(recordingsDir, entry.Name()))
		}
	}
}
