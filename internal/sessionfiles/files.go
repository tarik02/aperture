package sessionfiles

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/paths"
	"golang.org/x/sys/unix"
)

var (
	ErrInvalidPath  = errors.New("invalid file path")
	ErrNotFound     = errors.New("file not found")
	ErrInvalidToken = errors.New("invalid file token")
)

const tokenPrefix = "apf_"

// EntryType tells files and directories apart in a listing.
type EntryType string

const (
	EntryFile      EntryType = "file"
	EntryDirectory EntryType = "directory"
)

// Entry is a session file or a directory below the files root.
type Entry interface {
	entryType() EntryType
}

type File struct {
	Type         EntryType `json:"type"`
	Name         string    `json:"name"`
	RelativePath string    `json:"relativePath"`
	Size         int64     `json:"size"`
	ModifiedAt   time.Time `json:"modifiedAt"`
	MIMEType     string    `json:"mimeType"`
	// SandboxPath is where the session's browser sees the file, for CDP
	// DOM.setFileInputFiles. Files still in the directories used before the files
	// root have none.
	SandboxPath string `json:"sandboxPath,omitempty"`
}

func (File) entryType() EntryType { return EntryFile }

// Directory is a directory below the files root. Directories exist only there;
// the directories used before the files root are not listed as entries.
type Directory struct {
	Type         EntryType `json:"type"`
	Name         string    `json:"name"`
	RelativePath string    `json:"relativePath"`
	ModifiedAt   time.Time `json:"modifiedAt"`
}

func (Directory) entryType() EntryType { return EntryDirectory }

func describeDirectory(relative string, info fs.FileInfo) Directory {
	return Directory{
		Type:         EntryDirectory,
		Name:         path.Base(relative),
		RelativePath: relative,
		ModifiedAt:   info.ModTime().UTC(),
	}
}

// source is a directory whose files appear below prefix in session file relative
// paths. A flat source contributes only its top-level regular files.
type source struct {
	dir    string
	prefix string
	flat   bool
}

// sources lists the session files root first, then the directories that sessions
// launched before the single files root used. Those legacy directories map to the
// same relative paths and disappear once such sessions expire.
func sources(layout paths.SessionLayout) []source {
	return []source{
		{dir: layout.Files.Root},
		{dir: filepath.Join(layout.Root, "downloads"), prefix: "downloads"},
		{dir: filepath.Join(layout.Root, "recordings"), prefix: "recordings"},
		{dir: filepath.Join(layout.Artifacts, "uploads"), prefix: "uploads"},
		{dir: layout.Artifacts, prefix: "outputs", flat: true},
	}
}

// Resolve returns the host path of the session file at relative and its normalized
// relative path.
func Resolve(layout paths.SessionLayout, relative string) (string, string, error) {
	target, normalized, _, err := resolve(layout, relative)
	return target, normalized, err
}

func resolve(layout paths.SessionLayout, relative string) (string, string, source, error) {
	normalized, err := Normalize(relative)
	if err != nil {
		return "", "", source{}, err
	}
	for _, src := range sources(layout) {
		inner, ok := strings.CutPrefix(normalized, src.prefix+"/")
		if src.prefix == "" {
			inner, ok = normalized, true
		}
		if !ok || (src.flat && strings.Contains(inner, "/")) {
			continue
		}
		target, err := paths.JoinUnderRoot(src.dir, filepath.FromSlash(inner))
		if err != nil {
			return "", "", source{}, ErrInvalidPath
		}
		info, err := os.Stat(target)
		// ENOTDIR: a parent component is a file, so nothing is at the path.
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, unix.ENOTDIR) {
			continue
		}
		if err != nil {
			return "", "", source{}, err
		}
		if err := paths.ValidateTrustedPath(src.dir, target); err != nil {
			return "", "", source{}, ErrInvalidPath
		}
		if !info.Mode().IsRegular() {
			return "", "", source{}, ErrNotFound
		}
		return target, normalized, src, nil
	}
	return "", "", source{}, ErrNotFound
}

// RelativePath maps a host path inside the session's files to its relative path.
func RelativePath(layout paths.SessionLayout, fullPath string) (string, error) {
	for _, src := range sources(layout) {
		if paths.ValidateTrustedPath(src.dir, fullPath) != nil {
			continue
		}
		rel, err := filepath.Rel(src.dir, fullPath)
		if err != nil {
			return "", err
		}
		if src.flat && strings.Contains(rel, string(filepath.Separator)) {
			continue
		}
		return path.Join(src.prefix, filepath.ToSlash(rel)), nil
	}
	return "", ErrInvalidPath
}

func Get(layout paths.SessionLayout, relative string) (File, error) {
	fullPath, normalized, src, err := resolve(layout, relative)
	if err != nil {
		return File{}, err
	}
	info, err := os.Stat(fullPath)
	if err != nil {
		return File{}, err
	}
	return Describe(fullPath, normalized, src.sandboxPath(normalized), info), nil
}

// Describe builds the metadata of the session file at fullPath.
func Describe(fullPath, relative, sandboxPath string, info fs.FileInfo) File {
	return File{
		Type:         EntryFile,
		Name:         path.Base(relative),
		RelativePath: relative,
		Size:         info.Size(),
		ModifiedAt:   info.ModTime().UTC(),
		MIMEType:     detectMIME(fullPath),
		SandboxPath:  sandboxPath,
	}
}

// SandboxPath is the browser-visible path of a file below the files root.
func SandboxPath(relative string) string {
	return path.Join(paths.SandboxFilesRoot, relative)
}

func (src source) sandboxPath(relative string) string {
	if src.prefix != "" {
		return ""
	}
	return SandboxPath(relative)
}

// Normalize rejects absolute, escaping, and hidden paths. Hidden entries hold
// in-progress uploads and recording segments, which are not session files yet.
func Normalize(relative string) (string, error) {
	if relative == "" || filepath.IsAbs(relative) || strings.Contains(relative, "\\") {
		return "", ErrInvalidPath
	}
	clean := path.Clean(relative)
	if clean == "." || clean != relative || strings.HasPrefix(clean, "../") || clean == ".." {
		return "", ErrInvalidPath
	}
	for _, part := range strings.Split(clean, "/") {
		if strings.HasPrefix(part, ".") {
			return "", ErrInvalidPath
		}
	}
	return clean, nil
}

// List returns every session file and every directory below the files root. A
// relative path present in several sources is reported once, from the first.
func List(layout paths.SessionLayout) ([]Entry, error) {
	entries := make([]Entry, 0)
	seen := make(map[string]struct{})
	for _, src := range sources(layout) {
		err := filepath.WalkDir(src.dir, func(full string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				if errors.Is(walkErr, fs.ErrNotExist) {
					return nil
				}
				return walkErr
			}
			if full == src.dir {
				return nil
			}
			if strings.HasPrefix(entry.Name(), ".") || entry.Type()&os.ModeSymlink != 0 {
				if entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if entry.IsDir() && src.flat {
				return filepath.SkipDir
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(src.dir, full)
			if err != nil {
				return err
			}
			relative := path.Join(src.prefix, filepath.ToSlash(rel))
			if _, ok := seen[relative]; ok {
				return nil
			}
			switch {
			case info.IsDir() && src.prefix == "":
				seen[relative] = struct{}{}
				entries = append(entries, describeDirectory(relative, info))
			case info.Mode().IsRegular():
				seen[relative] = struct{}{}
				entries = append(entries, Describe(full, relative, src.sandboxPath(relative), info))
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return entries, nil
}

func detectMIME(name string) string {
	if value := mime.TypeByExtension(filepath.Ext(name)); value != "" {
		return value
	}
	file, err := os.Open(name)
	if err != nil {
		return "application/octet-stream"
	}
	defer func() { _ = file.Close() }()
	buffer := make([]byte, 512)
	n, _ := file.Read(buffer)
	return http.DetectContentType(buffer[:n])
}

// Disposition is how a signed download asks the browser to present the file.
type Disposition string

const (
	DispositionAttachment Disposition = "attachment"
	DispositionInline     Disposition = "inline"
)

func IssueToken(secret, sessionID, relative string, disposition Disposition, expiresAt time.Time) (string, error) {
	normalized, err := Normalize(relative)
	if err != nil {
		return "", err
	}
	payload := tokenPayload{SessionID: sessionID, RelativePath: normalized, Disposition: disposition, ExpiresAt: expiresAt.Unix()}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(body)
	signed := tokenPrefix + encoded
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(signed))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return signed + "." + signature, nil
}

// VerifyToken checks a signed download token and returns the file it grants and
// its disposition. Tokens issued before dispositions existed are attachments.
func VerifyToken(secret, token, sessionID, relative string, now time.Time) (string, Disposition, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 || secret == "" || !strings.HasPrefix(parts[0], tokenPrefix) {
		return "", "", ErrInvalidToken
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(parts[0]))
	expected, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || subtle.ConstantTimeCompare(expected, mac.Sum(nil)) != 1 {
		return "", "", ErrInvalidToken
	}
	body, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(parts[0], tokenPrefix))
	if err != nil {
		return "", "", ErrInvalidToken
	}
	var payload tokenPayload
	if err := json.Unmarshal(body, &payload); err != nil || payload.SessionID != sessionID || payload.ExpiresAt <= now.Unix() {
		return "", "", ErrInvalidToken
	}
	normalized, err := Normalize(relative)
	if err != nil || payload.RelativePath != normalized {
		return "", "", ErrInvalidToken
	}
	if payload.Disposition != DispositionInline {
		return normalized, DispositionAttachment, nil
	}
	return normalized, DispositionInline, nil
}

type tokenPayload struct {
	SessionID    string      `json:"sessionId"`
	RelativePath string      `json:"relativePath"`
	Disposition  Disposition `json:"disposition,omitempty"`
	ExpiresAt    int64       `json:"expiresAt"`
}

func ContentDisposition(disposition Disposition, name string) string {
	return mime.FormatMediaType(string(disposition), map[string]string{"filename": name})
}
