package browser

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const cdpDiscoveryMessageLimit = 4 * 1024 * 1024

type wrapperTargetState string

const (
	wrapperTargetPending     wrapperTargetState = "pending"
	wrapperTargetReady       wrapperTargetState = "ready"
	wrapperTargetUnavailable wrapperTargetState = "unavailable"
	wrapperTargetClosed      wrapperTargetState = "closed"
)

type wrapperTargetSnapshot struct {
	TargetID       string             `json:"targetId"`
	WindowID       int64              `json:"windowId"`
	SurfaceID      uint64             `json:"surfaceId"`
	CaptureID      string             `json:"captureId"`
	Generation     uint64             `json:"generation"`
	PipeWireTarget string             `json:"pipewireTarget"`
	State          wrapperTargetState `json:"state"`
	Title          string             `json:"title"`
	URL            string             `json:"url"`
	Viewport       compositorViewport `json:"viewport"`
}

type wrapperWindowBinding struct {
	WindowID  int64
	TabID     int64
	SurfaceID uint64
	Settled   bool
}

type wrapperTargetRegistry struct {
	runtime         *wrapperRuntime
	controlSocket   string
	extensionSocket string
	cdpPort         int
	compositorPID   int
	viewport        compositorViewport

	mu             sync.Mutex
	reconcile      sync.Mutex
	resizeMu       sync.Mutex
	windows        map[int64]wrapperWindowBinding
	targets        map[string]wrapperTargetSnapshot
	retiredOutputs map[string]struct{}
	resizes        map[string]*wrapperTargetResizeQueue
	listener       net.Listener
}

type wrapperTargetResizeResult struct {
	target wrapperTargetSnapshot
	err    error
}

type wrapperTargetResizeQueue struct {
	viewport compositorViewport
	waiters  []chan wrapperTargetResizeResult
}

type extensionWindowMessage struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Nonce    string `json:"nonce"`
	WindowID int64  `json:"windowId"`
	TabID    int64  `json:"tabId"`
}

type cdpTargetInfo struct {
	TargetID string `json:"targetId"`
	Type     string `json:"type"`
	Title    string `json:"title"`
	URL      string `json:"url"`
}

type cdpTargetWindow struct {
	Target cdpTargetInfo
	Window int64
}

func newWrapperTargetRegistry(runtime *wrapperRuntime, controlSocket string, extensionSocket string, compositorPID int) *wrapperTargetRegistry {
	return &wrapperTargetRegistry{
		runtime:         runtime,
		controlSocket:   controlSocket,
		extensionSocket: extensionSocket,
		cdpPort:         runtime.values.CDPPort,
		compositorPID:   compositorPID,
		viewport:        newCompositorViewport(runtime.values.CompositorWidth, runtime.values.CompositorHeight, viewportScaleDenominator),
		windows:         make(map[int64]wrapperWindowBinding),
		targets:         make(map[string]wrapperTargetSnapshot),
		retiredOutputs:  make(map[string]struct{}),
		resizes:         make(map[string]*wrapperTargetResizeQueue),
	}
}

func (registry *wrapperTargetRegistry) Serve(ctx context.Context) error {
	if err := os.Remove(registry.extensionSocket); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove stale extension socket: %w", err)
	}
	listener, err := net.Listen("unix", registry.extensionSocket)
	if err != nil {
		return fmt.Errorf("listen extension socket: %w", err)
	}
	if err := os.Chmod(registry.extensionSocket, 0o600); err != nil {
		_ = listener.Close()
		return fmt.Errorf("chmod extension socket: %w", err)
	}
	registry.listener = listener
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()
	go registry.reconcileLoop(ctx)
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go registry.handleExtensionConnection(ctx, connection)
		}
	}()
	return nil
}

func (registry *wrapperTargetRegistry) reconcileLoop(ctx context.Context) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := registry.reconcileSettledWindows(ctx); err != nil && ctx.Err() == nil {
				fmt.Fprintf(os.Stderr, "browser-session-wrapper: reconcile targets: %v\n", err)
			}
			registry.cleanupRetiredOutputs(ctx)
		}
	}
}

func (registry *wrapperTargetRegistry) handleExtensionConnection(ctx context.Context, connection net.Conn) {
	defer func() { _ = connection.Close() }()
	reader := bufio.NewReader(io.LimitReader(connection, extensionNativeMessageLimit+1))
	body, err := reader.ReadBytes('\n')
	if err != nil || len(body) > extensionNativeMessageLimit {
		return
	}
	var message extensionWindowMessage
	if err := json.Unmarshal(body[:len(body)-1], &message); err != nil {
		registry.writeExtensionResponse(connection, message.ID, err)
		return
	}
	switch message.Type {
	case "binding.prepare":
		err = registry.prepareBinding(ctx, message.Nonce)
	case "binding.bind":
		err = registry.bindWindow(ctx, message)
	case "binding.cancel":
		err = registry.cancelBinding(ctx, message.Nonce)
	case "window.settled":
		err = registry.settleWindow(ctx, message)
	case "window.closed":
		err = registry.closeWindow(ctx, message.WindowID)
	default:
		err = fmt.Errorf("unsupported extension message type %q", message.Type)
	}
	registry.writeExtensionResponse(connection, message.ID, err)
}

func (registry *wrapperTargetRegistry) prepareBinding(ctx context.Context, nonce string) error {
	if !validRegistryIdentifier(nonce) {
		return errors.New("invalid binding preparation request")
	}
	_, err := sendCompositorControlCommand(ctx, registry.controlSocket, "surface-prepare "+nonce+"\n")
	return err
}

func (registry *wrapperTargetRegistry) cancelBinding(ctx context.Context, nonce string) error {
	if !validRegistryIdentifier(nonce) {
		return errors.New("invalid binding cancellation request")
	}
	_, err := sendCompositorControlCommand(ctx, registry.controlSocket, "surface-cancel "+nonce+"\n")
	return err
}

func (registry *wrapperTargetRegistry) writeExtensionResponse(connection net.Conn, id string, responseErr error) {
	response := map[string]any{"id": id, "ok": responseErr == nil}
	if responseErr != nil {
		response["error"] = responseErr.Error()
	}
	_ = json.NewEncoder(connection).Encode(response)
}

func (registry *wrapperTargetRegistry) bindWindow(ctx context.Context, message extensionWindowMessage) error {
	if message.WindowID <= 0 || message.TabID <= 0 || !validRegistryIdentifier(message.Nonce) {
		return errors.New("invalid binding request")
	}
	bindCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var surfaceID uint64
	for bindCtx.Err() == nil {
		response, err := sendCompositorControlCommand(bindCtx, registry.controlSocket, "surface-find "+message.Nonce+"\n")
		if err == nil {
			if _, err := fmt.Sscanf(response, "ok %d", &surfaceID); err != nil {
				return fmt.Errorf("parse compositor surface binding %q: %w", response, err)
			}
			break
		}
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-bindCtx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
	if surfaceID == 0 {
		return fmt.Errorf("binding marker surface was not found: %w", bindCtx.Err())
	}
	registry.mu.Lock()
	registry.windows[message.WindowID] = wrapperWindowBinding{
		WindowID:  message.WindowID,
		TabID:     message.TabID,
		SurfaceID: surfaceID,
	}
	registry.mu.Unlock()
	return nil
}

func (registry *wrapperTargetRegistry) settleWindow(ctx context.Context, message extensionWindowMessage) error {
	registry.mu.Lock()
	binding, exists := registry.windows[message.WindowID]
	if exists && binding.TabID == message.TabID {
		binding.Settled = true
		registry.windows[message.WindowID] = binding
	}
	registry.mu.Unlock()
	if !exists || binding.TabID != message.TabID {
		return errors.New("window has no matching surface binding")
	}
	settleCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for settleCtx.Err() == nil {
		if err := registry.reconcileSettledWindows(settleCtx); err == nil {
			registry.mu.Lock()
			ready := false
			for _, target := range registry.targets {
				if target.WindowID == message.WindowID && target.SurfaceID == binding.SurfaceID && target.State == wrapperTargetReady {
					ready = true
					break
				}
			}
			registry.mu.Unlock()
			if ready {
				return nil
			}
		}
		timer := time.NewTimer(50 * time.Millisecond)
		select {
		case <-settleCtx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
	return fmt.Errorf("window did not become a ready target: %w", settleCtx.Err())
}

func (registry *wrapperTargetRegistry) closeWindow(_ context.Context, windowID int64) error {
	registry.reconcile.Lock()
	defer registry.reconcile.Unlock()
	registry.mu.Lock()
	delete(registry.windows, windowID)
	var unavailable []wrapperTargetSnapshot
	for targetID, target := range registry.targets {
		if target.WindowID != windowID {
			continue
		}
		target.State = wrapperTargetUnavailable
		registry.targets[targetID] = target
		unavailable = append(unavailable, target)
	}
	registry.mu.Unlock()
	for _, target := range unavailable {
		registry.runtime.targetUnavailable(target)
	}
	return nil
}

func (registry *wrapperTargetRegistry) reconcileSettledWindows(ctx context.Context) error {
	registry.reconcile.Lock()
	defer registry.reconcile.Unlock()

	registry.mu.Lock()
	bindings := make([]wrapperWindowBinding, 0, len(registry.windows))
	for _, binding := range registry.windows {
		if binding.Settled {
			bindings = append(bindings, binding)
		}
	}
	registry.mu.Unlock()
	targets, err := discoverCDPTargetWindows(ctx, registry.cdpPort)
	if err != nil {
		return err
	}
	liveTargets := make(map[string]struct{}, len(targets))
	unresolvedWindow := false
	for _, target := range targets {
		liveTargets[target.Target.TargetID] = struct{}{}
		if target.Window == 0 {
			unresolvedWindow = true
		}
	}
	for _, binding := range bindings {
		var matching []cdpTargetWindow
		for _, target := range targets {
			if target.Window == binding.WindowID {
				matching = append(matching, target)
			}
		}
		if unresolvedWindow || len(matching) != 1 {
			registry.mu.Lock()
			var unavailable []wrapperTargetSnapshot
			for targetID, target := range registry.targets {
				if target.WindowID != binding.WindowID || target.State == wrapperTargetUnavailable || target.State == wrapperTargetClosed {
					continue
				}
				target.State = wrapperTargetUnavailable
				registry.targets[targetID] = target
				unavailable = append(unavailable, target)
			}
			registry.mu.Unlock()
			if len(unavailable) > 0 {
				_, _ = sendCompositorControlCommand(ctx, registry.controlSocket, fmt.Sprintf("surface-unbind %d\n", binding.SurfaceID))
				for _, target := range unavailable {
					registry.runtime.targetUnavailable(target)
				}
			}
			continue
		}
		if err := registry.ensureTarget(ctx, binding, matching[0]); err != nil {
			return err
		}
	}
	registry.mu.Lock()
	var closed []wrapperTargetSnapshot
	for targetID, target := range registry.targets {
		if target.State == wrapperTargetClosed {
			continue
		}
		if _, exists := liveTargets[targetID]; exists {
			continue
		}
		target.State = wrapperTargetClosed
		registry.targets[targetID] = target
		closed = append(closed, target)
	}
	registry.mu.Unlock()
	for _, target := range closed {
		registry.runtime.targetClosed(target)
		_, _ = sendCompositorControlCommand(ctx, registry.controlSocket, fmt.Sprintf("surface-unbind %d\n", target.SurfaceID))
		registry.retireOutput(ctx, target.CaptureID)
	}
	return nil
}

func (registry *wrapperTargetRegistry) ensureTarget(ctx context.Context, binding wrapperWindowBinding, discovered cdpTargetWindow) error {
	registry.mu.Lock()
	existing, exists := registry.targets[discovered.Target.TargetID]
	if exists && existing.WindowID == binding.WindowID && existing.SurfaceID == binding.SurfaceID && existing.State == wrapperTargetReady {
		existing.Title = discovered.Target.Title
		existing.URL = discovered.Target.URL
		registry.targets[existing.TargetID] = existing
		registry.mu.Unlock()
		return nil
	}
	generation := uint64(1)
	viewport := registry.viewport
	if exists {
		generation = existing.Generation + 1
		viewport = existing.Viewport
	}
	registry.mu.Unlock()

	captureID := registryCaptureID(discovered.Target.TargetID, generation)
	created, err := registry.createOutput(ctx, captureID, viewport)
	if err != nil {
		return err
	}
	cleanup := true
	transitioning := false
	replacementBound := false
	completed := false
	defer func() {
		if replacementBound && !completed {
			if !exists || binding.SurfaceID != existing.SurfaceID {
				_, _ = sendCompositorControlCommand(context.Background(), registry.controlSocket, fmt.Sprintf("surface-unbind %d\n", binding.SurfaceID))
			}
			if exists {
				_ = registry.bindSurface(context.Background(), existing.SurfaceID, existing.CaptureID, existing.Viewport)
			}
		}
		if cleanup {
			registry.retireOutput(context.Background(), captureID)
		}
		if transitioning {
			registry.mu.Lock()
			current, currentExists := registry.targets[existing.TargetID]
			if currentExists && current.Generation == existing.Generation && current.State == wrapperTargetPending {
				registry.targets[existing.TargetID] = existing
			}
			registry.mu.Unlock()
			registry.runtime.targetRestored(existing.TargetID)
		}
	}()
	if exists {
		pending := existing
		pending.State = wrapperTargetPending
		registry.mu.Lock()
		registry.targets[existing.TargetID] = pending
		registry.mu.Unlock()
		registry.runtime.targetTransitioning(existing.TargetID)
		transitioning = true
	}
	if err := registry.bindSurface(ctx, binding.SurfaceID, captureID, created.Viewport); err != nil {
		return err
	}
	replacementBound = true
	if err := registry.waitForSurface(ctx, binding.SurfaceID, captureID, created.Viewport); err != nil {
		return err
	}
	next := wrapperTargetSnapshot{
		TargetID:       discovered.Target.TargetID,
		WindowID:       binding.WindowID,
		SurfaceID:      binding.SurfaceID,
		CaptureID:      captureID,
		Generation:     generation,
		PipeWireTarget: created.PipeWireTarget,
		State:          wrapperTargetPending,
		Title:          discovered.Target.Title,
		URL:            discovered.Target.URL,
		Viewport:       created.Viewport,
	}
	if err := registry.runtime.targetReady(ctx, next, existing, exists); err != nil {
		return err
	}
	transitioning = false
	next.State = wrapperTargetReady
	registry.mu.Lock()
	registry.targets[next.TargetID] = next
	registry.mu.Unlock()
	cleanup = false
	completed = true
	if exists {
		if existing.SurfaceID != binding.SurfaceID {
			_, _ = sendCompositorControlCommand(ctx, registry.controlSocket, fmt.Sprintf("surface-unbind %d\n", existing.SurfaceID))
		}
		registry.retireOutput(ctx, existing.CaptureID)
	}
	return nil
}

func (registry *wrapperTargetRegistry) resizeTarget(ctx context.Context, targetID string, width int, height int, deviceScaleFactor float64) (wrapperTargetSnapshot, error) {
	scaleNumerator := viewportScaleNumerator(deviceScaleFactor)
	viewport := newCompositorViewport(width, height, scaleNumerator)
	if width <= 0 || height <= 0 || width > 16384 || height > 16384 || viewport.ContentWidth <= 0 || viewport.ContentHeight <= 0 || viewport.ContentWidth > 16384 || viewport.ContentHeight > 16384 {
		return wrapperTargetSnapshot{}, fmt.Errorf("invalid target viewport %dx%d at DPR %.3f", width, height, deviceScaleFactor)
	}
	waiter := make(chan wrapperTargetResizeResult, 1)
	registry.resizeMu.Lock()
	queue := registry.resizes[targetID]
	if queue == nil {
		queue = &wrapperTargetResizeQueue{}
		registry.resizes[targetID] = queue
		go registry.runTargetResizeQueue(targetID, queue)
	}
	queue.viewport = viewport
	queue.waiters = append(queue.waiters, waiter)
	registry.resizeMu.Unlock()
	select {
	case <-ctx.Done():
		return wrapperTargetSnapshot{}, ctx.Err()
	case result := <-waiter:
		return result.target, result.err
	}
}

func (registry *wrapperTargetRegistry) runTargetResizeQueue(targetID string, queue *wrapperTargetResizeQueue) {
	for {
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-registry.runtime.ctx.Done():
			timer.Stop()
			registry.resizeMu.Lock()
			waiters := queue.waiters
			delete(registry.resizes, targetID)
			registry.resizeMu.Unlock()
			for _, waiter := range waiters {
				waiter <- wrapperTargetResizeResult{err: registry.runtime.ctx.Err()}
			}
			return
		case <-timer.C:
		}
		registry.resizeMu.Lock()
		viewport := queue.viewport
		waiters := queue.waiters
		queue.waiters = nil
		registry.resizeMu.Unlock()
		target, err := registry.applyTargetResize(registry.runtime.ctx, targetID, viewport)
		for _, waiter := range waiters {
			waiter <- wrapperTargetResizeResult{target: target, err: err}
		}
		registry.resizeMu.Lock()
		if len(queue.waiters) == 0 {
			delete(registry.resizes, targetID)
			registry.resizeMu.Unlock()
			return
		}
		registry.resizeMu.Unlock()
	}
}

func (registry *wrapperTargetRegistry) applyTargetResize(ctx context.Context, targetID string, viewport compositorViewport) (wrapperTargetSnapshot, error) {
	registry.reconcile.Lock()
	defer registry.reconcile.Unlock()
	registry.mu.Lock()
	existing, exists := registry.targets[targetID]
	registry.mu.Unlock()
	if !exists || existing.State != wrapperTargetReady {
		return wrapperTargetSnapshot{}, errors.New("target is not ready")
	}
	if viewport == existing.Viewport {
		return existing, nil
	}
	registry.mu.Lock()
	binding, bound := registry.windows[existing.WindowID]
	registry.mu.Unlock()
	if !bound || binding.SurfaceID != existing.SurfaceID {
		return wrapperTargetSnapshot{}, errors.New("target window binding is unavailable")
	}
	if viewport.CanvasWidth == existing.Viewport.CanvasWidth && viewport.CanvasHeight == existing.Viewport.CanvasHeight {
		pending := existing
		pending.State = wrapperTargetPending
		registry.mu.Lock()
		registry.targets[targetID] = pending
		registry.mu.Unlock()
		transitioning := true
		defer func() {
			if !transitioning {
				return
			}
			registry.mu.Lock()
			current, currentExists := registry.targets[targetID]
			if currentExists && current.Generation == existing.Generation && current.State == wrapperTargetPending {
				registry.targets[targetID] = existing
			}
			registry.mu.Unlock()
			registry.runtime.targetRestored(targetID)
		}()
		registry.runtime.targetTransitioning(targetID)
		if err := registry.bindSurface(ctx, existing.SurfaceID, existing.CaptureID, viewport); err != nil {
			return wrapperTargetSnapshot{}, err
		}
		if err := registry.waitForSurface(ctx, existing.SurfaceID, existing.CaptureID, viewport); err != nil {
			_ = registry.bindSurface(context.Background(), existing.SurfaceID, existing.CaptureID, existing.Viewport)
			return wrapperTargetSnapshot{}, err
		}
		next := existing
		next.Viewport = viewport
		next.State = wrapperTargetPending
		if err := registry.runtime.targetReady(ctx, next, existing, true); err != nil {
			_ = registry.bindSurface(context.Background(), existing.SurfaceID, existing.CaptureID, existing.Viewport)
			return wrapperTargetSnapshot{}, err
		}
		next.State = wrapperTargetReady
		registry.mu.Lock()
		registry.targets[targetID] = next
		registry.mu.Unlock()
		transitioning = false
		return next, nil
	}
	pending := existing
	pending.State = wrapperTargetPending
	registry.mu.Lock()
	registry.targets[targetID] = pending
	registry.mu.Unlock()
	captureID := registryCaptureID(targetID, existing.Generation+1)
	created, err := registry.createOutput(ctx, captureID, viewport)
	if err != nil {
		return wrapperTargetSnapshot{}, err
	}
	cleanup := true
	transitioning := true
	defer func() {
		if cleanup {
			registry.retireOutput(context.Background(), captureID)
		}
		if transitioning {
			registry.mu.Lock()
			current, currentExists := registry.targets[targetID]
			if currentExists && current.Generation == existing.Generation && current.State == wrapperTargetPending {
				registry.targets[targetID] = existing
			}
			registry.mu.Unlock()
			registry.runtime.targetRestored(existing.TargetID)
		}
	}()
	registry.runtime.targetTransitioning(existing.TargetID)
	if err := registry.bindSurface(ctx, existing.SurfaceID, captureID, created.Viewport); err != nil {
		return wrapperTargetSnapshot{}, err
	}
	if err := registry.waitForSurface(ctx, existing.SurfaceID, captureID, created.Viewport); err != nil {
		_ = registry.bindSurface(context.Background(), existing.SurfaceID, existing.CaptureID, existing.Viewport)
		return wrapperTargetSnapshot{}, err
	}
	next := existing
	next.CaptureID = captureID
	next.Generation++
	next.PipeWireTarget = created.PipeWireTarget
	next.Viewport = created.Viewport
	next.State = wrapperTargetPending
	if err := registry.runtime.targetReady(ctx, next, existing, true); err != nil {
		_ = registry.bindSurface(context.Background(), existing.SurfaceID, existing.CaptureID, existing.Viewport)
		return wrapperTargetSnapshot{}, err
	}
	transitioning = false
	next.State = wrapperTargetReady
	registry.mu.Lock()
	registry.targets[targetID] = next
	registry.mu.Unlock()
	cleanup = false
	registry.retireOutput(ctx, existing.CaptureID)
	return next, nil
}

type createdWrapperOutput struct {
	PipeWireTarget string
	Viewport       compositorViewport
}

func (registry *wrapperTargetRegistry) createOutput(ctx context.Context, captureID string, viewport compositorViewport) (createdWrapperOutput, error) {
	response, err := sendCompositorControlCommand(ctx, registry.controlSocket, fmt.Sprintf("output-create %s %d %d\n", captureID, viewport.CanvasWidth, viewport.CanvasHeight))
	if err != nil {
		return createdWrapperOutput{}, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			registry.retireOutput(context.Background(), captureID)
		}
	}()
	var returnedID string
	var outputName string
	var canvasWidth int
	var canvasHeight int
	if _, err := fmt.Sscanf(response, "ok %s %s %d %d", &returnedID, &outputName, &canvasWidth, &canvasHeight); err != nil {
		return createdWrapperOutput{}, fmt.Errorf("parse compositor output response %q: %w", response, err)
	}
	if returnedID != captureID {
		return createdWrapperOutput{}, fmt.Errorf("compositor returned unexpected capture id %q", returnedID)
	}
	if canvasWidth != viewport.CanvasWidth || canvasHeight != viewport.CanvasHeight {
		return createdWrapperOutput{}, fmt.Errorf("compositor returned unexpected canvas %dx%d", canvasWidth, canvasHeight)
	}
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var target string
	for waitCtx.Err() == nil {
		target, err = ResolvePipeWireNodeTarget("weston."+outputName, registry.compositorPID)
		if err == nil {
			cleanup = false
			return createdWrapperOutput{PipeWireTarget: target, Viewport: viewport}, nil
		}
		if !errors.Is(err, errPipeWireNodeNotFound) {
			return createdWrapperOutput{}, err
		}
		timer := time.NewTimer(50 * time.Millisecond)
		select {
		case <-waitCtx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
	return createdWrapperOutput{}, fmt.Errorf("PipeWire node for capture %q did not become ready: %w", captureID, waitCtx.Err())
}

func (registry *wrapperTargetRegistry) bindSurface(ctx context.Context, surfaceID uint64, captureID string, viewport compositorViewport) error {
	_, err := sendCompositorControlCommand(ctx, registry.controlSocket, fmt.Sprintf("surface-bind %d %s %d %d %d\n", surfaceID, captureID, viewport.Width, viewport.Height, viewport.ScaleNumerator))
	return err
}

func (registry *wrapperTargetRegistry) destroyOutput(ctx context.Context, captureID string) error {
	if captureID == "" {
		return nil
	}
	_, err := sendCompositorControlCommand(ctx, registry.controlSocket, "output-destroy "+captureID+"\n")
	if err != nil && strings.Contains(err.Error(), "output not found") {
		return nil
	}
	return err
}

func (registry *wrapperTargetRegistry) retireOutput(ctx context.Context, captureID string) {
	if captureID == "" {
		return
	}
	if err := registry.destroyOutput(ctx, captureID); err == nil {
		registry.mu.Lock()
		delete(registry.retiredOutputs, captureID)
		registry.mu.Unlock()
		return
	}
	registry.mu.Lock()
	registry.retiredOutputs[captureID] = struct{}{}
	registry.mu.Unlock()
}

func (registry *wrapperTargetRegistry) cleanupRetiredOutputs(ctx context.Context) {
	registry.mu.Lock()
	captureIDs := make([]string, 0, len(registry.retiredOutputs))
	for captureID := range registry.retiredOutputs {
		captureIDs = append(captureIDs, captureID)
	}
	registry.mu.Unlock()
	for _, captureID := range captureIDs {
		registry.retireOutput(ctx, captureID)
	}
}

func (registry *wrapperTargetRegistry) waitForSurface(ctx context.Context, surfaceID uint64, captureID string, viewport compositorViewport) error {
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for waitCtx.Err() == nil {
		response, err := sendCompositorControlCommand(waitCtx, registry.controlSocket, fmt.Sprintf("surface-status %d\n", surfaceID))
		if err == nil {
			var returnedID string
			var width int
			var height int
			var mapped int
			if _, err := fmt.Sscanf(response, "ok %s %d %d %d", &returnedID, &width, &height, &mapped); err == nil && returnedID == captureID && mapped == 1 && width == viewport.Width && height == viewport.Height {
				return nil
			}
		}
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-waitCtx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
	return fmt.Errorf("surface %d did not commit on capture %q: %w", surfaceID, captureID, waitCtx.Err())
}

func (registry *wrapperTargetRegistry) snapshots() []wrapperTargetSnapshot {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	targets := make([]wrapperTargetSnapshot, 0, len(registry.targets))
	for _, target := range registry.targets {
		targets = append(targets, target)
	}
	return targets
}

func (registry *wrapperTargetRegistry) readyTarget(targetID string) (wrapperTargetSnapshot, bool) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	target, exists := registry.targets[targetID]
	return target, exists && target.State == wrapperTargetReady
}

func (registry *wrapperTargetRegistry) hasTarget(targetID string) bool {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	_, exists := registry.targets[targetID]
	return exists
}

func discoverCDPTargetWindows(ctx context.Context, port int) ([]cdpTargetWindow, error) {
	discoveryCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(discoveryCtx, http.MethodGet, "http://127.0.0.1:"+strconv.Itoa(port)+"/json/version", nil)
	if err != nil {
		return nil, err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("discover browser CDP endpoint: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("discover browser CDP endpoint: status %d", response.StatusCode)
	}
	var version struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(response.Body).Decode(&version); err != nil {
		return nil, fmt.Errorf("decode browser CDP endpoint: %w", err)
	}
	connection, _, err := websocket.Dial(discoveryCtx, version.WebSocketDebuggerURL, nil)
	if err != nil {
		return nil, fmt.Errorf("connect browser CDP endpoint: %w", err)
	}
	connection.SetReadLimit(cdpDiscoveryMessageLimit)
	defer func() { _ = connection.Close(websocket.StatusNormalClosure, "done") }()
	callID := int64(0)
	call := func(method string, params any, result any) error {
		callID++
		requestBody, err := json.Marshal(map[string]any{"id": callID, "method": method, "params": params})
		if err != nil {
			return err
		}
		if err := connection.Write(discoveryCtx, websocket.MessageText, requestBody); err != nil {
			return err
		}
		for {
			_, body, err := connection.Read(discoveryCtx)
			if err != nil {
				return err
			}
			var envelope struct {
				ID     int64           `json:"id"`
				Result json.RawMessage `json:"result"`
				Error  *struct {
					Code    int    `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(body, &envelope); err != nil || envelope.ID != callID {
				continue
			}
			if envelope.Error != nil {
				return fmt.Errorf("CDP %s failed (%d): %s", method, envelope.Error.Code, envelope.Error.Message)
			}
			return json.Unmarshal(envelope.Result, result)
		}
	}
	var targetResult struct {
		TargetInfos []cdpTargetInfo `json:"targetInfos"`
	}
	if err := call("Target.getTargets", map[string]any{}, &targetResult); err != nil {
		return nil, fmt.Errorf("list CDP targets: %w", err)
	}
	targets := make([]cdpTargetWindow, 0, len(targetResult.TargetInfos))
	for _, target := range targetResult.TargetInfos {
		if !isUserCDPTarget(target) {
			continue
		}
		targetWindow := cdpTargetWindow{Target: target}
		var window struct {
			WindowID int64 `json:"windowId"`
		}
		if err := call("Browser.getWindowForTarget", map[string]any{"targetId": target.TargetID}, &window); err == nil {
			targetWindow.Window = window.WindowID
		}
		targets = append(targets, targetWindow)
	}
	return targets, nil
}

func isUserCDPTarget(target cdpTargetInfo) bool {
	if target.Type != "page" {
		return false
	}
	return !strings.HasPrefix(target.URL, "chrome-extension://"+tabWindowEnforcerExtensionID+"/") && !strings.HasPrefix(target.URL, "devtools://")
}

func registryCaptureID(targetID string, generation uint64) string {
	if len(targetID) > 80 {
		targetID = targetID[:80]
	}
	return "capture-" + strings.ToLower(targetID) + "-g" + strconv.FormatUint(generation, 10)
}

func validRegistryIdentifier(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || character == '-' || character == '_' {
			continue
		}
		return false
	}
	return true
}

func scaledViewportDimension(value int, scaleNumerator int) int {
	return (value*scaleNumerator + viewportScaleDenominator/2) / viewportScaleDenominator
}

func newCompositorViewport(width int, height int, scaleNumerator int) compositorViewport {
	width = max(width, viewportMinimumWidth)
	contentWidth := scaledViewportDimension(width, scaleNumerator)
	contentHeight := scaledViewportDimension(height, scaleNumerator)
	return compositorViewport{
		Width:             width,
		Height:            height,
		ScaleNumerator:    scaleNumerator,
		ContentWidth:      contentWidth,
		ContentHeight:     contentHeight,
		CanvasWidth:       (contentWidth + mediaCanvasBucketSize - 1) / mediaCanvasBucketSize * mediaCanvasBucketSize,
		CanvasHeight:      (contentHeight + mediaCanvasBucketSize - 1) / mediaCanvasBucketSize * mediaCanvasBucketSize,
		DeviceScaleFactor: float64(scaleNumerator) / viewportScaleDenominator,
	}
}
