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
	pageManifestFile        = "pages.json"
)

var thumbnailTargetIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// Thumbnail is a JPEG of one browser target.
type Thumbnail struct {
	Image      []byte
	CapturedAt time.Time
}

// BrowserOverview is a passive view of a retained browser session. Persisted target IDs describe
// the saved generation only and are not expected to survive resume.
type BrowserOverview struct {
	SessionID              string
	Status                 string
	Source                 string
	CapturedAt             *time.Time
	RepresentativeTargetID string
	Pages                  []browser.PageManifestEntry
	ThumbnailAvailable     bool
	Media                  SessionMediaView
	CDPURL                 string
}

// BrowserOverview returns a tenant-owned session's page metadata without waking or touching it.
func (s *Service) BrowserOverview(ctx context.Context, tenantID, sessionID string) (BrowserOverview, error) {
	sessionRow, err := s.requireTenantSession(ctx, tenantID, sessionID)
	if err != nil {
		return BrowserOverview{}, err
	}
	return s.sessionBrowserOverview(ctx, sessionRow)
}

// AuthorizedBrowserOverview is BrowserOverview for a session token or collaboration capability.
func (s *Service) AuthorizedBrowserOverview(ctx context.Context, routeSessionID, authorization string) (BrowserOverview, error) {
	sessionRow, err := s.authorizedPassiveSession(ctx, routeSessionID, authorization)
	if err != nil {
		return BrowserOverview{}, err
	}
	return s.sessionBrowserOverview(ctx, sessionRow)
}

func (s *Service) sessionBrowserOverview(ctx context.Context, sessionRow *db.Session) (BrowserOverview, error) {
	overview := BrowserOverview{
		SessionID: sessionRow.ID,
		Status:    sessionRow.Status,
		Source:    "unavailable",
		Pages:     []browser.PageManifestEntry{},
		Media:     s.sessionMediaView(*sessionRow),
		CDPURL:    s.cdpURL(sessionRow.ID),
	}
	switch sessionRow.Status {
	case db.SessionStatusRunning:
		manifest, err := s.livePageManifest(ctx, sessionRow)
		if err != nil {
			latest, readErr := s.repo.GetSessionByID(ctx, sessionRow.ID)
			if readErr != nil {
				return BrowserOverview{}, readErr
			}
			if latest != nil && latest.Status == db.SessionStatusSuspended {
				return s.sessionBrowserOverview(ctx, latest)
			}
			return BrowserOverview{}, fmt.Errorf("%w: %v", ErrBrowserOverview, err)
		}
		for index := range manifest.Pages {
			manifest.Pages[index].ThumbnailAvailable = manifest.Pages[index].State == "ready"
		}
		overview.Source = "live"
		overview.CapturedAt = &manifest.CapturedAt
		overview.RepresentativeTargetID = manifest.RepresentativeTargetID
		overview.Pages = manifest.Pages
		overview.ThumbnailAvailable = representativeThumbnailAvailable(manifest)
		return overview, nil
	case db.SessionStatusSuspended:
		manifest, available, err := s.storedPageManifest(sessionRow.ID)
		if err != nil {
			return BrowserOverview{}, err
		}
		if !available || !pageManifestMatchesSession(sessionRow, manifest) {
			overview.ThumbnailAvailable = s.ThumbnailAvailable(*sessionRow)
			return overview, nil
		}
		overview.Source = "persisted"
		overview.CapturedAt = &manifest.CapturedAt
		overview.RepresentativeTargetID = manifest.RepresentativeTargetID
		overview.Pages = manifest.Pages
		overview.ThumbnailAvailable = representativeThumbnailAvailable(manifest)
		return overview, nil
	default:
		return BrowserOverview{}, ErrNotRunning
	}
}

func representativeThumbnailAvailable(manifest browser.PageManifest) bool {
	for _, page := range manifest.Pages {
		if page.TargetID == manifest.RepresentativeTargetID {
			return page.ThumbnailAvailable
		}
	}
	return false
}

func pageManifestMatchesSession(sessionRow *db.Session, manifest browser.PageManifest) bool {
	return sessionRow.StartedAt != nil && manifest.SessionStartedAt == *sessionRow.StartedAt
}

func (s *Service) livePageManifest(ctx context.Context, sessionRow *db.Session) (browser.PageManifest, error) {
	port, token, err := wrapperControl(sessionRow)
	if err != nil {
		return browser.PageManifest{}, err
	}
	response, err := wrapperGet(ctx, port, token, "/thumbnail/manifest", thumbnailRequestTimeout)
	if err != nil {
		return browser.PageManifest{}, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return browser.PageManifest{}, fmt.Errorf("wrapper page manifest returned %s", response.Status)
	}
	var manifest browser.PageManifest
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&manifest); err != nil {
		return browser.PageManifest{}, fmt.Errorf("decode wrapper page manifest: %w", err)
	}
	return manifest, nil
}

func (s *Service) storedPageManifest(sessionID string) (browser.PageManifest, bool, error) {
	dir, err := s.thumbnailDir(sessionID)
	if err != nil {
		return browser.PageManifest{}, false, err
	}
	body, err := os.ReadFile(filepath.Join(dir, pageManifestFile))
	if errors.Is(err, os.ErrNotExist) {
		return browser.PageManifest{}, false, nil
	}
	if err != nil {
		return browser.PageManifest{}, false, err
	}
	var manifest browser.PageManifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		return browser.PageManifest{}, false, fmt.Errorf("decode saved page manifest: %w", err)
	}
	return manifest, true, nil
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
	sessionRow, err := s.authorizedPassiveSession(ctx, routeSessionID, authorization)
	if err != nil {
		return Thumbnail{}, err
	}
	return s.sessionThumbnail(ctx, sessionRow, targetID)
}

func (s *Service) authorizedPassiveSession(ctx context.Context, routeSessionID, authorization string) (*db.Session, error) {
	raw, err := bearerToken(authorization)
	if err != nil {
		return nil, err
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
		return nil, err
	}
	return sessionRow, nil
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
		manifest, available, err := s.storedPageManifest(sessionRow.ID)
		if err != nil || (available && !pageManifestMatchesSession(&sessionRow, manifest)) {
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
		return s.storedThumbnail(sessionRow, targetID)
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

func (s *Service) storedThumbnail(sessionRow *db.Session, targetID string) (Thumbnail, error) {
	manifest, available, err := s.storedPageManifest(sessionRow.ID)
	if err != nil {
		return Thumbnail{}, err
	}
	if available && !pageManifestMatchesSession(sessionRow, manifest) {
		return Thumbnail{}, ErrThumbnailNotFound
	}
	dir, err := s.thumbnailDir(sessionRow.ID)
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

// persistThumbnails saves one page-metadata and thumbnail generation before the browser stops. It
// replaces the previous generation, or removes it when persistence is disabled.
func (s *Service) persistThumbnails(ctx context.Context, sessionRow *db.Session) (retErr error) {
	dir, err := s.thumbnailDir(sessionRow.ID)
	if err != nil {
		return err
	}
	if !s.cfg.ThumbnailsPersistOnSuspend {
		return os.RemoveAll(dir)
	}
	// Once a capture attempt starts, an older generation must not survive a failed attempt and look
	// like the metadata captured for this suspension.
	defer func() {
		if retErr != nil {
			retErr = errors.Join(retErr, os.RemoveAll(dir))
		}
	}()
	port, token, err := wrapperControl(sessionRow)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, thumbnailPersistTimeout)
	defer cancel()

	response, err := wrapperGet(ctx, port, token, "/thumbnail/manifest", thumbnailRequestTimeout)
	if err != nil {
		return err
	}
	var manifest browser.PageManifest
	decodeErr := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&manifest)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("wrapper page manifest returned %s", response.Status)
	}
	if decodeErr != nil {
		return fmt.Errorf("decode wrapper page manifest: %w", decodeErr)
	}
	if sessionRow.StartedAt == nil {
		return errors.New("running session has no start generation")
	}
	manifest.SessionStartedAt = *sessionRow.StartedAt

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
	for index := range manifest.Pages {
		page := &manifest.Pages[index]
		if page.State != "ready" || !thumbnailTargetIDPattern.MatchString(page.TargetID) {
			continue
		}
		thumbnail, err := s.liveThumbnail(ctx, sessionRow, page.TargetID)
		if err != nil {
			fmt.Fprintf(os.Stderr, "aperture: capture thumbnail for session %s target %s: %v\n", sessionRow.ID, page.TargetID, err)
			continue
		}
		page.ThumbnailAvailable = true
		names := []string{filepath.Join("targets", page.TargetID+".jpg")}
		if page.TargetID == manifest.RepresentativeTargetID {
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
	manifestBody, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	manifestPath := filepath.Join(staging, pageManifestFile)
	if err := os.WriteFile(manifestPath, manifestBody, 0o640); err != nil {
		return err
	}
	if err := os.Chtimes(manifestPath, manifest.CapturedAt, manifest.CapturedAt); err != nil {
		return err
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
