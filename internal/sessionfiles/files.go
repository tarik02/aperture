package sessionfiles

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/paths"
)

var (
	ErrInvalidPath  = errors.New("invalid file path")
	ErrNotFound     = errors.New("file not found")
	ErrInvalidToken = errors.New("invalid file token")
)

const tokenPrefix = "apf_"

type File struct {
	Name         string    `json:"name"`
	RelativePath string    `json:"relativePath"`
	Size         int64     `json:"size"`
	ModifiedAt   time.Time `json:"modifiedAt"`
	MIMEType     string    `json:"mimeType"`
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
	normalized, err := Normalize(relative)
	if err != nil {
		return "", "", err
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
			return "", "", ErrInvalidPath
		}
		info, err := os.Stat(target)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", "", err
		}
		if err := paths.ValidateTrustedPath(src.dir, target); err != nil {
			return "", "", ErrInvalidPath
		}
		if !info.Mode().IsRegular() {
			return "", "", ErrNotFound
		}
		return target, normalized, nil
	}
	return "", "", ErrNotFound
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
	fullPath, normalized, err := Resolve(layout, relative)
	if err != nil {
		return File{}, err
	}
	info, err := os.Stat(fullPath)
	if err != nil {
		return File{}, err
	}
	return Describe(fullPath, normalized, info), nil
}

// Describe builds the metadata of the session file at fullPath.
func Describe(fullPath, relative string, info fs.FileInfo) File {
	return File{
		Name:         path.Base(relative),
		RelativePath: relative,
		Size:         info.Size(),
		ModifiedAt:   info.ModTime().UTC(),
		MIMEType:     detectMIME(fullPath),
	}
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

// List returns every session file. A relative path present in several sources is
// reported once, from the first.
func List(layout paths.SessionLayout) ([]File, error) {
	files := make([]File, 0)
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
			if entry.IsDir() {
				if src.flat {
					return filepath.SkipDir
				}
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return nil
			}
			rel, err := filepath.Rel(src.dir, full)
			if err != nil {
				return err
			}
			relative := path.Join(src.prefix, filepath.ToSlash(rel))
			if _, ok := seen[relative]; ok {
				return nil
			}
			seen[relative] = struct{}{}
			files = append(files, Describe(full, relative, info))
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return files, nil
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

func IssueToken(secret, sessionID, relative string, expiresAt time.Time) (string, error) {
	normalized, err := Normalize(relative)
	if err != nil {
		return "", err
	}
	payload := tokenPayload{SessionID: sessionID, RelativePath: normalized, ExpiresAt: expiresAt.Unix()}
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

func VerifyToken(secret, token, sessionID, relative string, now time.Time) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 || secret == "" || !strings.HasPrefix(parts[0], tokenPrefix) {
		return "", ErrInvalidToken
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(parts[0]))
	expected, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || subtle.ConstantTimeCompare(expected, mac.Sum(nil)) != 1 {
		return "", ErrInvalidToken
	}
	body, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(parts[0], tokenPrefix))
	if err != nil {
		return "", ErrInvalidToken
	}
	var payload tokenPayload
	if err := json.Unmarshal(body, &payload); err != nil || payload.SessionID != sessionID || payload.ExpiresAt <= now.Unix() {
		return "", ErrInvalidToken
	}
	normalized, err := Normalize(relative)
	if err != nil || payload.RelativePath != normalized {
		return "", ErrInvalidToken
	}
	return normalized, nil
}

type tokenPayload struct {
	SessionID    string `json:"sessionId"`
	RelativePath string `json:"relativePath"`
	ExpiresAt    int64  `json:"expiresAt"`
}

func ContentDisposition(name string) string { return fmt.Sprintf(`attachment; filename=%q`, name) }
