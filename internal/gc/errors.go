package gc

import "fmt"

// SessionOverlayUnmountError indicates overlay unmount did not complete before expiry.
type SessionOverlayUnmountError struct {
	SessionID string
	Err       error
}

func (e *SessionOverlayUnmountError) Error() string {
	return fmt.Sprintf("session overlay unmount failed for %s: %v", e.SessionID, e.Err)
}

func (e *SessionOverlayUnmountError) Unwrap() error {
	return e.Err
}
