package systemd

import (
	"context"
	"os/exec"
	"strings"
)

// ExecRunner runs external commands for production adapters.
type ExecRunner struct{}

// Run executes name with args and returns combined output.
func (ExecRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		exitCode := 1
		var exitErr *exec.ExitError
		if ok := asExitError(err, &exitErr); ok {
			exitCode = exitErr.ExitCode()
		}
		return out, &CommandError{
			Operation: name,
			Unit:      strings.Join(args, " "),
			ExitCode:  exitCode,
			Output:    strings.TrimSpace(string(out)),
			Err:       err,
		}
	}
	return out, nil
}

func asExitError(err error, target **exec.ExitError) bool {
	exitErr, ok := err.(*exec.ExitError)
	if !ok {
		return false
	}
	*target = exitErr
	return true
}

// NewExecRunner returns a production command runner.
func NewExecRunner() ExecRunner {
	return ExecRunner{}
}
