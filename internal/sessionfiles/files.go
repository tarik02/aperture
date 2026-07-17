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

func Resolve(layout paths.SessionLayout, relative string) (string, string, error) {
	normalized, err := Normalize(relative)
	if err != nil {
		return "", "", err
	}
	first := strings.Split(normalized, "/")[0]
	if first != "downloads" && first != "recordings" {
		return "", "", ErrInvalidPath
	}
	target, err := paths.JoinUnderRoot(layout.Root, filepath.FromSlash(normalized))
	if err != nil {
		return "", "", ErrInvalidPath
	}
	if err := paths.ValidateTrustedPath(layout.Root, target); err != nil {
		return "", "", ErrInvalidPath
	}
	info, err := os.Stat(target)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", "", ErrNotFound
		}
		return "", "", err
	}
	if !info.Mode().IsRegular() {
		return "", "", ErrNotFound
	}
	return target, normalized, nil
}

func Normalize(relative string) (string, error) {
	if relative == "" || filepath.IsAbs(relative) || strings.Contains(relative, "\\") {
		return "", ErrInvalidPath
	}
	clean := path.Clean(relative)
	if clean == "." || clean != relative || strings.HasPrefix(clean, "../") || clean == ".." {
		return "", ErrInvalidPath
	}
	return clean, nil
}

func List(layout paths.SessionLayout) ([]File, error) {
	files := make([]File, 0)
	for _, root := range []string{layout.Downloads, layout.Recordings} {
		if err := filepath.WalkDir(root, func(full string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				if errors.Is(walkErr, fs.ErrNotExist) {
					return nil
				}
				return walkErr
			}
			if entry.Type()&os.ModeSymlink != 0 {
				if entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if entry.IsDir() {
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return nil
			}
			rel, err := filepath.Rel(layout.Root, full)
			if err != nil {
				return err
			}
			files = append(files, File{Name: entry.Name(), RelativePath: filepath.ToSlash(rel), Size: info.Size(), ModifiedAt: info.ModTime().UTC(), MIMEType: detectMIME(full)})
			return nil
		}); err != nil {
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
