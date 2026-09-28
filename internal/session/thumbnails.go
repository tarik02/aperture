package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/paths"
)

// ErrThumbnailNotFound means the session or target has no thumbnail to show.
var ErrThumbnailNotFound = errors.New("thumbnail not found")

// ErrThumbnailCapture means the running browser could not produce a thumbnail.
var ErrThumbnailCapture = errors.New("thumbnail capture failed")

const (
	thumbnailRequestTimeout = 5 * time.Second
	// Saving thumbnails delays suspension, so it gets a fixed budget.
	thumbnailPersistTimeout = 10 * time.Second
	thumbnailMaxBytes       = 4 << 20
	sessionThumbnailFile    = "session.jpg"
)

var thumbnailTargetIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// Thumbnail is a JPEG of one browser target.
type Thumbnail struct {
	Image      []byte
	CapturedAt time.Time
}

// Thumbnail returns a tenant-owned session's thumbnail, or one target's when targetID is set.
// It never wakes the session: a suspended session serves the thumbnails saved when it suspended.
func (s *Service) Thumbnail(ctx context.Context, tenantID, sessionID, targetID string) (Thumbnail, error) {
	sessionRow, err := s.requireTenantSession(ctx, tenantID, sessionID)
	if err != nil {
		return Thumbnail{}, err
	}
	return s.sessionThumbnail(ctx, sessionRow, targetID)
}

// AuthorizedThumbnail is Thumbnail for a session token or an editor or viewer capability.
func (s *Service) AuthorizedThumbnail(ctx context.Context, routeSessionID, authorization, targetID string) (Thumbnail, error) {
	raw, err := bearerToken(authorization)
	if err != nil {
		return Thumbnail{}, err
	}
	var sessionRow *db.Session
	if strings.HasPrefix(raw, "aps_") {
		sessionRow, err = s.authorizedSession(ctx, routeSessionID, authorization)
	} else {
		var capability *CollaborationCapabilityAuth
		capability, err = s.AuthenticateCollaborationCapability(ctx, routeSessionID, authorization)
		if capability != nil {
			sessionRow = capability.Session
		}
	}
	if err != nil {
		return Thumbnail{}, err
	}
	return s.sessionThumbnail(ctx, sessionRow, targetID)
}

// SignedThumbnail serves a thumbnail for a signed URL, whose token has already named the session.
func (s *Service) SignedThumbnail(ctx context.Context, sessionID, targetID string) (Thumbnail, error) {
	sessionRow, err := s.repo.GetSessionByID(ctx, sessionID)
	if err != nil {
		return Thumbnail{}, err
	}
	if sessionRow == nil {
		return Thumbnail{}, ErrNotFound
	}
	if isExpired(sessionRow.ExpiresAt, s.now().UTC()) {
		return Thumbnail{}, ErrExpired
	}
	return s.sessionThumbnail(ctx, sessionRow, targetID)
}

// ThumbnailAvailable reports whether a session can currently serve a thumbnail, without capturing one.
func (s *Service) ThumbnailAvailable(sessionRow db.Session) bool {
	switch sessionRow.Status {
	case db.SessionStatusRunning:
		return true
	case db.SessionStatusSuspended:
		dir, err := s.thumbnailDir(sessionRow.ID)
		if err != nil {
			return false
		}
		_, err = os.Stat(filepath.Join(dir, sessionThumbnailFile))
		return err == nil
	default:
		return false
	}
}

func (s *Service) sessionThumbnail(ctx context.Context, sessionRow *db.Session, targetID string) (Thumbnail, error) {
	if targetID != "" && !thumbnailTargetIDPattern.MatchString(targetID) {
		return Thumbnail{}, ErrThumbnailNotFound
	}
	switch sessionRow.Status {
	case db.SessionStatusRunning:
		return s.liveThumbnail(ctx, sessionRow, targetID)
	case db.SessionStatusSuspended:
		return s.storedThumbnail(sessionRow.ID, targetID)
	default:
		return Thumbnail{}, ErrThumbnailNotFound
	}
}

func (s *Service) liveThumbnail(ctx context.Context, sessionRow *db.Session, targetID string) (Thumbnail, error) {
	port, token, err := wrapperControl(sessionRow)
	if err != nil {
		return Thumbnail{}, err
	}
	query := url.Values{}
	if targetID != "" {
		query.Set("targetId", targetID)
	}
	response, err := wrapperGet(ctx, port, token, "/thumbnail?"+query.Encode(), thumbnailRequestTimeout)
	if err != nil {
		return Thumbnail{}, fmt.Errorf("%w: %w", ErrThumbnailCapture, err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusNotFound {
		return Thumbnail{}, ErrThumbnailNotFound
	}
	if response.StatusCode != http.StatusOK {
		return Thumbnail{}, fmt.Errorf("%w: wrapper returned %s", ErrThumbnailCapture, response.Status)
	}
	image, err := io.ReadAll(io.LimitReader(response.Body, thumbnailMaxBytes+1))
	if err != nil {
		return Thumbnail{}, err
	}
	if len(image) > thumbnailMaxBytes {
		return Thumbnail{}, fmt.Errorf("%w: wrapper thumbnail is too large", ErrThumbnailCapture)
	}
	capturedAt, err := time.Parse(time.RFC3339Nano, response.Header.Get(browser.ThumbnailCapturedAtHeader))
	if err != nil {
		return Thumbnail{}, fmt.Errorf("parse thumbnail capture time: %w", err)
	}
	return Thumbnail{Image: image, CapturedAt: capturedAt}, nil
}

func (s *Service) storedThumbnail(sessionID, targetID string) (Thumbnail, error) {
	dir, err := s.thumbnailDir(sessionID)
	if err != nil {
		return Thumbnail{}, err
	}
	path := filepath.Join(dir, sessionThumbnailFile)
	if targetID != "" {
		path = filepath.Join(dir, "targets", targetID+".jpg")
	}
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return Thumbnail{}, ErrThumbnailNotFound
	}
	if err != nil {
		return Thumbnail{}, err
	}
	image, err := os.ReadFile(path)
	if err != nil {
		return Thumbnail{}, err
	}
	return Thumbnail{Image: image, CapturedAt: info.ModTime().UTC()}, nil
}

// thumbnailDir sits next to the session files root, so it is cold storage that is not listed as a
// session file and is removed with the rest of the session's cold data.
func (s *Service) thumbnailDir(sessionID string) (string, error) {
	layout, err := paths.Session(s.cfg, sessionID)
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(layout.Files.Root), "thumbnails"), nil
}

// persistThumbnails saves the running session's thumbnails before its browser stops. It replaces
// the previous set, or removes it when persistence is disabled.
func (s *Service) persistThumbnails(ctx context.Context, sessionRow *db.Session) error {
	dir, err := s.thumbnailDir(sessionRow.ID)
	if err != nil {
		return err
	}
	if !s.cfg.ThumbnailsPersistOnSuspend {
		return os.RemoveAll(dir)
	}
	port, token, err := wrapperControl(sessionRow)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, thumbnailPersistTimeout)
	defer cancel()

	response, err := wrapperGet(ctx, port, token, "/thumbnail/targets", thumbnailRequestTimeout)
	if err != nil {
		return err
	}
	var targets browser.WrapperThumbnailTargets
	decodeErr := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&targets)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("wrapper thumbnail targets returned %s", response.Status)
	}
	if decodeErr != nil {
		return fmt.Errorf("decode thumbnail targets: %w", decodeErr)
	}

	if err := os.MkdirAll(filepath.Dir(dir), 0o750); err != nil {
		return err
	}
	staging, err := os.MkdirTemp(filepath.Dir(dir), "thumbnails-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(staging) }()
	if err := os.Mkdir(filepath.Join(staging, "targets"), 0o750); err != nil {
		return err
	}
	for _, targetID := range targets.TargetIDs {
		if !thumbnailTargetIDPattern.MatchString(targetID) {
			continue
		}
		thumbnail, err := s.liveThumbnail(ctx, sessionRow, targetID)
		if errors.Is(err, ErrThumbnailNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		names := []string{filepath.Join("targets", targetID+".jpg")}
		if targetID == targets.SessionTargetID {
			names = append(names, sessionThumbnailFile)
		}
		for _, name := range names {
			path := filepath.Join(staging, name)
			if err := os.WriteFile(path, thumbnail.Image, 0o640); err != nil {
				return err
			}
			// The modification time records when the thumbnail was captured.
			if err := os.Chtimes(path, thumbnail.CapturedAt, thumbnail.CapturedAt); err != nil {
				return err
			}
		}
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	return os.Rename(staging, dir)
}

func wrapperGet(ctx context.Context, port int, token, path string, timeout time.Duration) (*http.Response, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), nil)
	if err != nil {
		cancel()
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		cancel()
		return nil, err
	}
	response.Body = cancelOnClose{ReadCloser: response.Body, cancel: cancel}
	return response, nil
}

type cancelOnClose struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (body cancelOnClose) Close() error {
	defer body.cancel()
	return body.ReadCloser.Close()
}
