package supervisor

import "fmt"

// BrowserSupervisorError indicates systemd browser orchestration failure.
type BrowserSupervisorError struct {
	SessionID string
	Operation string
	Err       error
}

func (e *BrowserSupervisorError) Error() string {
	return fmt.Sprintf("browser supervisor %s failed for session %s: %v", e.Operation, e.SessionID, e.Err)
}

func (e *BrowserSupervisorError) Unwrap() error {
	return e.Err
}
