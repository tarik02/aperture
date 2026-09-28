package browser

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
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
	thumbnailCacheTTL     = 2 * time.Second
	thumbnailQuality      = 70
	thumbnailCaptureLimit = 4 * 1024 * 1024

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

	session.runtime.mu.Lock()
	registry := session.runtime.targets
	session.runtime.mu.Unlock()
	if registry == nil {
		return wrapperThumbnail{}, errors.New("target registry is unavailable")
	}
	target, ready := registry.readyTarget(targetID)
	if !ready {
		return wrapperThumbnail{}, errThumbnailTargetNotFound
	}
	image, err := session.captureThumbnail(target)
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

func (session *liveSession) captureThumbnail(target wrapperTargetSnapshot) ([]byte, error) {
	viewport := target.Viewport
	if target.PipeWireTarget == "" || target.CaptureID == "" || viewport.ContentWidth <= 0 || viewport.ContentHeight <= 0 {
		return nil, errors.New("target has no capturable compositor output")
	}
	cropRight := viewport.CanvasWidth - viewport.ContentWidth
	cropBottom := viewport.CanvasHeight - viewport.ContentHeight
	if cropRight < 0 || cropBottom < 0 {
		return nil, errors.New("target compositor viewport is invalid")
	}
	width := min(ThumbnailWidth, viewport.ContentWidth)
	height := max(1, (viewport.ContentHeight*width+viewport.ContentWidth/2)/viewport.ContentWidth)

	ctx, cancel := context.WithTimeout(session.runtime.ctx, liveSessionBrowserCommandTimeout)
	defer cancel()
	args := []string{
		"-q",
		"-e",
		"pipewiresrc",
		"target-object=" + target.PipeWireTarget,
		"do-timestamp=true",
		"provide-clock=false",
		"use-bufferpool=false",
		"min-buffers=4",
		"max-buffers=8",
		"keepalive-time=100",
		"num-buffers=1",
		"!",
		fmt.Sprintf("video/x-raw,width=%d,height=%d,pixel-aspect-ratio=1/1", viewport.CanvasWidth, viewport.CanvasHeight),
		"!",
		"queue",
		"max-size-buffers=1",
		"leaky=downstream",
		"!",
		"videocrop",
		"right=" + strconv.Itoa(cropRight),
		"bottom=" + strconv.Itoa(cropBottom),
		"!",
		"videoconvert",
		"!",
		"videoscale",
		"!",
		fmt.Sprintf("video/x-raw,width=%d,height=%d,pixel-aspect-ratio=1/1", width, height),
		"!",
		"jpegenc",
		"quality=" + strconv.Itoa(thumbnailQuality),
		"!",
		"fdsink",
		"fd=1",
		"sync=false",
	}
	cmd := exec.CommandContext(ctx, session.runtime.values.MediaProducerGSTExecutable, args...)
	cmd.Env = wrapperMediaProcessEnv(session.runtime.values.MediaProducerPluginPath)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("open thumbnail capture output: %w", err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start thumbnail capture: %w", err)
	}
	image, readErr := io.ReadAll(io.LimitReader(stdout, thumbnailCaptureLimit+1))
	if len(image) > thumbnailCaptureLimit {
		_ = cmd.Process.Kill()
	}
	waitErr := cmd.Wait()
	if readErr != nil {
		return nil, fmt.Errorf("read thumbnail capture: %w", readErr)
	}
	if len(image) > thumbnailCaptureLimit {
		return nil, errors.New("thumbnail capture exceeded the response limit")
	}
	if waitErr != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail != "" {
			return nil, fmt.Errorf("capture compositor output: %w: %s", waitErr, detail)
		}
		return nil, fmt.Errorf("capture compositor output: %w", waitErr)
	}
	if len(image) < 2 || image[0] != 0xff || image[1] != 0xd8 {
		return nil, errors.New("compositor did not produce a JPEG thumbnail")
	}
	return image, nil
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
