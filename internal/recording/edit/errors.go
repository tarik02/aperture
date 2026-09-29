package edit

import "fmt"

// Codes of Error. They are what a recording reports as editError.code.
const (
	// CodeUnavailable means no ffmpeg is configured for editing recordings.
	CodeUnavailable = "unavailable"
	// CodeMixedSizes means the recording's frames are not all one size, as
	// happens when the viewport is resized while recording, which the edit does not
	// support.
	CodeMixedSizes = "unsupported_mixed_sizes"
	// CodeSourceUnreadable means the video is missing or is not what it should be.
	CodeSourceUnreadable = "source_unreadable"
	// CodeFFmpegFailed means ffmpeg exited with an error.
	CodeFFmpegFailed = "ffmpeg_failed"
	// CodeTimeout means ffmpeg ran out of time.
	CodeTimeout = "timeout"
	// CodeCanceled means the edit was cancelled, by the caller giving up or the
	// session closing.
	CodeCanceled = "canceled"
	// CodeInternal is an unexpected failure to prepare or publish the edit.
	CodeInternal = "internal"
)

// Error is a failed edit, with a code a client can act on.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func newError(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}
