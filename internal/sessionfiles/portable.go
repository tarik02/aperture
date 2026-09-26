package sessionfiles

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"
)

// The files root may live on a filesystem without the Linux-specific operations
// used on local disks, such as NFS. Each operation tries the fast path first and
// falls back when the filesystem reports it unsupported.

const (
	// stagingDirName holds named upload staging files where unnamed ones are
	// unsupported. It is hidden, so it is never listed.
	stagingDirName = ".staging"
	// lockFileName is the file the files lock is taken on. flock on NFS is
	// emulated with POSIX locks, which need a file opened for writing.
	lockFileName = ".lock"

	// StaleStagingAge is how old a staging file must be before a sweep removes
	// it; no upload takes that long.
	StaleStagingAge = 24 * time.Hour
)

// unsupported reports errors a filesystem returns for an operation or flag it
// does not implement.
func unsupported(err error) bool {
	return errors.Is(err, unix.EOPNOTSUPP) || errors.Is(err, unix.EINVAL) || errors.Is(err, unix.ENOSYS)
}

// Staged is upload content written before it is published.
type Staged struct {
	File *os.File
	// Path names the file in the staging directory where the filesystem cannot
	// create unnamed files. It is empty for an unnamed O_TMPFILE file.
	Path string
	Size int64
}

// OnDisk reports whether the staged bytes are visible to Footprint already.
func (staged Staged) OnDisk() bool { return staged.Path != "" }

// Discard drops staged content that will not be published.
func (staged Staged) Discard() {
	_ = staged.File.Close()
	if staged.Path != "" {
		_ = os.Remove(staged.Path)
	}
}

// DropName removes the staging name once the content is published, so the files
// are not counted twice by Footprint. The open file keeps the content reachable
// until Discard.
func (staged *Staged) DropName() {
	if staged.Path != "" {
		_ = os.Remove(staged.Path)
		staged.Path = ""
	}
}

// Link gives the staged content a name in the directory, failing with EEXIST
// when the name is taken.
func (staged Staged) Link(dirFD int, name string) error {
	if staged.Path == "" {
		return linkUnnamed(staged.File, dirFD, name)
	}
	return unix.Linkat(unix.AT_FDCWD, staged.Path, dirFD, name, 0)
}

// Stage copies at most limit+1 bytes of content into a file that is not yet part
// of the session's files, so a size above limit tells the caller the content was
// too large. It prefers an unnamed file in the target directory, which vanishes
// with the process, and falls back to a named file in the staging directory.
func Stage(root string, dirFD int, content io.Reader, limit int64) (Staged, error) {
	staged, err := createStaging(root, dirFD)
	if err != nil {
		return Staged{}, err
	}
	written, copyErr := io.Copy(staged.File, io.LimitReader(content, limit+1))
	syncErr := staged.File.Sync()
	if err := errors.Join(copyErr, syncErr); err != nil {
		staged.Discard()
		return Staged{}, err
	}
	staged.Size = written
	return staged, nil
}

func createStaging(root string, dirFD int) (Staged, error) {
	fd, err := unix.Openat(dirFD, ".", unix.O_WRONLY|unix.O_TMPFILE|unix.O_CLOEXEC, 0o644)
	if err == nil {
		return Staged{File: os.NewFile(uintptr(fd), "upload")}, nil
	}
	// Kernels without O_TMPFILE support in the filesystem see a directory open.
	if !unsupported(err) && !errors.Is(err, unix.EISDIR) {
		return Staged{}, err
	}
	staging := filepath.Join(root, stagingDirName)
	if err := os.MkdirAll(staging, 0o700); err != nil {
		return Staged{}, err
	}
	file, err := os.CreateTemp(staging, "upload-*")
	if err != nil {
		return Staged{}, err
	}
	return Staged{File: file, Path: file.Name()}, nil
}

// linkUnnamed gives an O_TMPFILE file a name in the directory. linkat with
// AT_EMPTY_PATH needs CAP_DAC_READ_SEARCH before Linux 6.10, so it falls back to
// linking the file's /proc/self/fd entry, as open(2) documents for O_TMPFILE.
func linkUnnamed(file *os.File, dirFD int, name string) error {
	err := unix.Linkat(int(file.Fd()), "", dirFD, name, unix.AT_EMPTY_PATH)
	if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.EPERM) {
		err = unix.Linkat(unix.AT_FDCWD, fmt.Sprintf("/proc/self/fd/%d", file.Fd()), dirFD, name, unix.AT_SYMLINK_FOLLOW)
	}
	if errors.Is(err, unix.ENOENT) && directoryRemoved(dirFD) {
		return ErrNotFound
	}
	return err
}

// directoryRemoved reports a directory deleted while open. NFS answers a stat of
// a removed directory with ESTALE instead of a zero link count.
func directoryRemoved(dirFD int) bool {
	var stat unix.Stat_t
	err := unix.Fstat(dirFD, &stat)
	return errors.Is(err, unix.ESTALE) || (err == nil && stat.Nlink == 0)
}

// publish links staged content into the directory under name, or a numbered
// variant when name is taken. Linking never replaces an existing entry.
func publish(staged Staged, dirFD int, name string) (string, error) {
	for sequence := 0; ; sequence++ {
		candidate := numberedName(name, sequence)
		err := staged.Link(dirFD, candidate)
		if errors.Is(err, unix.EEXIST) {
			continue
		}
		if errors.Is(err, unix.ENOENT) && directoryRemoved(dirFD) {
			return "", ErrNotFound
		}
		if err != nil {
			return "", err
		}
		return candidate, nil
	}
}

func numberedName(name string, sequence int) string {
	if sequence == 0 {
		return name
	}
	extension := filepath.Ext(name)
	return fmt.Sprintf("%s-%d%s", name[:len(name)-len(extension)], sequence, extension)
}

// RenameNoReplace moves source to target and fails with EEXIST instead of
// replacing an existing target. Where renameat2 flags are unsupported, a file is
// hard-linked and unlinked, which cannot replace either; a directory is checked
// and renamed, which callers keep safe by holding the files lock.
func RenameNoReplace(source, target string) error {
	err := unix.Renameat2(unix.AT_FDCWD, source, unix.AT_FDCWD, target, unix.RENAME_NOREPLACE)
	if !unsupported(err) {
		return err
	}
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		if err := os.Link(source, target); err != nil {
			return err
		}
		return os.Remove(source)
	}
	if _, err := os.Lstat(target); err == nil {
		return unix.EEXIST
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.Rename(source, target)
}

// ReplaceWith atomically moves source over target within a directory, keeping
// the replaced target under source's name where the filesystem can exchange
// them. Elsewhere target is simply replaced and source no longer exists.
func ReplaceWith(dirFD int, source, target string) error {
	err := unix.Renameat2(dirFD, source, dirFD, target, unix.RENAME_EXCHANGE)
	if !unsupported(err) {
		return err
	}
	return unix.Renameat(dirFD, source, dirFD, target)
}

// Lock serializes limit checks and changes below a session's files root across the
// daemon and the session's wrapper, which both write there. It gives up when ctx
// ends, so a caller whose client went away does not keep waiting. Holders only
// check limits and rename; nobody streams request bodies under it.
func Lock(ctx context.Context, root string) (func(), error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	fd, err := unix.Open(filepath.Join(root, lockFileName), unix.O_RDWR|unix.O_CREAT|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	for {
		err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, unix.EWOULDBLOCK) {
			_ = unix.Close(fd)
			return nil, err
		}
		select {
		case <-ctx.Done():
			_ = unix.Close(fd)
			return nil, context.Cause(ctx)
		case <-time.After(20 * time.Millisecond):
		}
	}
	return func() {
		_ = unix.Flock(fd, unix.LOCK_UN)
		_ = unix.Close(fd)
	}, nil
}

// SweepStaging removes staging files older than olderThan, which uploads left
// behind when their process stopped mid-upload.
func SweepStaging(root string, olderThan time.Duration) error {
	staging := filepath.Join(root, stagingDirName)
	entries, err := os.ReadDir(staging)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	cutoff := time.Now().Add(-olderThan)
	for _, entry := range entries {
		info, err := entry.Info()
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if info.ModTime().Before(cutoff) {
			if err := os.Remove(filepath.Join(staging, entry.Name())); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return err
			}
		}
	}
	return nil
}

// internalEntry reports the bookkeeping entries at the files root that are not
// session files: the lock file and the staging directory.
func internalEntry(root, full string) bool {
	return full == filepath.Join(root, lockFileName) || full == filepath.Join(root, stagingDirName)
}
