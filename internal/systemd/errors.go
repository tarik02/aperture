package systemd

import "fmt"

// CommandError describes a failed systemctl invocation.
type CommandError struct {
	Operation string
	Unit      string
	ExitCode  int
	Output    string
	Err       error
}

func (e *CommandError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("systemctl %s %s: %v", e.Operation, e.Unit, e.Err)
	}
	return fmt.Sprintf("systemctl %s %s failed (exit %d): %s", e.Operation, e.Unit, e.ExitCode, e.Output)
}

func (e *CommandError) Unwrap() error {
	return e.Err
}
