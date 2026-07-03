package systemd

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/ids"
)

var ErrInvalidSessionID = errors.New("invalid session id")

// CommandRunner executes external commands for tests and production adapters.
type CommandRunner interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
}

// UserAdapter wraps systemctl --user operations for browser units.
type UserAdapter struct {
	unitTemplate string
}

// NewUserAdapter creates an adapter using the configured browser unit template.
func NewUserAdapter(cfg config.Config) (*UserAdapter, error) {
	template := strings.TrimSpace(cfg.SystemdBrowserUnitName)
	if template == "" {
		return nil, errors.New("systemd browser unit template is required")
	}
	if !strings.HasSuffix(template, ".service") {
		return nil, errors.New("systemd browser unit template must end with .service")
	}
	return &UserAdapter{unitTemplate: template}, nil
}

// UnitName returns the instantiated browser unit name for a session id.
func (a *UserAdapter) UnitName(sessionID string) (string, error) {
	if err := ids.ValidateUUIDv7(sessionID); err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidSessionID, err)
	}
	return instantiateUnit(a.unitTemplate, sessionID), nil
}

func instantiateUnit(template, instance string) string {
	base := strings.TrimSuffix(template, ".service")
	base = strings.TrimSuffix(base, "@")
	return fmt.Sprintf("%s@%s.service", base, instance)
}

// Start starts the browser unit for sessionID.
func (a *UserAdapter) Start(ctx context.Context, runner CommandRunner, sessionID string) error {
	unit, err := a.UnitName(sessionID)
	if err != nil {
		return err
	}
	_, err = runner.Run(ctx, "systemctl", "--user", "start", unit)
	return wrapCommandError("start", unit, err)
}

// Stop stops the browser unit for sessionID.
func (a *UserAdapter) Stop(ctx context.Context, runner CommandRunner, sessionID string) error {
	unit, err := a.UnitName(sessionID)
	if err != nil {
		return err
	}
	_, err = runner.Run(ctx, "systemctl", "--user", "stop", unit)
	return wrapCommandError("stop", unit, err)
}

// Show returns systemctl show output for the browser unit.
func (a *UserAdapter) Show(ctx context.Context, runner CommandRunner, sessionID string) ([]byte, error) {
	unit, err := a.UnitName(sessionID)
	if err != nil {
		return nil, err
	}
	out, err := runner.Run(ctx, "systemctl", "--user", "show", unit)
	if err != nil {
		return nil, wrapCommandError("show", unit, err)
	}
	return out, nil
}

// IsActive reports whether the browser unit is active.
func (a *UserAdapter) IsActive(ctx context.Context, runner CommandRunner, sessionID string) (bool, error) {
	unit, err := a.UnitName(sessionID)
	if err != nil {
		return false, err
	}
	out, err := runner.Run(ctx, "systemctl", "--user", "is-active", unit)
	if err != nil {
		var cmdErr *CommandError
		if errors.As(err, &cmdErr) && cmdErr.ExitCode == 3 {
			return false, nil
		}
		return false, wrapCommandError("is-active", unit, err)
	}
	return strings.TrimSpace(string(out)) == "active", nil
}

// ListActiveInstances returns session ids with active browser units.
func (a *UserAdapter) ListActiveInstances(ctx context.Context, runner CommandRunner) ([]string, error) {
	pattern := strings.TrimSuffix(a.unitTemplate, ".service") + "*"
	out, err := runner.Run(ctx, "systemctl", "--user", "list-units", "--state=active", "--no-legend", "--plain", pattern)
	if err != nil {
		return nil, wrapCommandError("list-units", pattern, err)
	}

	ids := make([]string, 0)
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		sessionID, err := parseInstanceFromUnit(fields[0])
		if err != nil {
			continue
		}
		ids = append(ids, sessionID)
	}
	return ids, nil
}

func parseInstanceFromUnit(unit string) (string, error) {
	at := strings.Index(unit, "@")
	if at < 0 {
		return "", fmt.Errorf("invalid unit name: %s", unit)
	}
	end := len(unit)
	if strings.HasSuffix(unit, ".service") {
		end -= len(".service")
	}
	instance := unit[at+1 : end]
	if err := ids.ValidateUUIDv7(instance); err != nil {
		return "", err
	}
	return instance, nil
}

func wrapCommandError(op, unit string, err error) error {
	if err == nil {
		return nil
	}
	var cmdErr *CommandError
	if errors.As(err, &cmdErr) {
		return &CommandError{
			Operation: op,
			Unit:      unit,
			ExitCode:  cmdErr.ExitCode,
			Output:    cmdErr.Output,
			Err:       cmdErr.Err,
		}
	}
	return &CommandError{Operation: op, Unit: unit, Err: err}
}
