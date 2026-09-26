// Package storage keeps snapshots and session files under cold_root, apart from
// the session overlay state under store_root.
package storage

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/aperture/aperture/internal/config"
)

// ErrStoreRootHasColdData reports snapshots or session files left under store_root
// after cold_root was pointed elsewhere, where Aperture would no longer find them.
var ErrStoreRootHasColdData = errors.New("snapshots or session files remain under store_root")

// Prepare creates the cold_root directories and refuses to continue while data
// that belongs under cold_root still sits under a store_root that is not it.
func Prepare(cfg config.Config) error {
	for _, dir := range []string{filepath.Join(cfg.ColdRoot, "snapshots"), filepath.Join(cfg.ColdRoot, "sessions")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("prepare cold_root: %w", err)
		}
	}
	same, err := sameRoot(cfg)
	if err != nil || same {
		return err
	}
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
