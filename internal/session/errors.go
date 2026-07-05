package session

import (
	"errors"

	"github.com/aperture/aperture/internal/supervisor"
)

var (
	ErrNotFound          = errors.New("session not found")
	ErrExpired           = errors.New("session expired")
	ErrNotRetained       = errors.New("session is not retained")
	ErrNotReopenable     = errors.New("session cannot be reopened")
	ErrInvalidState      = errors.New("session is in an invalid state for this operation")
	ErrNotRunning        = errors.New("session is not running")
	ErrCDPTokenMissing   = errors.New("cdp token missing")
	ErrCDPTokenInvalid   = errors.New("cdp token invalid")
	ErrCDPTokenRevoked   = errors.New("cdp token revoked")
	ErrMediaTokenMissing = errors.New("media token missing")
	ErrMediaTokenInvalid = errors.New("media token invalid")
	ErrSnapshotNotFound  = errors.New("base snapshot not found")
	ErrSnapshotDeleted   = errors.New("base snapshot is deleted")
	ErrOverlayMissing    = errors.New("session overlay is not present")
	ErrBrowserStart      = errors.New("browser failed to start")
	ErrDeniedBrowserArg  = errors.New("browser argument conflicts with supervisor-owned behavior")
	ErrInvalidChannel    = errors.New("invalid browser channel")
)

// OverlayMountError indicates overlay mount failure.
type OverlayMountError struct {
	SessionID string
	Err       error
}

func (e *OverlayMountError) Error() string {
	return "overlay mount failed for session " + e.SessionID + ": " + e.Err.Error()
}

func (e *OverlayMountError) Unwrap() error {
	return e.Err
}

// BrowserSupervisorError indicates systemd browser orchestration failure.
type BrowserSupervisorError = supervisor.BrowserSupervisorError
