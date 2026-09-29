package edit

import "fmt"

// Codes of Error. They are what a recording reports as editError.code.
const (
	// CodeUnavailable means no ffmpeg is configured for editing recordings.
	CodeUnavailable = "unavailable"
	// CodeSourceUnreadable means the video is missing or is not what it should be.
	CodeSourceUnreadable = "source_unreadable"
	// CodeFFmpegFailed means ffmpeg exited with an error.
	CodeFFmpegFailed = "ffmpeg_failed"
	// CodeTimeout means ffmpeg ran out of time.
	CodeTimeout = "timeout"
	// CodeCanceled means the edit was cancelled, by the caller giving up or the
	// session closing. It is not a failure of the recording and is never reported
	// as editError.code: the edit stays pending.
	CodeCanceled = "canceled"
	// CodeRecordingFailed means the recording's pipeline failed and what it
	// captured was salvaged as it was, so its effects were not applied.
	CodeRecordingFailed = "recording_failed"
	// CodeInternal is an unexpected failure to prepare or publish the edit.
	CodeInternal = "internal"
)

// Error is a failed edit, with a code a client can act on. It is also what a
// recording reports as editError.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func newError(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}
