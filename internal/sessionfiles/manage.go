package sessionfiles

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime/multipart"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"unicode"

	"github.com/aperture/aperture/internal/paths"
	"golang.org/x/sys/unix"
)

var (
	ErrBusy              = errors.New("file is being written")
	ErrExists            = errors.New("file or directory already exists")
	ErrTooLarge          = errors.New("file exceeds upload limit")
	ErrQuotaExceeded     = errors.New("session storage quota exceeded")
	ErrTooManyFiles      = errors.New("session file limit exceeded")
	ErrNotInFilesRoot    = errors.New("file is outside the session files root")
	ErrInvalidUpload     = errors.New("invalid multipart upload")
	ErrNoFiles           = errors.New("no files uploaded")
	ErrTooManyUploads    = errors.New("too many uploads in progress for this session")
	ErrDirectoryNotEmpty = errors.New("directory is not empty")
	ErrProtected         = errors.New("directory is managed by the session")
	ErrMoveIntoItself    = errors.New("cannot move a directory into itself")

	errNotDirectory = errors.New("not a directory")
)

const (
	// PendingUploadMarker prefixes the placeholder the wrapper reserves an upload
	// name with until the upload is recorded and its content swapped in.
	PendingUploadMarker = "aperture-pending:"

	MaxUploadFilesPerRequest   = 100
	MaxUploadFilesPerDirectory = 1000
	MaxEntriesPerSession       = 10000

	// Chromium writes an in-progress download under this suffix and renames it
	// when the download completes.
	inProgressDownloadSuffix = ".crdownload"
)

// MaxConcurrentUploads bounds the uploads one process streams into a session at
// once. Streamed bytes count against the quota only when they are published, so
// without it parallel uploads could each fill the whole quota on disk first.
const MaxConcurrentUploads = 3

var uploadSlots = struct {
	sync.Mutex
	active map[string]int
}{active: map[string]int{}}

// AcquireUploadSlot claims one of the session's upload slots, keyed by its files
// root, and fails with ErrTooManyUploads when they are all taken.
func AcquireUploadSlot(root string) (func(), error) {
	uploadSlots.Lock()
	defer uploadSlots.Unlock()
	if uploadSlots.active[root] >= MaxConcurrentUploads {
		return nil, ErrTooManyUploads
	}
	uploadSlots.active[root]++
	return func() {
		uploadSlots.Lock()
		defer uploadSlots.Unlock()
		uploadSlots.active[root]--
		if uploadSlots.active[root] == 0 {
			delete(uploadSlots.active, root)
		}
	}, nil
}

// Limits bound what an upload may add to a session.
type Limits struct {
	MaxFileBytes      int64
	StorageQuotaBytes int64
}

// SanitizeName turns a client-supplied file name into a safe, visible name.
func SanitizeName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(char rune) rune {
		if unicode.IsLetter(char) || unicode.IsDigit(char) || char == '.' || char == '-' || char == '_' {
			return char
		}
		return '_'
	}, name)
	name = strings.Trim(name, ".")
	if name == "" {
		return "upload"
	}
	return name
}

// Footprint sums the regular files below roots, the measure storage quotas use.
func Footprint(roots ...string) (int64, error) {
	var size int64
	for _, root := range roots {
		if root == "" {
			continue
		}
		err := filepath.WalkDir(root, func(_ string, entry os.DirEntry, err error) error {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			if err != nil {
				return err
			}
			if entry.Type()&os.ModeSymlink != 0 {
				if entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if info.Mode().IsRegular() {
				size += info.Size()
			}
			return nil
		})
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return 0, err
		}
	}
	return size, nil
}

// Delete removes one session file, or a directory below the files root. A
// directory that still has entries is only removed when recursive is set.
func Delete(layout paths.SessionLayout, relative string, recursive bool) (EntryType, error) {
	dir, normalized, err := existingDirectory(layout, relative)
	if err == nil {
		return EntryDirectory, deleteDirectory(layout, dir, normalized, recursive)
	}
	if !errors.Is(err, errNotDirectory) {
		return "", err
	}
	fullPath, _, _, err := resolve(layout, relative)
	if err != nil {
		return "", err
	}
	if err := checkNotBusy(fullPath); err != nil {
		return "", err
	}
	if err := os.Remove(fullPath); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", ErrNotFound
		}
		return "", err
	}
	return EntryFile, nil
}

func deleteDirectory(layout paths.SessionLayout, dir, normalized string, recursive bool) error {
	if isProtected(layout, normalized) {
		return ErrProtected
	}
	if err := checkTreeNotBusy(dir); err != nil {
		return err
	}
	if !recursive {
		err := os.Remove(dir)
		if errors.Is(err, unix.ENOTEMPTY) || errors.Is(err, unix.EEXIST) {
			return ErrDirectoryNotEmpty
		}
		return err
	}
	return os.RemoveAll(dir)
}

// Move renames a session file, or a directory below the files root, to another
// path below the files root, creating missing parent directories. It never
// replaces an existing entry.
func Move(ctx context.Context, layout paths.SessionLayout, from, to string) (Entry, error) {
	source, normalizedFrom, err := existingDirectory(layout, from)
	isDirectory := err == nil
	if err != nil && !errors.Is(err, errNotDirectory) {
		return nil, err
	}
	if isDirectory {
		if isProtected(layout, normalizedFrom) {
			return nil, ErrProtected
		}
		if err := checkTreeNotBusy(source); err != nil {
			return nil, err
		}
	} else {
		source, _, _, err = resolve(layout, from)
		if err != nil {
			return nil, err
		}
		if err := checkNotBusy(source); err != nil {
			return nil, err
		}
	}
	normalizedTo, err := Normalize(to)
	if err != nil {
		return nil, err
	}
	if isDirectory && (normalizedTo == normalizedFrom || strings.HasPrefix(normalizedTo, normalizedFrom+"/")) {
		return nil, ErrMoveIntoItself
	}
	unlock, err := Lock(ctx, layout.Files.Root)
	if err != nil {
		return nil, err
	}
	defer unlock()
	if err := CheckEntryBudget(layout.Files.Root, missingDirectories(layout.Files.Root, path.Dir(normalizedTo))); err != nil {
		return nil, err
	}
	target, normalized, err := prepareTarget(layout, normalizedTo)
	if err != nil {
		return nil, err
	}
	if err := RenameNoReplace(source, target); err != nil {
		if errors.Is(err, unix.EEXIST) {
			return nil, ErrExists
		}
		// Files of sessions from before the files root may sit under artifact_root,
		// which can be another filesystem.
		if errors.Is(err, unix.EXDEV) {
			return nil, ErrNotInFilesRoot
		}
		return nil, fmt.Errorf("rename session file: %w", err)
	}
	info, err := os.Stat(target)
	if err != nil {
		return nil, err
	}
	if isDirectory {
		return describeDirectory(normalized, info), nil
	}
	return Describe(target, normalized, SandboxPath(normalized), info), nil
}

// CreateDirectory creates a directory below the files root, with any missing
// parents.
func CreateDirectory(ctx context.Context, layout paths.SessionLayout, relative string) (Directory, error) {
	normalized, err := Normalize(relative)
	if err != nil {
		return Directory{}, err
	}
	unlock, err := Lock(ctx, layout.Files.Root)
	if err != nil {
		return Directory{}, err
	}
	defer unlock()
	if err := CheckEntryBudget(layout.Files.Root, missingDirectories(layout.Files.Root, normalized)); err != nil {
		return Directory{}, err
	}
	parent, _, err := prepareDirectory(layout, path.Dir(normalized))
	if err != nil {
		return Directory{}, err
	}
	target := filepath.Join(parent, path.Base(normalized))
	if err := os.Mkdir(target, 0o755); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return Directory{}, ErrExists
		}
		return Directory{}, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return Directory{}, err
	}
	return describeDirectory(normalized, info), nil
}

// existingDirectory resolves relative to a directory below the files root, or
// fails with errNotDirectory when nothing or something else is there.
func existingDirectory(layout paths.SessionLayout, relative string) (string, string, error) {
	normalized, err := Normalize(relative)
	if err != nil {
		return "", "", err
	}
	dir, err := paths.JoinUnderRoot(layout.Files.Root, filepath.FromSlash(normalized))
	if err != nil {
		return "", "", ErrInvalidPath
	}
	info, err := os.Lstat(dir)
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, unix.ENOTDIR) {
		return "", "", errNotDirectory
	}
	if err != nil {
		return "", "", err
	}
	if !info.IsDir() {
		return "", "", errNotDirectory
	}
	if err := paths.ValidateTrustedPath(layout.Files.Root, dir); err != nil {
		return "", "", ErrInvalidPath
	}
	return dir, normalized, nil
}

// isProtected reports the directories the browser, recorder, wrapper, and
// Playwright write into, which must keep existing.
func isProtected(layout paths.SessionLayout, normalized string) bool {
	for _, dir := range []string{layout.Files.Downloads, layout.Files.Recordings, layout.Files.Uploads, layout.Files.Outputs} {
		if filepath.Base(dir) == normalized {
			return true
		}
	}
	return false
}

// checkTreeNotBusy rejects a directory holding anything still being written.
// Hidden entries are active recording segments and staged uploads.
func checkTreeNotBusy(dir string) error {
	return filepath.WalkDir(dir, func(full string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if full == dir || entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if strings.HasPrefix(entry.Name(), ".") {
			return ErrBusy
		}
		if entry.Type().IsRegular() {
			return checkNotBusy(full)
		}
		return nil
	})
}

// Store writes every multipart part that has a filename into directory below the
// files root under a sanitized name, adding a numeric suffix instead of replacing
// an existing file. Either every part is stored or none is.
func Store(ctx context.Context, layout paths.SessionLayout, directory string, parts *multipart.Reader, limits Limits) ([]File, error) {
	release, err := AcquireUploadSlot(layout.Files.Root)
	if err != nil {
		return nil, err
	}
	defer release()
	dir, dirRelative, err := prepareDirectory(layout, directory)
	if err != nil {
		return nil, err
	}
	dirFD, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer func() { _ = unix.Close(dirFD) }()
	footprint, err := Footprint(layout.Upper, layout.Files.Root, layout.Cache)
	if err != nil {
		return nil, err
	}

	// Parts are staged without the lock, so a slow client delays only its own
	// upload. The limits are checked again under the lock before publishing.
	type pendingUpload struct {
		staged Staged
		name   string
	}
	pending := make([]pendingUpload, 0)
	defer func() {
		for _, upload := range pending {
			upload.staged.Discard()
		}
	}()
	for {
		part, err := parts.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("%w: %w", ErrInvalidUpload, err)
		}
		if part.FileName() == "" {
			_ = part.Close()
			continue
		}
		if len(pending) >= MaxUploadFilesPerRequest {
			_ = part.Close()
			return nil, ErrTooManyFiles
		}
		remaining := max(limits.StorageQuotaBytes-footprint, 0)
		staged, err := Stage(layout.Files.Root, dirFD, part, min(limits.MaxFileBytes, remaining))
		_ = part.Close()
		if err != nil {
			return nil, err
		}
		pending = append(pending, pendingUpload{staged: staged, name: SanitizeName(part.FileName())})
		written := staged.Size
		if written > limits.MaxFileBytes {
			return nil, ErrTooLarge
		}
		if written > remaining {
			return nil, ErrQuotaExceeded
		}
		footprint += written
	}
	if len(pending) == 0 {
		return nil, ErrNoFiles
	}

	unlock, err := Lock(ctx, layout.Files.Root)
	if err != nil {
		return nil, err
	}
	defer unlock()
	// Named staging files are below the files root, so Footprint counts them.
	var stagedBytes int64
	for _, upload := range pending {
		if !upload.staged.OnDisk() {
			stagedBytes += upload.staged.Size
		}
	}
	// The target directory may have been moved or deleted while the upload streamed.
	if !sameDirectory(dir, dirFD) {
		return nil, ErrNotFound
	}
	if err := checkStagedLimits(layout, dir, len(pending), stagedBytes, limits); err != nil {
		return nil, err
	}
	published := make([]string, 0, len(pending))
	files := make([]File, 0, len(pending))
	for _, upload := range pending {
		name, err := publish(upload.staged, dirFD, upload.name)
		if err != nil {
			for _, done := range published {
				_ = unix.Unlinkat(dirFD, done, 0)
			}
			return nil, err
		}
		published = append(published, name)
		final := filepath.Join(dir, name)
		info, err := upload.staged.File.Stat()
		if err != nil {
			for _, done := range published {
				_ = unix.Unlinkat(dirFD, done, 0)
			}
			return nil, err
		}
		relative := path.Join(dirRelative, name)
		files = append(files, Describe(final, relative, SandboxPath(relative), info))
	}
	return files, nil
}

// checkStagedLimits checks, under the lock, that the staged files fit next to
// everything already published, including uploads that finished meanwhile.
func checkStagedLimits(layout paths.SessionLayout, dir string, staged int, stagedBytes int64, limits Limits) error {
	footprint, err := Footprint(layout.Upper, layout.Files.Root, layout.Cache)
	if err != nil {
		return err
	}
	if footprint+stagedBytes > limits.StorageQuotaBytes {
		return ErrQuotaExceeded
	}
	entries, err := CountEntries(layout.Files.Root)
	if err != nil {
		return err
	}
	if entries+staged > MaxEntriesPerSession {
		return ErrTooManyFiles
	}
	listing, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	visible := 0
	for _, entry := range listing {
		if entry.Type().IsRegular() && !strings.HasPrefix(entry.Name(), ".") {
			visible++
		}
	}
	if visible+staged > MaxUploadFilesPerDirectory {
		return ErrTooManyFiles
	}
	return nil
}

// sameDirectory reports whether dir still names the directory open as dirFD.
func sameDirectory(dir string, dirFD int) bool {
	var named, open unix.Stat_t
	if unix.Lstat(dir, &named) != nil || unix.Fstat(dirFD, &open) != nil {
		return false
	}
	return named.Dev == open.Dev && named.Ino == open.Ino
}

func prepareTarget(layout paths.SessionLayout, relative string) (string, string, error) {
	normalized, err := Normalize(relative)
	if err != nil {
		return "", "", err
	}
	if strings.HasSuffix(normalized, inProgressDownloadSuffix) {
		return "", "", ErrInvalidPath
	}
	dir, _, err := prepareDirectory(layout, path.Dir(normalized))
	if err != nil {
		return "", "", err
	}
	return filepath.Join(dir, path.Base(normalized)), normalized, nil
}

// CheckEntryBudget fails when adding entries would take the files root past
// MaxEntriesPerSession. Empty files and directories cost no quota bytes, so this
// is what bounds them.
func CheckEntryBudget(root string, adding int) error {
	count, err := CountEntries(root)
	if err != nil {
		return err
	}
	if count+adding > MaxEntriesPerSession {
		return ErrTooManyFiles
	}
	return nil
}

// CountEntries counts every file and directory below root, hidden ones included,
// except the lock file and staging directory.
func CountEntries(root string) (int, error) {
	count := 0
	err := filepath.WalkDir(root, func(full string, entry fs.DirEntry, err error) error {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if internalEntry(root, full) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if full != root {
			count++
		}
		return nil
	})
	return count, err
}

// missingDirectories counts the directories of relative below root that do not
// exist yet, which creating it would add.
func missingDirectories(root, relative string) int {
	if relative == "." || relative == "" {
		return 0
	}
	parts := strings.Split(relative, "/")
	for index := range parts {
		if _, err := os.Lstat(filepath.Join(root, filepath.FromSlash(strings.Join(parts[:index+1], "/")))); err != nil {
			return len(parts) - index
		}
	}
	return 0
}

// ensureRoot creates the files root and the directories the session writes into.
// Creating them eagerly keeps their names reserved even in sessions from before the
// files root, where nothing else would have created them yet.
func ensureRoot(layout paths.SessionLayout) error {
	for _, dir := range []string{layout.Files.Downloads, layout.Files.Recordings, layout.Files.Uploads, layout.Files.Outputs} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return nil
}

// prepareDirectory creates a directory below the files root and verifies that no
// component of it is a symlink. "." names the root itself.
func prepareDirectory(layout paths.SessionLayout, relative string) (string, string, error) {
	if err := ensureRoot(layout); err != nil {
		return "", "", err
	}
	if relative == "." {
		return layout.Files.Root, "", nil
	}
	normalized, err := Normalize(relative)
	if err != nil {
		return "", "", err
	}
	dir, err := paths.JoinUnderRoot(layout.Files.Root, filepath.FromSlash(normalized))
	if err != nil {
		return "", "", ErrInvalidPath
	}
	if err := paths.ValidateTrustedPath(layout.Files.Root, dir); err != nil {
		return "", "", ErrInvalidPath
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		// A path component is a file.
		if errors.Is(err, unix.ENOTDIR) || errors.Is(err, unix.EEXIST) {
			return "", "", ErrInvalidPath
		}
		return "", "", err
	}
	// MkdirAll follows symlinks, so check again now that every component exists.
	if err := paths.ValidateTrustedPath(layout.Files.Root, dir); err != nil {
		return "", "", ErrInvalidPath
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return "", "", err
	}
	if !info.IsDir() {
		return "", "", ErrInvalidPath
	}
	return dir, normalized, nil
}

// checkNotBusy rejects files that Chromium or an upload is still writing.
func checkNotBusy(fullPath string) error {
	if strings.HasSuffix(fullPath, inProgressDownloadSuffix) {
		return ErrBusy
	}
	file, err := os.Open(fullPath)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	head := make([]byte, len(PendingUploadMarker))
	n, err := io.ReadFull(file, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return err
	}
	if string(head[:n]) == PendingUploadMarker {
		return ErrBusy
	}
	return nil
}
