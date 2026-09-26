// Package storage keeps snapshots and session files under cold_root, apart from
// the session overlay state under store_root.
package storage

import (
	"context"
	"errors"
	"fmt"
	"github.com/aperture/aperture/internal/db"
	"github.com/google/renameio/v2"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/aperture/aperture/internal/config"
)

var (
	// ErrStoreRootHasColdData reports snapshots or session files left under
	// store_root after cold_root was pointed elsewhere, where Aperture would no
	// longer find them.
	ErrStoreRootHasColdData = errors.New("snapshots or session files remain under store_root")
	// ErrColdRootUnmarked reports a cold_root without this install's marker while
	// the database expects data there: a network share that is not mounted, or a
	// cold_root that points somewhere else than the data.
	ErrColdRootUnmarked = errors.New("cold_root does not hold this install's snapshots and session files")
	// ErrColdRootForeign reports a cold_root marked by another install.
	ErrColdRootForeign = errors.New("cold_root belongs to another Aperture install")
)

// markerName is the file at cold_root naming the install whose data it holds.
// Nothing below cold_root that Aperture lists, moves, or collects is at its
// top level, so the marker is never mistaken for data.
const markerName = ".aperture-root"

// Prepare checks that cold_root holds this install's snapshots and session files
// before the daemon uses it, then creates its directories.
//
// cold_root must carry a marker with the install ID from the database. A missing
// marker is written when there is nothing to lose: when the database has no live
// snapshots or sessions, or when cold_root is store_root, which is local and where
// installs from before the marker keep their data. Otherwise a missing marker
// means an unmounted share or a wrong cold_root, and a marker with another ID
// means another install's data; both refuse to start. Data still under a
// store_root that is not cold_root refuses to start until it is migrated.
func Prepare(ctx context.Context, cfg config.Config, repo *db.Repository) error {
	same, err := sameRoot(cfg)
	if err != nil {
		return err
	}
	if !same {
		moves, err := pendingMoves(cfg)
		if err != nil {
			return err
		}
		if len(moves) > 0 {
			return fmt.Errorf(
				"%w: %d snapshot or session files directories under %s belong under cold_root %s; stop Aperture and run `aperture storage migrate`",
				ErrStoreRootHasColdData, len(moves), cfg.StoreRoot, cfg.ColdRoot,
			)
		}
	}

	installID, err := repo.InstallID(ctx)
	if err != nil {
		return err
	}
	marker, err := readMarker(cfg)
	if err != nil {
		return err
	}
	switch {
	case marker == installID:
	case marker != "":
		return foreignMarkerError(cfg, marker, installID)
	default:
		hasData, err := repo.HasColdData(ctx)
		if err != nil {
			return err
		}
		if hasData && !same {
			return fmt.Errorf(
				"%w: %s has no %s marker while the database has snapshots or sessions; mount the share or fix cold_root",
				ErrColdRootUnmarked, cfg.ColdRoot, markerName,
			)
		}
		if err := writeMarker(cfg, installID); err != nil {
			return err
		}
	}

	for _, dir := range []string{filepath.Join(cfg.ColdRoot, "snapshots"), filepath.Join(cfg.ColdRoot, "sessions")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("prepare cold_root: %w", err)
		}
	}
	return nil
}

// readMarker returns the install ID cold_root is marked with, or "" when it is
// not marked.
func readMarker(cfg config.Config) (string, error) {
	body, err := os.ReadFile(filepath.Join(cfg.ColdRoot, markerName))
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read cold_root marker: %w", err)
	}
	return strings.TrimSpace(string(body)), nil
}

func writeMarker(cfg config.Config, installID string) error {
	if err := os.MkdirAll(cfg.ColdRoot, 0o755); err != nil {
		return fmt.Errorf("prepare cold_root: %w", err)
	}
	if err := renameio.WriteFile(filepath.Join(cfg.ColdRoot, markerName), []byte(installID+"\n"), 0o644); err != nil {
		return fmt.Errorf("write cold_root marker: %w", err)
	}
	return nil
}

// sameRoot reports whether store_root and cold_root name one directory, including
// through a symlink or bind mount, where nothing ever has to move.
func sameRoot(cfg config.Config) (bool, error) {
	if filepath.Clean(cfg.StoreRoot) == filepath.Clean(cfg.ColdRoot) {
		return true, nil
	}
	store, err := os.Stat(cfg.StoreRoot)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	cold, err := os.Stat(cfg.ColdRoot)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return os.SameFile(store, cold), nil
}

// move is one snapshot directory or session files root to relocate. Both paths
// are the same relative path below their root.
type move struct {
	kind string
	id   string
	from string
	to   string
}

const (
	kindSnapshot     = "snapshot"
	kindSessionFiles = "session files"
)

// pendingMoves lists what sits under store_root in the cold_root layout.
func pendingMoves(cfg config.Config) ([]move, error) {
	snapshots, err := filepath.Glob(filepath.Join(cfg.StoreRoot, "snapshots", "*", "*", "*"))
	if err != nil {
		return nil, err
	}
	files, err := filepath.Glob(filepath.Join(cfg.StoreRoot, "sessions", "*", "*", "*", "files"))
	if err != nil {
		return nil, err
	}
	moves := make([]move, 0, len(snapshots)+len(files))
	for _, from := range snapshots {
		moves = append(moves, newMove(cfg, kindSnapshot, filepath.Base(from), from))
	}
	for _, from := range files {
		moves = append(moves, newMove(cfg, kindSessionFiles, filepath.Base(filepath.Dir(from)), from))
	}
	return moves, nil
}

func newMove(cfg config.Config, kind, id, from string) move {
	rel := strings.TrimPrefix(from, filepath.Clean(cfg.StoreRoot)+string(filepath.Separator))
	return move{kind: kind, id: id, from: from, to: filepath.Join(cfg.ColdRoot, rel)}
}

// foreignMarkerError explains a marker with another install ID. A database
// restored from before the install ID existed, or recreated for the same data,
// gets a new ID, and replacing the marker adopts the data.
func foreignMarkerError(cfg config.Config, marker, installID string) error {
	path := filepath.Join(cfg.ColdRoot, markerName)
	return fmt.Errorf(
		"%w: %s is marked for install %s, the database is install %s; point cold_root at this install's data, "+
			"or, if this database was restored from a backup older than migration 000017 or recreated for the same data, "+
			"replace the contents of %s with %s",
		ErrColdRootForeign, cfg.ColdRoot, marker, installID, path, installID,
	)
}
