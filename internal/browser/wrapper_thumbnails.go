package browser

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"net/http"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// ThumbnailWidth bounds the width of captured thumbnails in pixels.
	ThumbnailWidth = 640
	// Repeated hovers share one capture instead of screenshotting the page each time.
	thumbnailCacheTTL    = 2 * time.Second
	thumbnailQuality     = 70
	thumbnailMaxAttempts = 2

	// ThumbnailTargetHeader names the target a session thumbnail shows.
	ThumbnailTargetHeader = "X-Aperture-Thumbnail-Target"
	// ThumbnailCapturedAtHeader carries the capture time as RFC 3339.
	ThumbnailCapturedAtHeader = "X-Aperture-Thumbnail-Captured-At"
)

var errThumbnailTargetNotFound = errors.New("thumbnail target not found")

type wrapperThumbnail struct {
	image      []byte
	capturedAt time.Time
	generation uint64
	viewport   compositorViewport
}

type wrapperThumbnailCache struct {
	captureMu sync.Mutex
	mu        sync.Mutex
	entries   map[string]wrapperThumbnail
}

// PageViewport is the viewport metadata available for a browser page.
type PageViewport struct {
	Width             int     `json:"width"`
	Height            int     `json:"height"`
	ContentWidth      int     `json:"contentWidth"`
	ContentHeight     int     `json:"contentHeight"`
	CanvasWidth       int     `json:"canvasWidth"`
	CanvasHeight      int     `json:"canvasHeight"`
	DeviceScaleFactor float64 `json:"deviceScaleFactor"`
}

// PageManifestEntry describes one page in a live or persisted browser generation.
type PageManifestEntry struct {
	TargetID           string        `json:"targetId"`
	Title              string        `json:"title"`
	URL                string        `json:"url"`
	State              string        `json:"state"`
	Viewport           *PageViewport `json:"viewport,omitempty"`
	ThumbnailAvailable bool          `json:"thumbnailAvailable"`
}

// PageManifest is a point-in-time page listing. Persisted target IDs are historical references
// and are not expected to survive a browser restart.
type PageManifest struct {
	CapturedAt             time.Time           `json:"capturedAt"`
	SessionStartedAt       string              `json:"sessionStartedAt,omitempty"`
	RepresentativeTargetID string              `json:"representativeTargetId,omitempty"`
	Pages                  []PageManifestEntry `json:"pages"`
}

// WrapperThumbnailTargets lists the targets that have thumbnails and the one that represents the session.
type WrapperThumbnailTargets struct {
	SessionTargetID string   `json:"sessionTargetId"`
	TargetIDs       []string `json:"targetIds"`
}

func pageViewport(viewport compositorViewport) *PageViewport {
	if viewport.Width <= 0 || viewport.Height <= 0 || viewport.ContentWidth <= 0 ||
		viewport.ContentHeight <= 0 || viewport.CanvasWidth <= 0 || viewport.CanvasHeight <= 0 ||
		viewport.DeviceScaleFactor <= 0 {
		return nil
	}
	return &PageViewport{
		Width:             viewport.Width,
		Height:            viewport.Height,
		ContentWidth:      viewport.ContentWidth,
		ContentHeight:     viewport.ContentHeight,
		CanvasWidth:       viewport.CanvasWidth,
		CanvasHeight:      viewport.CanvasHeight,
		DeviceScaleFactor: viewport.DeviceScaleFactor,
	}
}

// pageManifest reads current page metadata without selecting a page or acquiring presentation,
// input, or viewport ownership.
func (session *liveSession) pageManifest() (PageManifest, error) {
	targets, err := session.browser.targets()
	if err != nil {
		return PageManifest{}, err
	}
	session.runtime.mu.Lock()
	registry := session.runtime.targets
	session.runtime.mu.Unlock()
	snapshots := make(map[string]wrapperTargetSnapshot)
	if registry != nil {
		for _, snapshot := range registry.snapshots() {
			snapshots[snapshot.TargetID] = snapshot
		}
	}

	pages := make([]PageManifestEntry, 0, len(targets))
	for _, target := range targets {
		state := string(wrapperTargetPending)
		viewport := pageViewport(compositorViewport{})
		if snapshot, ok := snapshots[target.ID]; ok {
			state = string(snapshot.State)
			viewport = pageViewport(snapshot.Viewport)
		} else if target.Viewport != nil {
			viewport = pageViewport(*target.Viewport)
		}
		pages = append(pages, PageManifestEntry{
			TargetID: target.ID,
			Title:    target.Title,
			URL:      target.URL,
			State:    state,
			Viewport: viewport,
		})
	}

	session.mu.Lock()
	representativeTargetID := session.lastActiveTargetID
	session.mu.Unlock()
	if !slices.ContainsFunc(pages, func(page PageManifestEntry) bool {
		return page.TargetID == representativeTargetID && page.State == string(wrapperTargetReady)
	}) {
		representativeTargetID = session.browser.firstSelectableTargetID(targets)
	}

	return PageManifest{
		CapturedAt:             time.Now().UTC(),
		RepresentativeTargetID: representativeTargetID,
		Pages:                  pages,
	}, nil
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
	cache.captureMu.Lock()
	defer cache.captureMu.Unlock()

	session.runtime.mu.Lock()
	registry := session.runtime.targets
	session.runtime.mu.Unlock()
	if registry == nil {
		return wrapperThumbnail{}, errors.New("target registry is unavailable")
	}

	for range thumbnailMaxAttempts {
		target, ready := registry.readyTarget(targetID)
		if !ready {
			return wrapperThumbnail{}, errThumbnailTargetNotFound
		}
		cache.mu.Lock()
		cached, ok := cache.entries[targetID]
		cache.mu.Unlock()
		if ok && cached.generation == target.Generation && cached.viewport == target.Viewport &&
			time.Since(cached.capturedAt) < thumbnailCacheTTL {
			return cached, nil
		}

		image, err := session.captureThumbnail(target)
		if err != nil {
			return wrapperThumbnail{}, err
		}
		current, ready := registry.readyTarget(targetID)
		if !ready {
			return wrapperThumbnail{}, errThumbnailTargetNotFound
		}
		if current.Generation != target.Generation || current.Viewport != target.Viewport {
			continue
		}

		captured := wrapperThumbnail{
			image:      image,
			capturedAt: time.Now().UTC(),
			generation: target.Generation,
			viewport:   target.Viewport,
		}
		cache.mu.Lock()
		if cache.entries == nil {
			cache.entries = make(map[string]wrapperThumbnail)
		}
		cache.entries[targetID] = captured
		for id := range cache.entries {
			if _, ready := registry.readyTarget(id); !ready {
				delete(cache.entries, id)
			}
		}
		cache.mu.Unlock()
		return captured, nil
	}
	return wrapperThumbnail{}, errors.New("target changed during thumbnail capture")
}

func (session *liveSession) captureThumbnail(target wrapperTargetSnapshot) ([]byte, error) {
	viewport := target.Viewport
	if target.PipeWireTarget == "" || viewport.ContentWidth <= 0 || viewport.ContentHeight <= 0 ||
		viewport.ContentWidth > viewport.CanvasWidth || viewport.ContentHeight > viewport.CanvasHeight {
		return nil, errors.New("target has no capturable compositor output")
	}
	width := min(ThumbnailWidth, viewport.ContentWidth)
	height := max(1, (viewport.ContentHeight*width+viewport.ContentWidth/2)/viewport.ContentWidth)

	ctx, cancel := context.WithTimeout(session.runtime.ctx, liveSessionBrowserCommandTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, session.runtime.values.MediaProducerGSTExecutable,
		"-q",
		"pipewiresrc", "target-object="+target.PipeWireTarget, "num-buffers=1",
		"!", "videocrop",
		"right="+strconv.Itoa(viewport.CanvasWidth-viewport.ContentWidth),
		"bottom="+strconv.Itoa(viewport.CanvasHeight-viewport.ContentHeight),
		"!", "videoscale",
		"!", "videoconvert",
		"!", fmt.Sprintf("video/x-raw,format=RGBx,width=%d,height=%d,pixel-aspect-ratio=1/1", width, height),
		"!", "fdsink", "fd=1", "sync=false",
	)
	cmd.Env = wrapperMediaProcessEnv(session.runtime.values.MediaProducerPluginPath)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	// An output nobody watches has no damage, so it only sends a frame once repainted.
	go func() {
		for _, delay := range []time.Duration{50 * time.Millisecond, 100 * time.Millisecond, 250 * time.Millisecond} {
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
			_, _ = sendCompositorControlCommand(ctx, session.runtime.controlSocket, "output-repaint "+target.CaptureID+"\n")
		}
	}()
	pixels, err := cmd.Output()
	if err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail != "" {
			return nil, fmt.Errorf("capture PipeWire output: %w: %s", err, detail)
		}
		return nil, fmt.Errorf("capture PipeWire output: %w", err)
	}
	if len(pixels) != width*height*4 {
		return nil, fmt.Errorf("capture PipeWire output: got %d bytes for a %dx%d frame", len(pixels), width, height)
	}
	frame := &image.RGBA{Pix: pixels, Stride: width * 4, Rect: image.Rect(0, 0, width, height)}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, frame, &jpeg.Options{Quality: thumbnailQuality}); err != nil {
		return nil, fmt.Errorf("encode thumbnail: %w", err)
	}
	return encoded.Bytes(), nil
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

func (r *wrapperRuntime) handlePageManifest(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !r.wrapperControlAuthorized(req) {
		writeWrapperError(w, http.StatusUnauthorized, "wrapper control token required")
		return
	}
	manifest, err := r.liveSession.pageManifest()
	if err != nil {
		writeWrapperError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeWrapperJSON(w, http.StatusOK, manifest)
}
