package session

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"

	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/db"
)

// ErrFaviconNotFound means the target has no favicon to show.
var ErrFaviconNotFound = errors.New("favicon not found")

// ErrFaviconRead means the running browser could not report a favicon.
var ErrFaviconRead = errors.New("favicon read failed")

const faviconDir = "favicons"

// Favicon is one browser target's icon as the page loaded it.
type Favicon struct {
	Image       []byte
	ContentType string
	// Version is a short content hash, also listed as the page's faviconVersion.
	Version string
}

// Favicon returns a tenant-owned session target's favicon. Like thumbnails, it never wakes the
// session: a suspended session serves the favicons saved when it suspended.
func (s *Service) Favicon(ctx context.Context, tenantID, sessionID, targetID string) (Favicon, error) {
	sessionRow, err := s.requireTenantSession(ctx, tenantID, sessionID)
	if err != nil {
		return Favicon{}, err
	}
	return s.sessionFavicon(ctx, sessionRow, targetID)
}

// AuthorizedFavicon is Favicon for a session token or an editor or viewer capability.
func (s *Service) AuthorizedFavicon(ctx context.Context, routeSessionID, authorization, targetID string) (Favicon, error) {
	sessionRow, err := s.authorizedPassiveSession(ctx, routeSessionID, authorization)
	if err != nil {
		return Favicon{}, err
	}
	return s.sessionFavicon(ctx, sessionRow, targetID)
}

// SignedFavicon serves a favicon for a signed URL, whose token has already named the session.
func (s *Service) SignedFavicon(ctx context.Context, sessionID, targetID string) (Favicon, error) {
	sessionRow, err := s.repo.GetSessionByID(ctx, sessionID)
	if err != nil {
		return Favicon{}, err
	}
	if sessionRow == nil {
		return Favicon{}, ErrNotFound
	}
	if isExpired(sessionRow.ExpiresAt, s.now().UTC()) {
		return Favicon{}, ErrExpired
	}
	return s.sessionFavicon(ctx, sessionRow, targetID)
}

func (s *Service) sessionFavicon(ctx context.Context, sessionRow *db.Session, targetID string) (Favicon, error) {
	if !thumbnailTargetIDPattern.MatchString(targetID) {
		return Favicon{}, ErrFaviconNotFound
	}
	switch sessionRow.Status {
	case db.SessionStatusRunning:
		return s.liveFavicon(ctx, sessionRow, targetID)
	case db.SessionStatusSuspended:
		return s.storedFavicon(sessionRow, targetID)
	default:
		return Favicon{}, ErrFaviconNotFound
	}
}

func (s *Service) liveFavicon(ctx context.Context, sessionRow *db.Session, targetID string) (Favicon, error) {
	port, token, err := wrapperControl(sessionRow)
	if err != nil {
		return Favicon{}, err
	}
	query := url.Values{"targetId": {targetID}}
	response, err := wrapperGet(ctx, port, token, "/favicon?"+query.Encode(), thumbnailRequestTimeout)
	if err != nil {
		return Favicon{}, fmt.Errorf("%w: %w", ErrFaviconRead, err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusNotFound {
		return Favicon{}, ErrFaviconNotFound
	}
	if response.StatusCode != http.StatusOK {
		return Favicon{}, fmt.Errorf("%w: wrapper returned %s", ErrFaviconRead, response.Status)
	}
	image, err := io.ReadAll(io.LimitReader(response.Body, browser.FaviconMaxBytes+1))
	if err != nil {
		return Favicon{}, err
	}
	return faviconFromBytes(image)
}

func (s *Service) storedFavicon(sessionRow *db.Session, targetID string) (Favicon, error) {
	manifest, available, err := s.storedPageManifest(sessionRow.ID)
	if err != nil {
		return Favicon{}, err
	}
	if !available || !pageManifestMatchesSession(sessionRow, manifest) {
		return Favicon{}, ErrFaviconNotFound
	}
	dir, err := s.thumbnailDir(sessionRow.ID)
	if err != nil {
		return Favicon{}, err
	}
	image, err := os.ReadFile(filepath.Join(dir, faviconDir, targetID))
	if errors.Is(err, os.ErrNotExist) {
		return Favicon{}, ErrFaviconNotFound
	}
	if err != nil {
		return Favicon{}, err
	}
	return faviconFromBytes(image)
}

// faviconFromBytes re-checks every icon before serving it, so only accepted image types leave
// the daemon whatever the wrapper or cold storage holds.
func faviconFromBytes(image []byte) (Favicon, error) {
	if len(image) > browser.FaviconMaxBytes {
		return Favicon{}, fmt.Errorf("%w: favicon is too large", ErrFaviconRead)
	}
	contentType, ok := browser.FaviconContentType(image)
	if !ok {
		return Favicon{}, ErrFaviconNotFound
	}
	return Favicon{Image: image, ContentType: contentType, Version: browser.FaviconVersion(image)}, nil
}

// persistFavicons saves the favicons of a suspending session's pages into a thumbnail staging
// directory. A page lists a favicon only when it was saved.
func (s *Service) persistFavicons(ctx context.Context, sessionRow *db.Session, staging string, manifest *browser.PageManifest) error {
	if err := os.Mkdir(filepath.Join(staging, faviconDir), 0o750); err != nil {
		return err
	}
	for index := range manifest.Pages {
		page := &manifest.Pages[index]
		available := page.FaviconAvailable
		page.FaviconAvailable = false
		page.FaviconVersion = ""
		if !available || !thumbnailTargetIDPattern.MatchString(page.TargetID) {
			continue
		}
		favicon, err := s.liveFavicon(ctx, sessionRow, page.TargetID)
		if err != nil {
			fmt.Fprintf(os.Stderr, "aperture: read favicon for session %s target %s: %v\n", sessionRow.ID, page.TargetID, err)
			continue
		}
		if err := os.WriteFile(filepath.Join(staging, faviconDir, page.TargetID), favicon.Image, 0o640); err != nil {
			return err
		}
		page.FaviconAvailable = true
		page.FaviconVersion = favicon.Version
	}
	return nil
}
