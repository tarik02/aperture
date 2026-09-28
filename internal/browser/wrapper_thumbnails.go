package browser

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/chromedp/cdproto/page"
)

const (
	// ThumbnailWidth bounds the width of captured thumbnails in pixels.
	ThumbnailWidth = 640
	// Repeated hovers share one capture instead of screenshotting the page each time.
	thumbnailCacheTTL = 2 * time.Second
	thumbnailQuality  = 70

	// ThumbnailTargetHeader names the target a session thumbnail shows.
	ThumbnailTargetHeader = "X-Aperture-Thumbnail-Target"
	// ThumbnailCapturedAtHeader carries the capture time as RFC 3339.
	ThumbnailCapturedAtHeader = "X-Aperture-Thumbnail-Captured-At"
)

var errThumbnailTargetNotFound = errors.New("thumbnail target not found")

type wrapperThumbnail struct {
	image      []byte
	capturedAt time.Time
}

type wrapperThumbnailCache struct {
	mu      sync.Mutex
	entries map[string]wrapperThumbnail
}

// WrapperThumbnailTargets lists the targets that have thumbnails and the one that represents the session.
type WrapperThumbnailTargets struct {
	SessionTargetID string   `json:"sessionTargetId"`
	TargetIDs       []string `json:"targetIds"`
}

// thumbnailTargets returns the selectable targets and the one most recently shown to a client.
func (session *liveSession) thumbnailTargets() (WrapperThumbnailTargets, error) {
	targets, err := session.browser.targets()
	if err != nil {
		return WrapperThumbnailTargets{}, err
	}
	ids := make([]string, 0, len(targets))
	session.runtime.mu.Lock()
	hasTargetRegistry := session.runtime.targets != nil
	session.runtime.mu.Unlock()
	for _, target := range targets {
		if target.Viewport != nil || !hasTargetRegistry {
			ids = append(ids, target.ID)
		}
	}
	session.mu.Lock()
	sessionTargetID := session.lastActiveTargetID
	session.mu.Unlock()
	if !slices.Contains(ids, sessionTargetID) {
		sessionTargetID = session.browser.firstSelectableTargetID(targets)
	}
	return WrapperThumbnailTargets{SessionTargetID: sessionTargetID, TargetIDs: ids}, nil
}

func (session *liveSession) thumbnail(targetID string) (wrapperThumbnail, error) {
	cache := &session.thumbnails
	cache.mu.Lock()
	cached, ok := cache.entries[targetID]
	cache.mu.Unlock()
	if ok && time.Since(cached.capturedAt) < thumbnailCacheTTL {
		return cached, nil
	}

	var image []byte
	err := session.browser.withTarget(targetID, func(ctx context.Context) error {
		_, _, _, _, viewport, _, err := page.GetLayoutMetrics().Do(ctx)
		if err != nil {
			return err
		}
		if viewport == nil || viewport.ClientWidth <= 0 || viewport.ClientHeight <= 0 {
			return errors.New("target has no visible viewport")
		}
		scale := min(1, float64(ThumbnailWidth)/viewport.ClientWidth)
		image, err = page.CaptureScreenshot().
			WithFormat(page.CaptureScreenshotFormatJpeg).
			WithQuality(thumbnailQuality).
			WithOptimizeForSpeed(true).
			WithClip(&page.Viewport{
				X:      viewport.PageX,
				Y:      viewport.PageY,
				Width:  viewport.ClientWidth,
				Height: viewport.ClientHeight,
				Scale:  scale,
			}).
			Do(ctx)
		return err
	})
	if err != nil {
		return wrapperThumbnail{}, err
	}

	captured := wrapperThumbnail{image: image, capturedAt: time.Now().UTC()}
	cache.mu.Lock()
	if cache.entries == nil {
		cache.entries = make(map[string]wrapperThumbnail)
	}
	cache.entries[targetID] = captured
	cache.mu.Unlock()
	return captured, nil
}

// handleThumbnail serves a JPEG of one target, or of the session's target when none is given.
// Only the daemon calls it; it never counts as session activity.
func (r *wrapperRuntime) handleThumbnail(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !r.wrapperControlAuthorized(req) {
		writeWrapperError(w, http.StatusUnauthorized, "wrapper control token required")
		return
	}
	targets, err := r.liveSession.thumbnailTargets()
	if err != nil {
		writeWrapperError(w, http.StatusBadGateway, err.Error())
		return
	}
	targetID := req.URL.Query().Get("targetId")
	if targetID == "" {
		targetID = targets.SessionTargetID
	}
	if targetID == "" || !slices.Contains(targets.TargetIDs, targetID) {
		writeWrapperError(w, http.StatusNotFound, errThumbnailTargetNotFound.Error())
		return
	}
	thumbnail, err := r.liveSession.thumbnail(targetID)
	if err != nil {
		writeWrapperError(w, http.StatusBadGateway, fmt.Sprintf("capture thumbnail: %v", err))
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set(ThumbnailTargetHeader, targetID)
	w.Header().Set(ThumbnailCapturedAtHeader, thumbnail.capturedAt.Format(time.RFC3339Nano))
	_, _ = w.Write(thumbnail.image)
}

func (r *wrapperRuntime) handleThumbnailTargets(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !r.wrapperControlAuthorized(req) {
		writeWrapperError(w, http.StatusUnauthorized, "wrapper control token required")
		return
	}
	targets, err := r.liveSession.thumbnailTargets()
	if err != nil {
		writeWrapperError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeWrapperJSON(w, http.StatusOK, targets)
}
