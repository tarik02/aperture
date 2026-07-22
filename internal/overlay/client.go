package overlay

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/sudo"
)

var ErrMountFailed = errors.New("session overlay mount failed")
var ErrUnmountFailed = errors.New("session overlay unmount failed")

// Client invokes privileged mount helpers using ids only.
type Client struct {
	cfg         config.Config
	sudoPath    string
	mountPath   string
	unmountPath string
	run         commandRunner
}

type commandRunner interface {
	CombinedOutput(ctx context.Context, name string, args ...string) ([]byte, error)
}

type execRunner struct{}

func (execRunner) CombinedOutput(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	return cmd.CombinedOutput()
}

// NewClient constructs an overlay helper client from configuration.
func NewClient(cfg config.Config) (*Client, error) {
	mountPath, err := exec.LookPath("aperture-mount-session")
	if err != nil {
		return nil, fmt.Errorf("locate aperture-mount-session: %w", err)
	}
	unmountPath, err := exec.LookPath("aperture-unmount-session")
	if err != nil {
		return nil, fmt.Errorf("locate aperture-unmount-session: %w", err)
	}
	sudoPath, err := exec.LookPath("sudo")
	if err != nil {
		return nil, fmt.Errorf("locate sudo: %w", err)
	}

	return &Client{
		cfg:         cfg,
		sudoPath:    sudoPath,
		mountPath:   mountPath,
		unmountPath: unmountPath,
		run:         execRunner{},
	}, nil
}

// NewClientWithRunner constructs a client for tests.
func NewClientWithRunner(cfg config.Config, mountPath, unmountPath, sudoPath string, runner commandRunner) *Client {
	return &Client{
		cfg:         cfg,
		sudoPath:    sudoPath,
		mountPath:   mountPath,
		unmountPath: unmountPath,
		run:         runner,
	}
}

// Mount prepares and mounts a session overlay via the sudo helper.
func (c *Client) Mount(ctx context.Context, sessionID string, baseSnapshotID *string) error {
	args := []string{c.mountPath, sessionID}
	if strings.TrimSpace(c.cfg.OverlayHelperConfigFile) != "" {
		args = []string{c.mountPath, "--config", c.cfg.OverlayHelperConfigFile, sessionID}
	}
	if baseSnapshotID == nil || strings.TrimSpace(*baseSnapshotID) == "" {
		args = append(args, "empty")
	} else {
		args = append(args, *baseSnapshotID)
	}

	out, err := c.run.CombinedOutput(ctx, c.sudoPath, args...)
	if err != nil {
		return fmt.Errorf("%w: %v: %s", ErrMountFailed, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// Unmount unmounts a session overlay via the sudo helper.
func (c *Client) Unmount(ctx context.Context, sessionID string) error {
	args := []string{c.unmountPath, sessionID}
	if strings.TrimSpace(c.cfg.OverlayHelperConfigFile) != "" {
		args = []string{c.unmountPath, "--config", c.cfg.OverlayHelperConfigFile, sessionID}
	}

	out, err := c.run.CombinedOutput(ctx, c.sudoPath, args...)
	if err != nil {
		return fmt.Errorf("%w: %v: %s", ErrUnmountFailed, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// MountDirect mounts overlayfs in-process for tests and integration environments.
func MountDirect(cfg config.Config, req sudo.MountRequest) error {
	return sudo.MountSession(context.Background(), cfg, req)
}

// UnmountDirect unmounts overlayfs in-process for tests and integration environments.
func UnmountDirect(cfg config.Config, sessionID string) error {
	return sudo.UnmountSession(context.Background(), cfg, sessionID)
}
