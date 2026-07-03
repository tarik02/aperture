package sudo

import (
	"context"
	"fmt"
	"os"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/paths"
)

// MountSession validates ids, derives trusted paths, and prepares session overlay directories.
// Kernel overlayfs mount is completed in a later stage.
func MountSession(ctx context.Context, cfg config.Config, req MountRequest) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	layout, err := paths.Session(cfg, req.SessionID)
	if err != nil {
		return fmt.Errorf("derive session paths: %w", err)
	}

	roots := []struct {
		root   string
		target string
	}{
		{cfg.StoreRoot, layout.Root},
		{cfg.StoreRoot, layout.Upper},
		{cfg.StoreRoot, layout.Work},
		{cfg.StoreRoot, layout.Merged},
		{cfg.StoreRoot, layout.Downloads},
		{cfg.StoreRoot, layout.Cache},
		{cfg.StoreRoot, layout.Metadata},
		{cfg.ArtifactRoot, layout.Artifacts},
		{cfg.ArtifactRoot, layout.Logs},
		{cfg.ArtifactRoot, layout.CrashDumps},
	}

	for _, item := range roots {
		if err := paths.ValidateTrustedPath(item.root, item.target); err != nil {
			return fmt.Errorf("validate path %s: %w", item.target, err)
		}
	}

	var lowerDir string
	if req.Empty {
		lowerDir, err = paths.EmptyLowerDir(cfg)
		if err != nil {
			return fmt.Errorf("derive empty lower dir: %w", err)
		}
	} else {
		snapshotLayout, err := paths.Snapshot(cfg, req.BaseSnapshotID)
		if err != nil {
			return fmt.Errorf("derive snapshot paths: %w", err)
		}
		lowerDir = snapshotLayout.Profile
		if err := paths.ValidateTrustedPath(cfg.StoreRoot, lowerDir); err != nil {
			return fmt.Errorf("validate lower dir: %w", err)
		}
	}

	if err := paths.ValidateTrustedPath(cfg.StoreRoot, lowerDir); err != nil {
		return fmt.Errorf("validate lower dir: %w", err)
	}

	dirs := []string{
		layout.Upper,
		layout.Work,
		layout.Merged,
		layout.Downloads,
		layout.Cache,
		layout.Metadata,
		layout.Logs,
		layout.CrashDumps,
		lowerDir,
	}

	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("mkdir %s: %w", dir, err)
		}
	}

	_ = lowerDir
	return nil
}

// UnmountSession validates ids and derived paths for a session overlay.
// Kernel overlayfs unmount is completed in a later stage.
func UnmountSession(ctx context.Context, cfg config.Config, sessionID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	layout, err := paths.Session(cfg, sessionID)
	if err != nil {
		return fmt.Errorf("derive session paths: %w", err)
	}

	targets := []struct {
		root   string
		target string
	}{
		{cfg.StoreRoot, layout.Root},
		{cfg.StoreRoot, layout.Merged},
		{cfg.StoreRoot, layout.Upper},
		{cfg.StoreRoot, layout.Work},
	}

	for _, item := range targets {
		if err := paths.ValidateTrustedPath(item.root, item.target); err != nil {
			return fmt.Errorf("validate path %s: %w", item.target, err)
		}
	}

	return nil
}
