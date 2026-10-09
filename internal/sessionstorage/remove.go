package sessionstorage

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/overlay"
	"github.com/aperture/aperture/internal/paths"
)

// RemoveOverlay removes session-owned state only after the overlay is unmounted.
// The caller must stop the browser and hold the repository's session lifecycle lock.
func RemoveOverlay(cfg config.Config, session *db.Session) error {
	layout, err := paths.Session(cfg, session.ID)
	if err != nil {
		return err
	}
	for _, merged := range []string{layout.Merged, session.MergedPath} {
		if merged == "" {
			continue
		}
		mounted, err := overlay.IsMergedMounted(merged)
		if err != nil {
			return err
		}
		if mounted {
			return fmt.Errorf("session overlay still mounted at %s", merged)
		}
	}

	dirs := []string{
		session.UpperPath, session.WorkPath, session.MergedPath,
		session.DownloadsPath, session.CachePath, session.OverlayPath,
		layout.Root, filepath.Dir(layout.Files.Root),
	}
	targets := make([]string, 0, len(dirs))
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		var valid bool
		for _, storage := range []struct{ root, boundary string }{
			{layout.Root, cfg.StoreRoot},
			{filepath.Dir(layout.Files.Root), cfg.ColdRoot},
		} {
			if paths.EnsureUnderRoot(storage.root, dir) == nil {
				if err := paths.RejectSymlink(dir, storage.boundary); err != nil {
					return err
				}
				valid = true
				break
			}
		}
		if !valid {
			// Copying cold_root elsewhere leaves old database paths. Only the
			// configured session roots belong to this installation now.
			continue
		}
		targets = append(targets, dir)
	}
	for _, dir := range targets {
		if err := os.RemoveAll(dir); err != nil {
			return fmt.Errorf("remove session path %s: %w", dir, err)
		}
	}
	return nil
}

// RemoveArtifacts removes logs and crash dumps independently of retained browser state.
func RemoveArtifacts(cfg config.Config, session *db.Session) error {
	layout, err := paths.Session(cfg, session.ID)
	if err != nil {
		return err
	}
	for _, dir := range []string{session.ArtifactsPath, layout.Artifacts} {
		if dir == "" {
			continue
		}
		if paths.EnsureUnderRoot(layout.Artifacts, dir) != nil {
			continue
		}
		if err := paths.ValidateTrustedPath(cfg.ArtifactRoot, dir); err != nil {
			return err
		}
		if err := os.RemoveAll(dir); err != nil {
			return fmt.Errorf("remove session artifacts: %w", err)
		}
	}
	return nil
}
