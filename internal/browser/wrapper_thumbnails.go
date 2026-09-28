package browser

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

const (
	// ThumbnailWidth bounds the width of captured thumbnails in pixels.
	ThumbnailWidth = 640
	// Repeated hovers share one capture instead of screenshotting the page each time.
	thumbnailCacheTTL     = 2 * time.Second
	thumbnailQuality      = 70
	thumbnailCaptureLimit = 4 * 1024 * 1024
	thumbnailStderrLimit  = 32 * 1024
	thumbnailMaxAttempts  = 2

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

type thumbnailErrorOutput struct {
	data []byte
}

func (output *thumbnailErrorOutput) Write(p []byte) (int, error) {
	written := len(p)
	remaining := thumbnailStderrLimit - len(output.data)
	if remaining > 0 {
		output.data = append(output.data, p[:min(len(p), remaining)]...)
	}
	return written, nil
}

func (output *thumbnailErrorOutput) String() string {
	return string(output.data)
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
	if target.CaptureID == "" || viewport.ContentWidth <= 0 || viewport.ContentHeight <= 0 ||
		viewport.ContentWidth > viewport.CanvasWidth || viewport.ContentHeight > viewport.CanvasHeight {
		return nil, errors.New("target has no capturable compositor output")
	}
	helperPath, err := apertureWestonCapturePath()
	if err != nil {
		return nil, err
	}

	sockets, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("create thumbnail Wayland socket: %w", err)
	}
	compositorSocket := os.NewFile(uintptr(sockets[0]), "thumbnail-compositor-wayland")
	helperSocket := os.NewFile(uintptr(sockets[1]), "thumbnail-helper-wayland")
	defer func() { _ = compositorSocket.Close() }()
	defer func() { _ = helperSocket.Close() }()

	ctx, cancel := context.WithTimeout(session.runtime.ctx, liveSessionBrowserCommandTimeout)
	defer cancel()
	if _, err := sendCompositorControlCommandWithFD(
		ctx,
		session.runtime.controlSocket,
		"capture-client "+target.CaptureID+"\n",
		int(compositorSocket.Fd()),
	); err != nil {
		return nil, fmt.Errorf("authorize thumbnail capture: %w", err)
	}
	if err := compositorSocket.Close(); err != nil {
		return nil, fmt.Errorf("close thumbnail compositor socket: %w", err)
	}

	cmd := exec.CommandContext(
		ctx,
		helperPath,
		target.CaptureID,
		strconv.Itoa(viewport.CanvasWidth),
		strconv.Itoa(viewport.CanvasHeight),
		strconv.Itoa(viewport.ContentWidth),
		strconv.Itoa(viewport.ContentHeight),
		strconv.Itoa(ThumbnailWidth),
		strconv.Itoa(thumbnailQuality),
	)
	cmd.Env = []string{"WAYLAND_SOCKET=3"}
	cmd.ExtraFiles = []*os.File{helperSocket}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("open thumbnail capture output: %w", err)
	}
	var stderr thumbnailErrorOutput
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start thumbnail capture: %w", err)
	}
	if err := helperSocket.Close(); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, fmt.Errorf("close thumbnail helper socket: %w", err)
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
