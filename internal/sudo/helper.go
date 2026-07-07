package sudo

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"

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
		layout.Artifacts,
		layout.Logs,
		layout.CrashDumps,
		lowerDir,
	}

	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("mkdir %s: %w", dir, err)
		}
	}

	if err := MountOverlayFS(lowerDir, layout.Upper, layout.Work, layout.Merged); err != nil {
		return fmt.Errorf("mount overlay: %w", err)
	}

	if err := chownSessionTreeToInvoker(layout); err != nil {
		return fmt.Errorf("chown session tree: %w", err)
	}

	return nil
}

func chownSessionTreeToInvoker(layout paths.SessionLayout) error {
	uidText := strings.TrimSpace(os.Getenv("SUDO_UID"))
	gidText := strings.TrimSpace(os.Getenv("SUDO_GID"))
	if uidText == "" || gidText == "" {
		return nil
	}
	uid, err := strconv.Atoi(uidText)
	if err != nil {
		return fmt.Errorf("parse SUDO_UID: %w", err)
	}
	gid, err := strconv.Atoi(gidText)
	if err != nil {
		return fmt.Errorf("parse SUDO_GID: %w", err)
	}

	for _, dir := range []string{
		layout.Root,
		layout.Upper,
		layout.Work,
		layout.Merged,
		layout.Downloads,
		layout.Cache,
		layout.Metadata,
		layout.Artifacts,
		layout.Logs,
		layout.CrashDumps,
	} {
		if err := chownPath(dir, uid, gid); err != nil {
			return err
		}
	}
	return nil
}

func chownPath(path string, uid, gid int) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	return os.Chown(path, uid, gid)
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

	if err := UnmountOverlayFS(layout.Merged); err != nil {
		return fmt.Errorf("unmount overlay: %w", err)
	}

	return nil
}
