package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/overlay"
	"golang.org/x/sys/unix"
)

// ErrSessionsMounted reports session overlays that are still mounted, whose
// browsers may be writing to their files or reading their base snapshot.
var ErrSessionsMounted = errors.New("session overlays are still mounted")

// ErrRunAsRoot reports a migration started as root instead of the Aperture user.
var ErrRunAsRoot = errors.New("run the storage migration as the Aperture user, not root")

// stagingSuffix names a copy in progress next to its destination, so an
// interrupted migration never leaves a partial tree under the final name.
const stagingSuffix = ".migrating"

// Migrate moves snapshots and session files from store_root to cold_root. Within
// one filesystem it renames; across filesystems it copies to a staging name,
// verifies the copy byte for byte, and renames it into place. Sources are removed
// once every entry is published. It is safe to run again after an interruption.
// Aperture must be stopped and no session overlay mounted while it runs.
func Migrate(ctx context.Context, cfg config.Config, repo *db.Repository, out io.Writer) error {
	// Directories and copies made by root would be owned by root, where the
	// Aperture user could no longer add snapshots or session files.
	if os.Geteuid() == 0 {
		return ErrRunAsRoot
	}
	if err := os.MkdirAll(cfg.ColdRoot, 0o755); err != nil {
		return fmt.Errorf("prepare cold_root: %w", err)
	}
	same, err := sameRoot(cfg)
	if err != nil {
		return err
	}
	if same {
		_, err := fmt.Fprintln(out, "cold_root is store_root; nothing to migrate")
		return err
	}
	if err := checkNoMountedSessions(cfg); err != nil {
		return err
	}
	moves, err := pendingMoves(cfg)
	if err != nil {
		return err
	}

	copier := &treeCopier{links: map[fileKey]string{}}
	for _, item := range moves {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := copier.move(item.from, item.to); err != nil {
			return fmt.Errorf("migrate %s %s: %w", item.kind, item.id, err)
		}
		if err := recordMove(ctx, repo, item); err != nil {
			return fmt.Errorf("record migrated %s %s: %w", item.kind, item.id, err)
		}
		if _, err := fmt.Fprintf(out, "moved %s %s to %s\n", item.kind, item.id, item.to); err != nil {
			return err
		}
	}
	for _, item := range moves {
		if err := os.RemoveAll(item.from); err != nil {
			return fmt.Errorf("remove migrated %s %s from store_root: %w", item.kind, item.id, err)
		}
	}
	removeEmptyBuckets(filepath.Join(cfg.StoreRoot, "snapshots"))
	_, err = fmt.Fprintf(out, "migrated %d entries to %s\n", len(moves), cfg.ColdRoot)
	return err
}

func checkNoMountedSessions(cfg config.Config) error {
	merged, err := filepath.Glob(filepath.Join(cfg.StoreRoot, "sessions", "*", "*", "*", "merged"))
	if err != nil {
		return err
	}
	var mounted []string
	for _, dir := range merged {
		isMounted, err := overlay.IsMergedMounted(dir)
		if err != nil {
			return err
		}
		if isMounted {
			mounted = append(mounted, filepath.Base(filepath.Dir(dir)))
		}
	}
	if len(mounted) > 0 {
		return fmt.Errorf("%w: stop or suspend sessions %s first", ErrSessionsMounted, strings.Join(mounted, ", "))
	}
	return nil
}

// recordMove points the paths the database keeps for the moved entry at its new
// location. Entries without a row are left over from failed promotions or
// expired sessions and move as they are.
func recordMove(ctx context.Context, repo *db.Repository, item move) error {
	switch item.kind {
	case kindSnapshot:
		row, err := repo.GetSnapshotByID(ctx, item.id)
		if err != nil || row == nil || row.Path != item.from {
			return err
		}
		row.Path = item.to
		return repo.UpdateSnapshot(ctx, row)
	case kindSessionFiles:
		row, err := repo.GetSessionByID(ctx, item.id)
		if err != nil || row == nil || row.DownloadsPath != filepath.Join(item.from, "downloads") {
			return err
		}
		row.DownloadsPath = filepath.Join(item.to, "downloads")
		return repo.UpdateSession(ctx, row)
	default:
		return fmt.Errorf("unknown entry kind %q", item.kind)
	}
}

// removeEmptyBuckets removes the bucket directories below root that the moves
// emptied, and root itself once empty. Non-empty directories stay.
func removeEmptyBuckets(root string) {
	outer, _ := filepath.Glob(filepath.Join(root, "*"))
	for _, first := range outer {
		inner, _ := filepath.Glob(filepath.Join(first, "*"))
		for _, second := range inner {
			_ = os.Remove(second)
		}
		_ = os.Remove(first)
	}
	_ = os.Remove(root)
}

type fileKey struct {
	dev uint64
	ino uint64
}

// treeCopier copies trees across filesystems. Snapshots hard-link unchanged
// files to their parent snapshot, so it links copies of one source inode
// together again instead of multiplying them.
type treeCopier struct {
	// links maps a source inode to the final path of its first copy.
	links map[fileKey]string
	// staging is where the tree being copied is built before it is renamed to
	// final, so links to its own files are made from staging.
	staging string
	final   string
}

// move publishes from at to. A copied source is left in place for the caller to
// remove once every entry is published: removing it earlier would drop the link
// count that tells later snapshots' files they are shared.
func (c *treeCopier) move(from, to string) error {
	if _, err := os.Lstat(to); err == nil {
		// A previous run published the copy but stopped before removing the source.
		if err := verifyTree(from, to); err != nil {
			return fmt.Errorf("%s already exists and differs from %s: %w", to, from, err)
		}
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}
	err := os.Rename(from, to)
	if !errors.Is(err, unix.EXDEV) {
		return err
	}

	c.staging = to + stagingSuffix
	c.final = to
	if err := os.RemoveAll(c.staging); err != nil {
		return err
	}
	if err := c.copyTree(from); err != nil {
		return err
	}
	if err := verifyTree(from, c.staging); err != nil {
		return fmt.Errorf("verify copy: %w", err)
	}
	return os.Rename(c.staging, to)
}

func (c *treeCopier) copyTree(from string) error {
	var dirs []string
	err := filepath.WalkDir(from, func(source string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(from, source)
		if err != nil {
			return err
		}
		target := filepath.Join(c.staging, rel)
		info, err := os.Lstat(source)
		if err != nil {
			return err
		}
		switch {
		case info.IsDir():
			dirs = append(dirs, rel)
			return os.Mkdir(target, 0o700)
		case info.Mode()&fs.ModeSymlink != 0:
			link, err := os.Readlink(source)
			if err != nil {
				return err
			}
			if err := os.Symlink(link, target); err != nil {
				return err
			}
		case info.Mode().IsRegular():
			if err := c.copyFile(source, rel, info); err != nil {
				return err
			}
		default:
			return fmt.Errorf("%s: unsupported file type %s", source, info.Mode().Type())
		}
		return preserveMetadata(target, info)
	})
	if err != nil {
		return err
	}
	// Creating entries updates a directory's mtime and may need permissions its
	// source lacks, so directories get their metadata last, deepest first.
	for index := len(dirs) - 1; index >= 0; index-- {
		info, err := os.Lstat(filepath.Join(from, dirs[index]))
		if err != nil {
			return err
		}
		if err := preserveMetadata(filepath.Join(c.staging, dirs[index]), info); err != nil {
			return err
		}
	}
	return nil
}

func (c *treeCopier) copyFile(source, rel string, info fs.FileInfo) error {
	target := filepath.Join(c.staging, rel)
	stat, ok := info.Sys().(*syscall.Stat_t)
	if ok && stat.Nlink > 1 {
		key := fileKey{dev: stat.Dev, ino: stat.Ino}
		if linked, seen := c.links[key]; seen {
			if linkedRel, err := filepath.Rel(c.final, linked); err == nil && !strings.HasPrefix(linkedRel, "..") {
				linked = filepath.Join(c.staging, linkedRel)
			}
			// A failed link, such as to a copy on another filesystem, falls back to
			// copying.
			if err := os.Link(linked, target); err == nil {
				return nil
			}
		} else {
			c.links[key] = filepath.Join(c.final, rel)
		}
	}

	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// preserveMetadata keeps permissions and modification times, which session file
// listings report.
func preserveMetadata(target string, info fs.FileInfo) error {
	if info.Mode()&fs.ModeSymlink != 0 {
		return nil
	}
	if err := os.Chmod(target, info.Mode()); err != nil {
		return err
	}
	return os.Chtimes(target, info.ModTime(), info.ModTime())
}

// verifyTree checks that replica holds exactly the entries of source, with the same
// types, permissions, link targets, and file contents.
func verifyTree(source, replica string) error {
	sourceCount := 0
	err := filepath.WalkDir(source, func(path string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		sourceCount++
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		return verifyEntry(path, filepath.Join(replica, rel))
	})
	if err != nil {
		return err
	}
	copyCount := 0
	err = filepath.WalkDir(replica, func(_ string, _ fs.DirEntry, err error) error {
		copyCount++
		return err
	})
	if err != nil {
		return err
	}
	if copyCount != sourceCount {
		return fmt.Errorf("%s has %d entries, %s has %d", replica, copyCount, source, sourceCount)
	}
	return nil
}

func verifyEntry(source, replica string) error {
	sourceInfo, err := os.Lstat(source)
	if err != nil {
		return err
	}
	copyInfo, err := os.Lstat(replica)
	if err != nil {
		return err
	}
	if sourceInfo.Mode() != copyInfo.Mode() {
		return fmt.Errorf("%s: mode %s, copy has %s", source, sourceInfo.Mode(), copyInfo.Mode())
	}
	switch {
	case sourceInfo.Mode()&fs.ModeSymlink != 0:
		sourceLink, err := os.Readlink(source)
		if err != nil {
			return err
		}
		copyLink, err := os.Readlink(replica)
		if err != nil {
			return err
		}
		if sourceLink != copyLink {
			return fmt.Errorf("%s: symlink target differs", source)
		}
	case sourceInfo.Mode().IsRegular():
		if sourceInfo.Size() != copyInfo.Size() {
			return fmt.Errorf("%s: size %d, copy has %d", source, sourceInfo.Size(), copyInfo.Size())
		}
		sourceSum, err := fileSum(source)
		if err != nil {
			return err
		}
		copySum, err := fileSum(replica)
		if err != nil {
			return err
		}
		if !bytes.Equal(sourceSum, copySum) {
			return fmt.Errorf("%s: content differs", source)
		}
	}
	return nil
}

func fileSum(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return nil, err
	}
	return hash.Sum(nil), nil
}
