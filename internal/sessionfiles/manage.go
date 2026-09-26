package sessionfiles

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime/multipart"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"unicode"

	"github.com/aperture/aperture/internal/paths"
	"golang.org/x/sys/unix"
)

var (
	ErrBusy           = errors.New("file is being written")
	ErrExists         = errors.New("file already exists")
	ErrTooLarge       = errors.New("file exceeds upload limit")
	ErrQuotaExceeded  = errors.New("session storage quota exceeded")
	ErrTooManyFiles   = errors.New("directory file limit exceeded")
	ErrNotInFilesRoot = errors.New("file is outside the session files root")
	ErrInvalidUpload  = errors.New("invalid multipart upload")
	ErrNoFiles        = errors.New("no files uploaded")
)

const (
	// PendingUploadMarker prefixes the placeholder the wrapper reserves an upload
	// name with until the upload is recorded and its content swapped in.
	PendingUploadMarker = "aperture-pending:"

	MaxUploadFilesPerRequest   = 100
	MaxUploadFilesPerDirectory = 1000

	// Chromium writes an in-progress download under this suffix and renames it
	// when the download completes.
	inProgressDownloadSuffix = ".crdownload"
)

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

// Delete removes one session file. Directories it leaves empty are removed,
// except the ones the session writes into.
func Delete(layout paths.SessionLayout, relative string) error {
	fullPath, _, src, err := resolve(layout, relative)
	if err != nil {
		return err
	}
	if err := checkNotBusy(fullPath); err != nil {
		return err
	}
	if err := os.Remove(fullPath); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ErrNotFound
		}
		return err
	}
	if src.prefix == "" {
		pruneEmptyParents(layout.Files, filepath.Dir(fullPath))
	}
	return nil
}

// Move renames a session file to another path below the files root, creating
// missing directories. It never replaces an existing file.
func Move(layout paths.SessionLayout, from, to string) (File, error) {
	fullPath, _, src, err := resolve(layout, from)
	if err != nil {
		return File{}, err
	}
	if err := checkNotBusy(fullPath); err != nil {
		return File{}, err
	}
	target, normalized, err := prepareTarget(layout, to)
	if err != nil {
		return File{}, err
	}
	if err := unix.Renameat2(unix.AT_FDCWD, fullPath, unix.AT_FDCWD, target, unix.RENAME_NOREPLACE); err != nil {
		if errors.Is(err, unix.EEXIST) {
			return File{}, ErrExists
		}
		// Files of sessions from before the files root may sit under artifact_root,
		// which can be another filesystem.
		if errors.Is(err, unix.EXDEV) {
			return File{}, ErrNotInFilesRoot
		}
		return File{}, fmt.Errorf("rename session file: %w", err)
	}
	if src.prefix == "" {
		pruneEmptyParents(layout.Files, filepath.Dir(fullPath))
	}
	info, err := os.Stat(target)
	if err != nil {
		return File{}, err
	}
	return Describe(target, normalized, SandboxPath(normalized), info), nil
}

// Store writes every multipart part that has a filename into directory below the
// files root under a sanitized name, adding a numeric suffix instead of replacing
// an existing file. Either every part is stored or none is.
func Store(layout paths.SessionLayout, directory string, parts *multipart.Reader, limits Limits) ([]File, error) {
	dir, dirRelative, err := prepareDirectory(layout, directory)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	visible := 0
	for _, entry := range entries {
		if entry.Type().IsRegular() && !strings.HasPrefix(entry.Name(), ".") {
			visible++
		}
	}
	footprint, err := Footprint(layout.Upper, layout.Files.Root, layout.Cache)
	if err != nil {
		return nil, err
	}

	type staged struct {
		temp string
		name string
	}
	pending := make([]staged, 0)
	stored := make([]string, 0)
	discard := func() {
		for _, upload := range pending {
			_ = os.Remove(upload.temp)
		}
		for _, final := range stored {
			_ = os.Remove(final)
		}
	}
	for {
		part, err := parts.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			discard()
			return nil, fmt.Errorf("%w: %w", ErrInvalidUpload, err)
		}
		if part.FileName() == "" {
			_ = part.Close()
			continue
		}
		if len(pending) >= MaxUploadFilesPerRequest || visible+len(pending) >= MaxUploadFilesPerDirectory {
			_ = part.Close()
			discard()
			return nil, ErrTooManyFiles
		}
		limit := min(limits.MaxFileBytes, max(limits.StorageQuotaBytes-footprint, 0))
		temp, written, err := writeTemp(dir, part, limit)
		_ = part.Close()
		if err != nil {
			discard()
			return nil, err
		}
		pending = append(pending, staged{temp: temp, name: SanitizeName(part.FileName())})
		if written > limits.MaxFileBytes {
			discard()
			return nil, ErrTooLarge
		}
		if written > limit {
			discard()
			return nil, ErrQuotaExceeded
		}
		footprint += written
	}
	if len(pending) == 0 {
		return nil, ErrNoFiles
	}

	files := make([]File, 0, len(pending))
	for len(pending) > 0 {
		upload := pending[0]
		final, name, err := publish(upload.temp, dir, upload.name)
		if err != nil {
			discard()
			return nil, err
		}
		pending = pending[1:]
		stored = append(stored, final)
		info, err := os.Stat(final)
		if err != nil {
			discard()
			return nil, err
		}
		relative := path.Join(dirRelative, name)
		files = append(files, Describe(final, relative, SandboxPath(relative), info))
	}
	return files, nil
}

// writeTemp copies at most limit+1 bytes into a hidden file in dir, so a result
// above limit tells the caller the content was too large.
func writeTemp(dir string, content io.Reader, limit int64) (string, int64, error) {
	file, err := os.CreateTemp(dir, ".upload-*")
	if err != nil {
		return "", 0, err
	}
	written, copyErr := io.Copy(file, io.LimitReader(content, limit+1))
	syncErr := file.Sync()
	closeErr := file.Close()
	if err := errors.Join(copyErr, syncErr, closeErr); err != nil {
		_ = os.Remove(file.Name())
		return "", 0, err
	}
	return file.Name(), written, nil
}

func publish(temp, dir, name string) (string, string, error) {
	extension := filepath.Ext(name)
	stem := strings.TrimSuffix(name, extension)
	for sequence := 0; ; sequence++ {
		candidate := name
		if sequence > 0 {
			candidate = fmt.Sprintf("%s-%d%s", stem, sequence, extension)
		}
		final := filepath.Join(dir, candidate)
		err := unix.Renameat2(unix.AT_FDCWD, temp, unix.AT_FDCWD, final, unix.RENAME_NOREPLACE)
		if errors.Is(err, unix.EEXIST) {
			continue
		}
		if err != nil {
			return "", "", err
		}
		return final, candidate, nil
	}
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

// prepareDirectory creates a directory below the files root and verifies that no
// component of it is a symlink. "." names the root itself.
func prepareDirectory(layout paths.SessionLayout, relative string) (string, string, error) {
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

// pruneEmptyParents removes empty directories from dir upwards. It keeps the root
// and the directories the browser, recorder, wrapper, and Playwright write into.
func pruneEmptyParents(files paths.SessionFilesLayout, dir string) {
	kept := []string{files.Root, files.Downloads, files.Recordings, files.Uploads, files.Outputs}
	for strings.HasPrefix(dir, files.Root+string(filepath.Separator)) && !slices.Contains(kept, dir) {
		if os.Remove(dir) != nil {
			return
		}
		dir = filepath.Dir(dir)
	}
}
