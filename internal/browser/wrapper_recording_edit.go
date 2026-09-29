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

// The states of a recording's edit, as EditState reports them. A recording that
// is still running has none.
const (
	// editStateNone: the recording has nothing to apply, or its edit found nothing
	// to change.
	editStateNone = "none"
	// editStatePending: effects were requested and have not been rendered yet. The
	// next stop request made over REST or MCP renders them; a recording stopped
	// from the live session's websocket, or whose edit was cancelled, waits for it.
	editStatePending = "pending"
	// editStateRendering: an edit is being rendered right now.
	editStateRendering = "rendering"
	// editStateDone: the edited video is published, see EditedRelativePath.
	editStateDone = "done"
	// editStateFailed: the edit failed, see EditError. The raw video is kept.
	editStateFailed = "failed"
)

// recordingEdit is what a recording knows about its edit: the effect defaults it
// was started with, and what came of the edit made when it stopped.
type recordingEdit struct {
	effects recordingEffects

	// EditState is where the edit stands, once the recording has stopped.
	EditState string `json:"editState,omitempty"`
	// EditedRelativePath is the edited video, below the session files root, once
	// it is published.
	EditedRelativePath string `json:"editedRelativePath,omitempty"`
	// EditError is why the recording has no edited video although it has effects to
	// apply.
	EditError *edit.Error `json:"editError,omitempty"`
	// EditWarnings say what of the effects could not be applied or left as they were.
	EditWarnings []string `json:"editWarnings,omitempty"`
}

// setStoppedEdit sets the state of the edit of a recording that has just stopped
// on request, whose timeline says whether it has effects to apply.
func (e *recordingEdit) setStoppedEdit(wanted bool) {
	e.EditState = editStateNone
	if wanted {
		e.EditState = editStatePending
	}
}

// setSalvagedEdit records that a recording that failed was kept as it was. Its
// segments are separate videos, each with a timeline of its own, and nobody waits
// on a failed recording to render anything, so effects it had are not applied.
func (e *recordingEdit) setSalvagedEdit(wanted bool) {
	e.EditState = editStateNone
	if wanted {
		e.EditState = editStateFailed
		e.EditError = &edit.Error{Code: edit.CodeRecordingFailed, Message: "the recording failed before it was stopped, so the video it captured was kept as it was, without its effects"}
	}
}

// resolveRecordingEffects validates the effects a recording is started with, and
// that this host can apply them.
func (session *liveSession) resolveRecordingEffects(request recordingEffectsRequest, capture wrapperRecordingCapture) (recordingEffects, error) {
	effects, err := request.resolve(capture)
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
// The edit is not made under the recording's operation lock, which is for the
// recording's pipeline: a stop request that comes while the edit renders returns
// the status at once, with the edit's state "rendering", and the caller polls
// the status for the result.
//
// A recording that stopped by itself (its tab closed, its client left) is edited
// by the request that stops it after that, since nobody is waiting for the edit
// when it stops; until then its edit's state is "pending".
func (session *liveSession) editStoppedRecording(ctx context.Context, status wrapperRecording) wrapperRecording {
	r := session.runtime
	r.mu.Lock()
	recording := session.recordings[status.ID]
	if recording == nil {
		r.mu.Unlock()
		return status
	}
	var tl *timeline.Timeline
	if recording.timeline != nil {
		tl = recording.timeline.builtTimeline()
	}
	if recording.Status != wrapperRecordingStopped || recording.EditState != editStatePending || tl == nil {
		current := *recording
		r.mu.Unlock()
		return current
	}
	recording.EditState = editStateRendering
	rawPath, filesRoot := recording.Path, recording.filesRoot
	r.mu.Unlock()
	session.broadcastRecordings()

	outcome := session.renderRecordingEdit(ctx, recording.ID, tl, rawPath, filesRoot)
	r.mu.Lock()
	switch {
	case outcome.canceled:
		// A cancelled edit says nothing about the recording; the next stop makes it.
		recording.EditState = editStatePending
	case outcome.err != nil:
		recording.EditState = editStateFailed
	case outcome.relativePath != "":
		recording.EditState = editStateDone
	default:
		recording.EditState = editStateNone
	}
	if !outcome.canceled {
		recording.EditedRelativePath = outcome.relativePath
		recording.EditError = outcome.err
		recording.EditWarnings = outcome.warnings
	}
	current := *recording
	r.mu.Unlock()
	if !outcome.canceled {
		// The timeline is not needed any more: the edit is over, however it ended.
		recording.timeline.releaseBuilt()
	}
	session.broadcastRecordings()
	return current
}

// editOutcome is what an edit came to.
type editOutcome struct {
	// relativePath is the edited video's path below the files root, empty when there is none.
	relativePath string
	err          *edit.Error
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
	// The font cache outlives the edit: building it takes seconds, and every
	// edit of the session needs it.
	cacheDir := filepath.Join(r.values.CacheDir, "recording-edit")
	if err := os.MkdirAll(cacheDir, 0o700); err != nil {
		cacheDir = ""
	}

	started := time.Now()
	result, err := runRecordingEdit(ctx, edit.RunOptions{
		FFmpeg:   strings.TrimSpace(r.values.RecordingFFmpegExecutable),
		Source:   rawPath,
		WorkDir:  work,
		CacheDir: cacheDir,
		Threads:  r.values.RecordingEditThreads,
		MaxTime:  r.values.RecordingEditTimeout,
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
	return editOutcome{err: &edit.Error{Code: code, Message: message}}
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
