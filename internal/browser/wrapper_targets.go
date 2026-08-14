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
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const cdpDiscoveryMessageLimit = 4 * 1024 * 1024

const (
	cdpFullReconcileInterval = 10 * time.Second
	cdpReconnectDelay        = time.Second
	cdpSettleRefreshInterval = 100 * time.Millisecond
	cdpClosedTargetLimit     = 4096
	retiredCleanupLimit      = 4096
	cdpInfoWorkLimit         = 256
	cdpInfoWorkerLimit       = 8
)

var errCDPRefreshSuperseded = errors.New("CDP target refresh was superseded")

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

	mu                     sync.Mutex
	reconcile              sync.Mutex
	resizeMu               sync.Mutex
	surfaceMu              sync.Mutex
	cdpMu                  sync.Mutex
	cdpRefreshMu           sync.Mutex
	windows                map[int64]wrapperWindowBinding
	targets                map[string]wrapperTargetSnapshot
	cdp                    *cdpBrowserConnection
	cdpTargets             map[string]cdpTargetWindow
	cdpTargetSequences     map[string]uint64
	cdpTargetInfoSequences map[string]uint64
	cdpClosed              map[string]uint64
	cdpEventFloor          uint64
	cdpEventEpoch          uint64
	cdpTargetsKnown        bool
	cdpAwaitRefresh        bool
	cdpUpdates             chan struct{}
	retiredOutputs         map[string]struct{}
	retiredSurfaces        map[uint64]retiredSurfaceOwnership
	retiredSurfaceOutputs  map[string]uint64
	resizes                map[string]*wrapperTargetResizeQueue
	listener               net.Listener
}

type wrapperTargetResizeResult struct {
	target wrapperTargetSnapshot
	err    error
}

type wrapperTargetResizeQueue struct {
	viewport compositorViewport
	waiters  []chan wrapperTargetResizeResult
}

type retiredSurfaceOwnership struct {
	captureID string
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

type cdpEvent struct {
	Method   string
	Params   json.RawMessage
	Sequence uint64
}

type cdpCallResult struct {
	sequence uint64
	result   json.RawMessage
	err      error
}

type cdpBrowserConnection struct {
	connection   *websocket.Conn
	writeMu      sync.Mutex
	nextID       atomic.Int64
	pendingMu    sync.Mutex
	pending      map[int64]chan cdpCallResult
	destroyedMu  sync.Mutex
	destroyed    map[string]uint64
	done         chan struct{}
	events       chan cdpEvent
	overflow     chan struct{}
	sequence     atomic.Uint64
	lastResponse atomic.Uint64
	targetList   atomic.Uint64
	closeOnce    sync.Once
	overflowed   atomic.Bool
	overflowMu   sync.Mutex
	errMu        sync.Mutex
	err          error
	infoMu       sync.Mutex
	infoWork     chan cdpInfoWork
	infoPending  map[string]cdpInfoWork
	infoQueued   map[string]bool
	infoRunning  map[string]bool
}

type cdpInfoWork struct {
	registry   *wrapperTargetRegistry
	ctx        context.Context
	connection *cdpBrowserConnection
	event      cdpEvent
	info       cdpTargetInfo
}

func newWrapperTargetRegistry(runtime *wrapperRuntime, controlSocket string, extensionSocket string, compositorPID int) *wrapperTargetRegistry {
	return &wrapperTargetRegistry{
		runtime:                runtime,
		controlSocket:          controlSocket,
		extensionSocket:        extensionSocket,
		cdpPort:                runtime.values.CDPPort,
		compositorPID:          compositorPID,
		viewport:               newCompositorViewport(runtime.values.CompositorWidth, runtime.values.CompositorHeight, viewportScaleDenominator),
		windows:                make(map[int64]wrapperWindowBinding),
		targets:                make(map[string]wrapperTargetSnapshot),
		cdpTargets:             make(map[string]cdpTargetWindow),
		cdpTargetSequences:     make(map[string]uint64),
		cdpTargetInfoSequences: make(map[string]uint64),
		cdpClosed:              make(map[string]uint64),
		cdpUpdates:             make(chan struct{}, 1),
		retiredOutputs:         make(map[string]struct{}),
		retiredSurfaces:        make(map[uint64]retiredSurfaceOwnership),
		retiredSurfaceOutputs:  make(map[string]uint64),
		resizes:                make(map[string]*wrapperTargetResizeQueue),
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
	go registry.cdpLoop(ctx)
	return nil
}

func (registry *wrapperTargetRegistry) reconcileLoop(ctx context.Context) {
	ticker := time.NewTicker(cdpFullReconcileInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-registry.cdpUpdates:
			if err := registry.reconcileSettledWindows(ctx); err != nil && ctx.Err() == nil {
				fmt.Fprintf(os.Stderr, "browser-session-wrapper: reconcile targets: %v\n", err)
			}
			registry.cleanupRetiredOutputs(ctx)
		case <-ticker.C:
			if err := registry.refreshCDPTargets(ctx); err == nil {
				if err := registry.reconcileSettledWindows(ctx); err != nil && ctx.Err() == nil {
					fmt.Fprintf(os.Stderr, "browser-session-wrapper: reconcile targets: %v\n", err)
				}
			} else if ctx.Err() == nil {
				fmt.Fprintf(os.Stderr, "browser-session-wrapper: refresh targets: %v\n", err)
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
	lastRefresh := time.Time{}
	for settleCtx.Err() == nil {
		if lastRefresh.IsZero() || time.Since(lastRefresh) >= cdpSettleRefreshInterval {
			_ = registry.refreshCDPTargets(settleCtx)
			lastRefresh = time.Now()
		}
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

func (registry *wrapperTargetRegistry) closeWindow(ctx context.Context, windowID int64) error {
	registry.reconcile.Lock()
	defer registry.reconcile.Unlock()
	refreshErr := registry.refreshCDPTargets(ctx)
	registry.mu.Lock()
	binding, bound := registry.windows[windowID]
	registry.mu.Unlock()
	if bound {
		registry.unbindSurface(ctx, binding.SurfaceID)
	}
	registry.mu.Lock()
	delete(registry.windows, windowID)
	registry.mu.Unlock()
	if refreshErr != nil {
		registry.cdpMu.Lock()
		registry.cdpTargets = make(map[string]cdpTargetWindow)
		registry.cdpTargetSequences = make(map[string]uint64)
		registry.cdpTargetInfoSequences = make(map[string]uint64)
		registry.cdpTargetsKnown = false
		registry.cdpAwaitRefresh = true
		registry.cdpMu.Unlock()
		registry.mu.Lock()
		var unavailable []wrapperTargetSnapshot
		for targetID, target := range registry.targets {
			if target.WindowID != windowID || target.State == wrapperTargetClosed || target.State == wrapperTargetUnavailable {
				continue
			}
			target.State = wrapperTargetUnavailable
			registry.targets[targetID] = target
			unavailable = append(unavailable, target)
		}
		registry.mu.Unlock()
		for _, target := range unavailable {
			registry.releaseUnavailableTarget(ctx, target)
		}
		registry.notifyCDPUpdate()
		return nil
	}
	registry.mu.Lock()
	var unavailable []wrapperTargetSnapshot
	for targetID, target := range registry.targets {
		if target.WindowID != windowID {
			continue
		}
		if target.State == wrapperTargetClosed || target.State == wrapperTargetUnavailable {
			continue
		}
		target.State = wrapperTargetUnavailable
		registry.targets[targetID] = target
		unavailable = append(unavailable, target)
	}
	registry.mu.Unlock()
	for _, target := range unavailable {
		registry.releaseUnavailableTarget(ctx, target)
	}
	registry.notifyCDPUpdate()
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
	targets, err := registry.cdpTargetSnapshot()
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
	ownedTargetIDs := make(map[string]struct{})
	if !unresolvedWindow {
		for _, binding := range bindings {
			var matching []cdpTargetWindow
			for _, target := range targets {
				if target.Window == binding.WindowID {
					matching = append(matching, target)
				}
			}
			if len(matching) == 1 {
				ownedTargetIDs[matching[0].Target.TargetID] = struct{}{}
			}
		}
	}
	for _, binding := range bindings {
		var matching []cdpTargetWindow
		for _, target := range targets {
			if target.Window == binding.WindowID {
				matching = append(matching, target)
			}
		}
		if unresolvedWindow {
			continue
		}
		if len(matching) != 1 {
			registry.mu.Lock()
			var unavailable []wrapperTargetSnapshot
			for targetID, target := range registry.targets {
				if _, owned := ownedTargetIDs[targetID]; owned {
					continue
				}
				if target.WindowID != binding.WindowID || target.State == wrapperTargetUnavailable || target.State == wrapperTargetClosed {
					continue
				}
				target.State = wrapperTargetUnavailable
				registry.targets[targetID] = target
				unavailable = append(unavailable, target)
			}
			registry.mu.Unlock()
			if len(unavailable) > 0 {
				for _, target := range unavailable {
					registry.releaseUnavailableTarget(ctx, target)
				}
			}
			continue
		}
		if err := registry.ensureTarget(ctx, binding, matching[0]); err != nil {
			return err
		}
	}
	registry.mu.Lock()
	missingTargetIDs := make([]string, 0)
	for targetID, target := range registry.targets {
		if target.State != wrapperTargetClosed {
			if _, exists := liveTargets[targetID]; !exists {
				missingTargetIDs = append(missingTargetIDs, targetID)
			}
		}
	}
	registry.mu.Unlock()
	registry.cdpMu.Lock()
	if !registry.cdpTargetsKnown {
		registry.cdpMu.Unlock()
		return nil
	}
	stillMissing := make([]string, 0, len(missingTargetIDs))
	for _, targetID := range missingTargetIDs {
		if _, exists := registry.cdpTargets[targetID]; exists {
			continue
		}
		if _, exists := registry.cdpClosed[targetID]; !exists && len(registry.cdpClosed) >= cdpClosedTargetLimit {
			registry.cdpClosed = make(map[string]uint64)
			registry.cdpTargetsKnown = false
			registry.cdpAwaitRefresh = true
			registry.notifyCDPUpdate()
		}
		registry.cdpClosed[targetID] = 0
		stillMissing = append(stillMissing, targetID)
	}
	registry.cdpMu.Unlock()
	registry.mu.Lock()
	var closed []wrapperTargetSnapshot
	for _, targetID := range stillMissing {
		target, exists := registry.targets[targetID]
		if !exists || target.State == wrapperTargetClosed {
			continue
		}
		target.State = wrapperTargetClosed
		registry.targets[targetID] = target
		closed = append(closed, target)
	}
	registry.mu.Unlock()
	for _, target := range closed {
		registry.runtime.targetClosed(target)
		registry.retireTargetOutput(ctx, target)
	}
	return nil
}

func (registry *wrapperTargetRegistry) validateTargetPublicationLocked(targetID string, expectedGeneration uint64, binding wrapperWindowBinding, hadPrevious bool, connection *cdpBrowserConnection) error {
	registry.mu.Lock()
	current, exists := registry.targets[targetID]
	currentBinding, bindingExists := registry.windows[binding.WindowID]
	registry.mu.Unlock()
	if hadPrevious {
		if !exists || current.Generation != expectedGeneration || current.State != wrapperTargetPending {
			return errors.New("target ownership changed during binding")
		}
	} else if exists {
		return errors.New("target was recreated during binding")
	}
	if !bindingExists || currentBinding.WindowID != binding.WindowID || currentBinding.TabID != binding.TabID || currentBinding.SurfaceID != binding.SurfaceID || !currentBinding.Settled {
		return errors.New("window binding changed during target publication")
	}
	registry.cdpMu.Lock()
	defer registry.cdpMu.Unlock()
	if registry.cdp != connection || registry.cdpAwaitRefresh || !registry.cdpTargetsKnown {
		return errors.New("browser CDP state changed during target publication")
	}
	select {
	case <-connection.done:
		return errors.New("browser CDP connection closed during target publication")
	default:
	}
	discovered, ok := registry.cdpTargets[targetID]
	if !ok || discovered.Window != binding.WindowID {
		return errors.New("target disappeared during target publication")
	}
	return nil
}

func (registry *wrapperTargetRegistry) rollbackTargetSideEffects(ctx context.Context, previous, replacement wrapperTargetSnapshot, hadPrevious bool) bool {
	registry.surfaceMu.Lock()
	defer registry.surfaceMu.Unlock()
	if hadPrevious {
		registry.mu.Lock()
		current, exists := registry.targets[previous.TargetID]
		valid := exists && current.Generation == previous.Generation && current.State == wrapperTargetPending
		registry.mu.Unlock()
		if !valid {
			return false
		}
		return registry.runtime.targetReady(ctx, previous, replacement, true) == nil
	}
	registry.runtime.targetUnavailable(replacement)
	registry.runtime.stopTargetRecordingsGeneration(replacement.TargetID, replacement.Generation)
	return true
}

func (registry *wrapperTargetRegistry) ensureTarget(ctx context.Context, binding wrapperWindowBinding, discovered cdpTargetWindow) error {
	registry.cdpMu.Lock()
	connection := registry.cdp
	registry.cdpMu.Unlock()
	if connection == nil {
		return errors.New("browser CDP connection is unavailable")
	}
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
	var superseded []wrapperTargetSnapshot
	registry.mu.Lock()
	for targetID, target := range registry.targets {
		if targetID == discovered.Target.TargetID || target.WindowID != binding.WindowID || target.SurfaceID != binding.SurfaceID || target.State == wrapperTargetClosed || target.State == wrapperTargetUnavailable {
			continue
		}
		target.State = wrapperTargetPending
		registry.targets[targetID] = target
		superseded = append(superseded, target)
	}
	registry.mu.Unlock()

	captureID := registryCaptureID(discovered.Target.TargetID, generation)
	created, err := registry.createOutput(ctx, captureID, viewport)
	if err != nil {
		for _, old := range superseded {
			registry.mu.Lock()
			registry.targets[old.TargetID] = old
			registry.mu.Unlock()
		}
		return err
	}
	cleanup := true
	transitioning := false
	replacementBound := false
	replacementUnbound := false
	sideEffectsStarted := false
	completed := false
	defer func() {
		rollbackFailed := false
		replacement := wrapperTargetSnapshot{
			TargetID: discovered.Target.TargetID, WindowID: binding.WindowID, SurfaceID: binding.SurfaceID,
			CaptureID: captureID, Generation: generation, PipeWireTarget: created.PipeWireTarget,
			Viewport: created.Viewport, State: wrapperTargetUnavailable,
		}
		if sideEffectsStarted && !completed && !registry.rollbackTargetSideEffects(registry.cleanupContext(), existing, replacement, exists) {
			rollbackFailed = true
		}
		if replacementBound && !completed {
			if !exists || binding.SurfaceID != existing.SurfaceID {
				replacementUnbound = registry.unbindSurfaceForCapture(registry.cleanupContext(), binding.SurfaceID, captureID)
				rollbackFailed = !replacementUnbound
			}
			if exists && (binding.SurfaceID == existing.SurfaceID || replacementUnbound) {
				if err := registry.bindSurface(registry.cleanupContext(), existing.SurfaceID, existing.CaptureID, existing.Viewport); err != nil {
					rollbackFailed = true
				}
			}
		}
		if rollbackFailed {
			registry.mu.Lock()
			if exists {
				old := existing
				if current, ok := registry.targets[old.TargetID]; ok && current.Generation == old.Generation {
					old.State = wrapperTargetUnavailable
					registry.targets[old.TargetID] = old
				}
			}
			registry.mu.Unlock()
			registry.runtime.targetUnavailable(replacement)
			if exists {
				registry.runtime.stopTargetRecordingsGeneration(existing.TargetID, existing.Generation)
			}
			registry.runtime.stopTargetRecordingsGeneration(replacement.TargetID, replacement.Generation)
			registry.deferTargetCleanup(existing)
			registry.deferTargetCleanup(replacement)
			cleanup = false
		}
		if completed {
			for _, old := range superseded {
				registry.mu.Lock()
				if current, ok := registry.targets[old.TargetID]; ok && current.Generation == old.Generation {
					current.State = wrapperTargetClosed
					registry.targets[old.TargetID] = current
				}
				registry.mu.Unlock()
				registry.runtime.targetClosed(old)
				registry.retireOutput(registry.cleanupContext(), old.CaptureID)
			}
		} else {
			for _, old := range superseded {
				if rollbackFailed {
					unavailable := old
					unavailable.State = wrapperTargetUnavailable
					registry.mu.Lock()
					registry.targets[old.TargetID] = unavailable
					registry.mu.Unlock()
					registry.runtime.targetUnavailable(unavailable)
					registry.deferTargetCleanup(unavailable)
				} else {
					registry.mu.Lock()
					current, currentExists := registry.targets[old.TargetID]
					if currentExists && current.State == wrapperTargetPending && current.Generation == old.Generation {
						registry.targets[old.TargetID] = old
					}
					registry.mu.Unlock()
					registry.runtime.targetRestored(old.TargetID)
				}
			}
		}
		if cleanup {
			if replacementBound && (!exists || binding.SurfaceID != existing.SurfaceID) && !replacementUnbound {
				registry.retireTargetOutput(registry.cleanupContext(), wrapperTargetSnapshot{SurfaceID: binding.SurfaceID, CaptureID: captureID})
			} else {
				registry.retireOutput(registry.cleanupContext(), captureID)
			}
		}
		if transitioning && !rollbackFailed {
			registry.mu.Lock()
			current, currentExists := registry.targets[existing.TargetID]
			if currentExists && current.Generation == existing.Generation && current.State == wrapperTargetPending {
				registry.targets[existing.TargetID] = existing
			}
			registry.mu.Unlock()
			registry.runtime.targetRestored(existing.TargetID)
		}
	}()
	registry.surfaceMu.Lock()
	if exists {
		pending := existing
		pending.State = wrapperTargetPending
		registry.mu.Lock()
		registry.targets[existing.TargetID] = pending
		registry.mu.Unlock()
		registry.runtime.targetTransitioning(existing.TargetID)
		transitioning = true
	}
	if err := registry.bindSurfaceLocked(ctx, binding.SurfaceID, captureID, created.Viewport); err != nil {
		registry.surfaceMu.Unlock()
		return err
	}
	replacementBound = true
	if err := registry.waitForSurface(ctx, binding.SurfaceID, captureID, created.Viewport); err != nil {
		registry.surfaceMu.Unlock()
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
	sideEffectsStarted = true
	if err := registry.runtime.targetReady(ctx, next, existing, exists); err != nil {
		registry.surfaceMu.Unlock()
		return err
	}
	if err := registry.validateTargetPublicationLocked(next.TargetID, existing.Generation, binding, exists, connection); err != nil {
		registry.surfaceMu.Unlock()
		return err
	}
	transitioning = false
	next.State = wrapperTargetReady
	registry.mu.Lock()
	registry.targets[next.TargetID] = next
	registry.mu.Unlock()
	registry.surfaceMu.Unlock()
	cleanup = false
	completed = true
	if exists {
		if existing.SurfaceID != binding.SurfaceID {
			registry.retireTargetOutput(ctx, existing)
		} else {
			registry.retireOutput(ctx, existing.CaptureID)
		}
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
		registry.resizeMu.Lock()
		for i, queued := range queue.waiters {
			if queued == waiter {
				queue.waiters = append(queue.waiters[:i], queue.waiters[i+1:]...)
				break
			}
		}
		registry.resizeMu.Unlock()
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
	registry.cdpMu.Lock()
	connection := registry.cdp
	registry.cdpMu.Unlock()
	if connection == nil {
		return wrapperTargetSnapshot{}, errors.New("browser CDP connection is unavailable")
	}
	if viewport.CanvasWidth == existing.Viewport.CanvasWidth && viewport.CanvasHeight == existing.Viewport.CanvasHeight {
		pending := existing
		pending.State = wrapperTargetPending
		registry.surfaceMu.Lock()
		registry.mu.Lock()
		registry.targets[targetID] = pending
		registry.mu.Unlock()
		transitioning := true
		restoreFailed := false
		sideEffectsStarted := false
		defer func() {
			if !transitioning {
				return
			}
			if sideEffectsStarted {
				replacement := existing
				replacement.Viewport = viewport
				if !registry.rollbackTargetSideEffects(registry.cleanupContext(), existing, replacement, true) {
					restoreFailed = true
				}
			}
			if restoreFailed {
				unavailable := existing
				unavailable.State = wrapperTargetUnavailable
				registry.mu.Lock()
				registry.targets[targetID] = unavailable
				registry.mu.Unlock()
				registry.runtime.targetUnavailable(unavailable)
				registry.runtime.stopTargetRecordingsGeneration(targetID, unavailable.Generation)
				registry.deferTargetCleanup(unavailable)
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
		if err := registry.bindSurfaceLocked(ctx, existing.SurfaceID, existing.CaptureID, viewport); err != nil {
			registry.surfaceMu.Unlock()
			return wrapperTargetSnapshot{}, err
		}
		if err := registry.waitForSurface(ctx, existing.SurfaceID, existing.CaptureID, viewport); err != nil {
			if restoreErr := registry.bindSurfaceLocked(registry.cleanupContext(), existing.SurfaceID, existing.CaptureID, existing.Viewport); restoreErr != nil {
				restoreFailed = true
			}
			registry.surfaceMu.Unlock()
			return wrapperTargetSnapshot{}, err
		}
		next := existing
		next.Viewport = viewport
		next.State = wrapperTargetPending
		sideEffectsStarted = true
		if err := registry.runtime.targetReady(ctx, next, existing, true); err != nil {
			if restoreErr := registry.bindSurfaceLocked(registry.cleanupContext(), existing.SurfaceID, existing.CaptureID, existing.Viewport); restoreErr != nil {
				restoreFailed = true
			}
			registry.surfaceMu.Unlock()
			return wrapperTargetSnapshot{}, err
		}
		if err := registry.validateTargetPublicationLocked(targetID, existing.Generation, binding, true, connection); err != nil {
			registry.surfaceMu.Unlock()
			return wrapperTargetSnapshot{}, err
		}
		next.State = wrapperTargetReady
		registry.mu.Lock()
		registry.targets[targetID] = next
		registry.mu.Unlock()
		registry.surfaceMu.Unlock()
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
	replacementBound := false
	sideEffectsStarted := false
	defer func() {
		rollbackFailed := false
		replacement := existing
		replacement.CaptureID = captureID
		replacement.Generation++
		replacement.Viewport = viewport
		replacement.State = wrapperTargetUnavailable
		if sideEffectsStarted && !registry.rollbackTargetSideEffects(registry.cleanupContext(), existing, replacement, true) {
			rollbackFailed = true
		}
		if cleanup {
			if replacementBound {
				if registry.unbindSurfaceForCapture(registry.cleanupContext(), existing.SurfaceID, captureID) {
					if err := registry.bindSurface(registry.cleanupContext(), existing.SurfaceID, existing.CaptureID, existing.Viewport); err != nil {
						rollbackFailed = true
					}
					registry.retireOutput(registry.cleanupContext(), captureID)
				} else {
					rollbackFailed = true
				}
			} else {
				registry.retireOutput(registry.cleanupContext(), captureID)
			}
		}
		if rollbackFailed {
			registry.mu.Lock()
			old := existing
			if current, ok := registry.targets[targetID]; ok && current.Generation == old.Generation {
				old.State = wrapperTargetUnavailable
				registry.targets[targetID] = old
			}
			registry.mu.Unlock()
			registry.runtime.targetUnavailable(replacement)
			registry.runtime.stopTargetRecordingsGeneration(existing.TargetID, existing.Generation)
			registry.runtime.stopTargetRecordingsGeneration(targetID, replacement.Generation)
			registry.deferTargetCleanup(existing)
			registry.deferTargetCleanup(replacement)
			cleanup = false
		}
		if transitioning && !rollbackFailed {
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
	registry.surfaceMu.Lock()
	if err := registry.bindSurfaceLocked(ctx, existing.SurfaceID, captureID, created.Viewport); err != nil {
		registry.surfaceMu.Unlock()
		return wrapperTargetSnapshot{}, err
	}
	replacementBound = true
	if err := registry.waitForSurface(ctx, existing.SurfaceID, captureID, created.Viewport); err != nil {
		registry.surfaceMu.Unlock()
		return wrapperTargetSnapshot{}, err
	}
	next := existing
	next.CaptureID = captureID
	next.Generation++
	next.PipeWireTarget = created.PipeWireTarget
	next.Viewport = created.Viewport
	next.State = wrapperTargetPending
	sideEffectsStarted = true
	if err := registry.runtime.targetReady(ctx, next, existing, true); err != nil {
		registry.surfaceMu.Unlock()
		return wrapperTargetSnapshot{}, err
	}
	if err := registry.validateTargetPublicationLocked(targetID, existing.Generation, binding, true, connection); err != nil {
		registry.surfaceMu.Unlock()
		return wrapperTargetSnapshot{}, err
	}
	transitioning = false
	next.State = wrapperTargetReady
	registry.mu.Lock()
	registry.targets[targetID] = next
	registry.mu.Unlock()
	registry.surfaceMu.Unlock()
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
			registry.retireOutput(registry.cleanupContext(), captureID)
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
	registry.surfaceMu.Lock()
	defer registry.surfaceMu.Unlock()
	return registry.bindSurfaceLocked(ctx, surfaceID, captureID, viewport)
}

func (registry *wrapperTargetRegistry) bindSurfaceLocked(ctx context.Context, surfaceID uint64, captureID string, viewport compositorViewport) error {
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
		delete(registry.retiredSurfaceOutputs, captureID)
		registry.mu.Unlock()
		return
	}
	if !registry.waitRetiredOutputSlot(ctx) {
		return
	}
	registry.mu.Lock()
	registry.retiredOutputs[captureID] = struct{}{}
	registry.mu.Unlock()
}

func (registry *wrapperTargetRegistry) unbindSurface(ctx context.Context, surfaceID uint64) bool {
	return registry.unbindSurfaceForCapture(ctx, surfaceID, "")
}

func (registry *wrapperTargetRegistry) unbindSurfaceForCapture(ctx context.Context, surfaceID uint64, captureID string) bool {
	if surfaceID == 0 {
		return true
	}
	registry.surfaceMu.Lock()
	err := registry.unbindSurfaceLocked(ctx, surfaceID)
	registry.surfaceMu.Unlock()
	if err == nil {
		registry.mu.Lock()
		delete(registry.retiredSurfaces, surfaceID)
		registry.mu.Unlock()
		return true
	}
	if !registry.waitRetiredSurfaceSlot(ctx) {
		return false
	}
	registry.mu.Lock()
	registry.retiredSurfaces[surfaceID] = retiredSurfaceOwnership{captureID: captureID}
	registry.mu.Unlock()
	return false
}

func (registry *wrapperTargetRegistry) unbindSurfaceLocked(ctx context.Context, surfaceID uint64) error {
	_, err := sendCompositorControlCommand(ctx, registry.controlSocket, fmt.Sprintf("surface-unbind %d\n", surfaceID))
	return err
}

type retiredTargetCleanup struct {
	target              wrapperTargetSnapshot
	retireSurfaceOutput bool
	retireOutput        bool
}

func (registry *wrapperTargetRegistry) retireTargetOutputLocked(ctx context.Context, target wrapperTargetSnapshot) retiredTargetCleanup {
	cleanup := retiredTargetCleanup{target: target}
	registry.mu.Lock()
	current, exists := registry.targets[target.TargetID]
	staleGeneration := !exists || current.Generation != target.Generation
	if !staleGeneration && current.CaptureID == target.CaptureID && current.State != wrapperTargetClosed && current.State != wrapperTargetUnavailable {
		registry.mu.Unlock()
		return cleanup
	}
	registry.mu.Unlock()
	if target.SurfaceID != 0 {
		registry.mu.Lock()
		activeCapture := ""
		for _, candidate := range registry.targets {
			if candidate.SurfaceID == target.SurfaceID && candidate.State != wrapperTargetClosed && candidate.State != wrapperTargetUnavailable {
				activeCapture = candidate.CaptureID
				break
			}
		}
		registry.mu.Unlock()
		if activeCapture != "" && activeCapture != target.CaptureID {
			cleanup.retireOutput = target.CaptureID != ""
			return cleanup
		}
		if err := registry.unbindSurfaceLocked(ctx, target.SurfaceID); err != nil {
			cleanup.retireSurfaceOutput = true
			return cleanup
		}
	}
	if target.CaptureID != "" {
		if err := registry.destroyOutput(ctx, target.CaptureID); err != nil {
			cleanup.retireOutput = true
			return cleanup
		}
	}
	return cleanup
}

func (registry *wrapperTargetRegistry) queueRetiredTargetCleanup(ctx context.Context, cleanup retiredTargetCleanup) {
	if cleanup.retireSurfaceOutput {
		if !registry.waitRetiredSurfaceOutputSlot(ctx) {
			return
		}
		registry.mu.Lock()
		registry.retiredSurfaceOutputs[cleanup.target.CaptureID] = cleanup.target.SurfaceID
		registry.mu.Unlock()
		return
	}
	if cleanup.retireOutput {
		if !registry.waitRetiredOutputSlot(ctx) {
			return
		}
		registry.mu.Lock()
		registry.retiredOutputs[cleanup.target.CaptureID] = struct{}{}
		registry.mu.Unlock()
	}
}

func (registry *wrapperTargetRegistry) retireTargetOutput(ctx context.Context, target wrapperTargetSnapshot) {
	registry.surfaceMu.Lock()
	cleanup := registry.retireTargetOutputLocked(ctx, target)
	registry.surfaceMu.Unlock()
	registry.queueRetiredTargetCleanup(ctx, cleanup)
}

func (registry *wrapperTargetRegistry) deferTargetCleanup(target wrapperTargetSnapshot) {
	if target.CaptureID == "" {
		return
	}
	cleanupCtx := registry.cleanupContext()
	if !registry.waitRetiredSurfaceOutputSlot(cleanupCtx) {
		return
	}
	if target.SurfaceID != 0 {
		if !registry.waitRetiredSurfaceSlot(cleanupCtx) {
			return
		}
	}
	registry.mu.Lock()
	registry.retiredSurfaceOutputs[target.CaptureID] = target.SurfaceID
	if target.SurfaceID != 0 {
		registry.retiredSurfaces[target.SurfaceID] = retiredSurfaceOwnership{captureID: target.CaptureID}
	}
	registry.mu.Unlock()
}

func (registry *wrapperTargetRegistry) waitRetiredOutputSlot(ctx context.Context) bool {
	for {
		select {
		case <-ctx.Done():
			return false
		default:
		}
		registry.mu.Lock()
		if len(registry.retiredOutputs) < retiredCleanupLimit {
			registry.mu.Unlock()
			return true
		}
		var captureID string
		for candidate := range registry.retiredOutputs {
			captureID = candidate
			break
		}
		registry.mu.Unlock()
		if registry.destroyOutput(ctx, captureID) == nil {
			registry.mu.Lock()
			delete(registry.retiredOutputs, captureID)
			registry.mu.Unlock()
			continue
		}
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return false
		case <-timer.C:
		}
	}
}

func (registry *wrapperTargetRegistry) waitRetiredSurfaceSlot(ctx context.Context) bool {
	for {
		select {
		case <-ctx.Done():
			return false
		default:
		}
		registry.surfaceMu.Lock()
		registry.mu.Lock()
		if len(registry.retiredSurfaces) < retiredCleanupLimit {
			registry.mu.Unlock()
			registry.surfaceMu.Unlock()
			return true
		}
		var surfaceID uint64
		for candidate := range registry.retiredSurfaces {
			surfaceID = candidate
			break
		}
		active := false
		for _, target := range registry.targets {
			if target.SurfaceID == surfaceID && target.State != wrapperTargetClosed && target.State != wrapperTargetUnavailable {
				active = true
				break
			}
		}
		if active {
			delete(registry.retiredSurfaces, surfaceID)
			registry.surfaceMu.Unlock()
			registry.mu.Unlock()
			continue
		}
		registry.mu.Unlock()
		_, err := sendCompositorControlCommand(ctx, registry.controlSocket, fmt.Sprintf("surface-unbind %d\n", surfaceID))
		registry.surfaceMu.Unlock()
		if err == nil {
			registry.mu.Lock()
			delete(registry.retiredSurfaces, surfaceID)
			registry.mu.Unlock()
			continue
		}
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return false
		case <-timer.C:
		}
	}
}

func (registry *wrapperTargetRegistry) waitRetiredSurfaceOutputSlot(ctx context.Context) bool {
	for {
		select {
		case <-ctx.Done():
			return false
		default:
		}
		registry.surfaceMu.Lock()
		registry.mu.Lock()
		if len(registry.retiredSurfaceOutputs) < retiredCleanupLimit {
			registry.mu.Unlock()
			registry.surfaceMu.Unlock()
			return true
		}
		var captureID string
		var surfaceID uint64
		for candidate, candidateSurface := range registry.retiredSurfaceOutputs {
			captureID, surfaceID = candidate, candidateSurface
			break
		}
		activeCapture := ""
		active := false
		for _, target := range registry.targets {
			if target.SurfaceID == surfaceID && target.State != wrapperTargetClosed && target.State != wrapperTargetUnavailable {
				active = true
				activeCapture = target.CaptureID
				break
			}
		}
		if active && activeCapture == captureID {
			delete(registry.retiredSurfaceOutputs, captureID)
			delete(registry.retiredSurfaces, surfaceID)
			registry.surfaceMu.Unlock()
			registry.mu.Unlock()
			continue
		}
		registry.mu.Unlock()
		if active {
			if registry.destroyOutput(ctx, captureID) == nil {
				registry.surfaceMu.Unlock()
				registry.mu.Lock()
				delete(registry.retiredSurfaceOutputs, captureID)
				registry.mu.Unlock()
				continue
			}
			registry.surfaceMu.Unlock()
			timer := time.NewTimer(25 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return false
			case <-timer.C:
			}
			continue
		}
		_, err := sendCompositorControlCommand(ctx, registry.controlSocket, fmt.Sprintf("surface-unbind %d\n", surfaceID))
		if err == nil {
			if registry.destroyOutput(ctx, captureID) == nil {
				registry.surfaceMu.Unlock()
				registry.mu.Lock()
				delete(registry.retiredSurfaceOutputs, captureID)
				delete(registry.retiredSurfaces, surfaceID)
				registry.mu.Unlock()
				continue
			}
		}
		registry.surfaceMu.Unlock()
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return false
		case <-timer.C:
		}
	}
}

func (registry *wrapperTargetRegistry) cleanupRetiredOutputs(ctx context.Context) {
	registry.mu.Lock()
	surfaceIDs := make([]uint64, 0, len(registry.retiredSurfaces))
	for surfaceID := range registry.retiredSurfaces {
		surfaceIDs = append(surfaceIDs, surfaceID)
	}
	deferredOutputs := make(map[string]uint64, len(registry.retiredSurfaceOutputs))
	for captureID, surfaceID := range registry.retiredSurfaceOutputs {
		deferredOutputs[captureID] = surfaceID
	}
	captureIDs := make([]string, 0, len(registry.retiredOutputs))
	for captureID := range registry.retiredOutputs {
		captureIDs = append(captureIDs, captureID)
	}
	registry.mu.Unlock()
	for _, surfaceID := range surfaceIDs {
		registry.cleanupRetiredSurface(ctx, surfaceID)
	}
	for captureID, surfaceID := range deferredOutputs {
		registry.cleanupRetiredSurfaceOutput(ctx, captureID, surfaceID)
	}
	for _, captureID := range captureIDs {
		registry.cleanupRetiredOutput(ctx, captureID)
	}
}

func (registry *wrapperTargetRegistry) cleanupRetiredSurface(ctx context.Context, surfaceID uint64) {
	registry.surfaceMu.Lock()
	registry.mu.Lock()
	active := false
	for _, target := range registry.targets {
		if target.SurfaceID == surfaceID && target.State != wrapperTargetClosed && target.State != wrapperTargetUnavailable {
			active = true
			break
		}
	}
	if active {
		delete(registry.retiredSurfaces, surfaceID)
		registry.mu.Unlock()
		registry.surfaceMu.Unlock()
		return
	}
	registry.mu.Unlock()
	err := registry.unbindSurfaceLocked(ctx, surfaceID)
	if err == nil {
		registry.mu.Lock()
		delete(registry.retiredSurfaces, surfaceID)
		registry.mu.Unlock()
	}
	registry.surfaceMu.Unlock()
}

func (registry *wrapperTargetRegistry) cleanupRetiredSurfaceOutput(ctx context.Context, captureID string, surfaceID uint64) {
	registry.surfaceMu.Lock()
	registry.mu.Lock()
	activeCapture := ""
	for _, target := range registry.targets {
		if target.SurfaceID == surfaceID && target.State != wrapperTargetClosed && target.State != wrapperTargetUnavailable {
			activeCapture = target.CaptureID
			break
		}
	}
	if activeCapture == captureID {
		delete(registry.retiredSurfaceOutputs, captureID)
		delete(registry.retiredSurfaces, surfaceID)
		registry.mu.Unlock()
		registry.surfaceMu.Unlock()
		return
	}
	registry.mu.Unlock()
	if activeCapture != "" {
		err := registry.destroyOutput(ctx, captureID)
		if err == nil {
			registry.mu.Lock()
			delete(registry.retiredSurfaceOutputs, captureID)
			registry.mu.Unlock()
		}
		registry.surfaceMu.Unlock()
		return
	}
	if err := registry.unbindSurfaceLocked(ctx, surfaceID); err == nil {
		if err := registry.destroyOutput(ctx, captureID); err == nil {
			registry.mu.Lock()
			delete(registry.retiredSurfaceOutputs, captureID)
			delete(registry.retiredSurfaces, surfaceID)
			registry.mu.Unlock()
		}
	}
	registry.surfaceMu.Unlock()
}

func (registry *wrapperTargetRegistry) cleanupRetiredOutput(ctx context.Context, captureID string) {
	registry.surfaceMu.Lock()
	registry.mu.Lock()
	active := false
	for _, target := range registry.targets {
		if target.CaptureID == captureID && target.State != wrapperTargetClosed && target.State != wrapperTargetUnavailable {
			active = true
			break
		}
	}
	registry.mu.Unlock()
	if !active {
		if err := registry.destroyOutput(ctx, captureID); err == nil {
			registry.mu.Lock()
			delete(registry.retiredOutputs, captureID)
			registry.mu.Unlock()
		}
	} else {
		registry.mu.Lock()
		delete(registry.retiredOutputs, captureID)
		registry.mu.Unlock()
	}
	registry.surfaceMu.Unlock()
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

func (registry *wrapperTargetRegistry) cdpLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		connection, err := dialCDPBrowserConnection(ctx, registry.cdpPort)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			timer := time.NewTimer(cdpReconnectDelay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			continue
		}

		callCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		err = connection.call(callCtx, "Target.setDiscoverTargets", map[string]any{"discover": true}, nil)
		cancel()
		if err == nil {
			registry.setCDPConnection(connection)
			refreshResult := make(chan error, 1)
			go func() { refreshResult <- registry.refreshCDPTargetsWithConnection(ctx, connection) }()
			var initialEvents []cdpEvent
			for {
				select {
				case err = <-refreshResult:
					goto initialRefreshDone
				case event := <-connection.events:
					initialEvents = append(initialEvents, event)
				case <-connection.done:
					err = connection.closeError()
					goto initialRefreshDone
				case <-ctx.Done():
					err = ctx.Err()
					goto initialRefreshDone
				}
			}
		initialRefreshDone:
			if err == nil {
				initialEvents = append(initialEvents, connection.drainEventsThrough(connection.targetList.Load())...)
				for _, event := range initialEvents {
					if err := registry.applyCDPEvent(ctx, connection, event); err != nil {
						fmt.Fprintf(os.Stderr, "browser-session-wrapper: handle CDP event after initial refresh: %v\n", err)
					}
				}
			}
		}
		if err != nil {
			registry.disconnectCDPConnection(ctx, connection)
			connection.Close()
			if ctx.Err() != nil {
				return
			}
			timer := time.NewTimer(cdpReconnectDelay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			continue
		}
		registry.notifyCDPUpdate()

		connected := true
		refreshResults := make(chan error, 1)
		refreshRunning := false
		for connected {
			select {
			case <-ctx.Done():
				registry.disconnectCDPConnection(ctx, connection)
				connection.Close()
				return
			case <-connection.done:
				connected = false
			case <-connection.overflow:
				if !refreshRunning {
					refreshRunning = true
					go func() { refreshResults <- registry.refreshCDPTargetsWithConnection(ctx, connection) }()
				}
			case err := <-refreshResults:
				refreshRunning = false
				if err != nil && !errors.Is(err, errCDPRefreshSuperseded) {
					fmt.Fprintf(os.Stderr, "browser-session-wrapper: refresh targets after CDP event overflow: %v\n", err)
					connection.Close()
					connected = false
					continue
				}
				for _, event := range connection.drainEventsThrough(connection.targetList.Load()) {
					if err := registry.applyCDPEvent(ctx, connection, event); err != nil {
						fmt.Fprintf(os.Stderr, "browser-session-wrapper: handle CDP event after overflow: %v\n", err)
					}
				}
				registry.notifyCDPUpdate()
			case event := <-connection.events:
				if err := registry.applyCDPEvent(ctx, connection, event); err != nil {
					fmt.Fprintf(os.Stderr, "browser-session-wrapper: handle CDP event: %v\n", err)
				}
			}
		}
		registry.disconnectCDPConnection(ctx, connection)
		connection.Close()
		timer := time.NewTimer(cdpReconnectDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (registry *wrapperTargetRegistry) setCDPConnection(connection *cdpBrowserConnection) {
	registry.cdpMu.Lock()
	registry.cdp = connection
	registry.cdpTargets = make(map[string]cdpTargetWindow)
	registry.cdpTargetSequences = make(map[string]uint64)
	registry.cdpTargetInfoSequences = make(map[string]uint64)
	registry.cdpClosed = make(map[string]uint64)
	registry.cdpEventFloor = 0
	registry.cdpEventEpoch = 0
	registry.cdpTargetsKnown = false
	registry.cdpAwaitRefresh = false
	connection.overflowed.Store(false)
	registry.cdpMu.Unlock()
}

func (registry *wrapperTargetRegistry) disconnectCDPConnection(ctx context.Context, connection *cdpBrowserConnection) {
	registry.cdpMu.Lock()
	if registry.cdp != connection {
		registry.cdpMu.Unlock()
		return
	}
	registry.cdp = nil
	registry.cdpTargets = make(map[string]cdpTargetWindow)
	registry.cdpTargetSequences = make(map[string]uint64)
	registry.cdpTargetInfoSequences = make(map[string]uint64)
	registry.cdpEventFloor = 0
	registry.cdpEventEpoch = 0
	registry.cdpTargetsKnown = false
	registry.cdpAwaitRefresh = false
	registry.mu.Lock()
	var unavailable []wrapperTargetSnapshot
	for targetID, target := range registry.targets {
		if target.State == wrapperTargetClosed || target.State == wrapperTargetUnavailable {
			continue
		}
		target.State = wrapperTargetUnavailable
		registry.targets[targetID] = target
		unavailable = append(unavailable, target)
	}
	registry.mu.Unlock()
	registry.cdpMu.Unlock()

	for _, target := range unavailable {
		go registry.releaseUnavailableTarget(ctx, target)
	}
}

func (registry *wrapperTargetRegistry) notifyCDPUpdate() {
	select {
	case registry.cdpUpdates <- struct{}{}:
	default:
	}
}

func (registry *wrapperTargetRegistry) cleanupContext() context.Context {
	if registry.runtime != nil && registry.runtime.ctx != nil {
		return registry.runtime.ctx
	}
	return context.Background()
}

// recordCDPClosedLocked records a destroy/filter tombstone. It must be called
// with cdpMu held; overflow deliberately invalidates the live cache so the
// next authoritative refresh establishes a new ordering floor.
func (registry *wrapperTargetRegistry) recordCDPClosedLocked(targetID string, sequence uint64) bool {
	if registry.cdpClosed == nil {
		registry.cdpClosed = make(map[string]uint64)
	}
	if _, exists := registry.cdpClosed[targetID]; !exists && len(registry.cdpClosed) >= cdpClosedTargetLimit {
		registry.cdpClosed = make(map[string]uint64)
		registry.cdpTargets = make(map[string]cdpTargetWindow)
		registry.cdpTargetSequences = make(map[string]uint64)
		registry.cdpTargetInfoSequences = make(map[string]uint64)
		registry.cdpTargetsKnown = false
		registry.cdpAwaitRefresh = true
		return true
	}
	registry.cdpClosed[targetID] = sequence
	return false
}

func (registry *wrapperTargetRegistry) releaseUnavailableTarget(ctx context.Context, target wrapperTargetSnapshot) {
	registry.surfaceMu.Lock()
	registry.mu.Lock()
	current, owns := registry.targets[target.TargetID]
	if !owns || current.Generation != target.Generation {
		registry.mu.Unlock()
		registry.surfaceMu.Unlock()
		return
	}
	registry.mu.Unlock()
	registry.runtime.targetUnavailable(target)
	registry.runtime.stopTargetRecordingsGeneration(target.TargetID, target.Generation)
	cleanup := registry.retireTargetOutputLocked(ctx, target)
	registry.surfaceMu.Unlock()
	registry.queueRetiredTargetCleanup(ctx, cleanup)
}

func (registry *wrapperTargetRegistry) refreshCDPTargets(ctx context.Context) error {
	registry.cdpMu.Lock()
	connection := registry.cdp
	registry.cdpMu.Unlock()
	if connection == nil || connection.connection == nil {
		return errors.New("browser CDP connection is unavailable")
	}
	return registry.refreshCDPTargetsWithConnection(ctx, connection)
}

func (registry *wrapperTargetRegistry) refreshCDPTargetsWithConnection(ctx context.Context, connection *cdpBrowserConnection) error {
	registry.cdpRefreshMu.Lock()
	defer registry.cdpRefreshMu.Unlock()
	registry.cdpMu.Lock()
	if registry.cdp != connection {
		registry.cdpMu.Unlock()
		return errors.New("browser CDP connection was replaced")
	}
	eventEpoch := registry.cdpEventEpoch
	registry.cdpMu.Unlock()
	refreshCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var targetResult struct {
		TargetInfos []cdpTargetInfo `json:"targetInfos"`
	}
	refreshFloor, err := connection.callWithSequence(refreshCtx, "Target.getTargets", map[string]any{}, &targetResult)
	if err != nil {
		return fmt.Errorf("list CDP targets: %w", err)
	}
	connection.targetList.Store(refreshFloor)
	targets := make(map[string]cdpTargetWindow, len(targetResult.TargetInfos))
	authoritative := make(map[string]struct{}, len(targetResult.TargetInfos))
	for _, target := range targetResult.TargetInfos {
		if !isUserCDPTarget(target) {
			continue
		}
		authoritative[target.TargetID] = struct{}{}
		targetWindow := cdpTargetWindow{Target: target}
		var window struct {
			WindowID int64 `json:"windowId"`
		}
		if err := connection.call(refreshCtx, "Browser.getWindowForTarget", map[string]any{"targetId": target.TargetID}, &window); err != nil {
			return fmt.Errorf("resolve window for target %q: %w", target.TargetID, err)
		}
		targetWindow.Window = window.WindowID
		if targetWindow.Window <= 0 {
			return fmt.Errorf("target %q returned invalid window id %d", target.TargetID, targetWindow.Window)
		}
		targets[target.TargetID] = targetWindow
	}
	destroyed := connection.destroyedSnapshot()
	registry.cdpMu.Lock()
	if registry.cdp != connection || registry.cdpEventEpoch != eventEpoch {
		registry.cdpMu.Unlock()
		return errCDPRefreshSuperseded
	}
	connection.overflowMu.Lock()
	connection.overflowed.Store(false)
	connection.overflowMu.Unlock()
	for targetID, sequence := range destroyed {
		if _, present := authoritative[targetID]; present {
			connection.clearDestroyed(targetID)
			delete(destroyed, targetID)
			continue
		}
		if sequence != 0 && sequence <= refreshFloor {
			connection.clearDestroyed(targetID)
			delete(destroyed, targetID)
		}
	}
	for targetID := range destroyed {
		delete(targets, targetID)
	}
	for targetID := range registry.cdpClosed {
		if _, pending := destroyed[targetID]; pending {
			continue
		}
		delete(registry.cdpClosed, targetID)
	}
	infoSequences := make(map[string]uint64, len(targets))
	for targetID := range targets {
		infoSequences[targetID] = refreshFloor
	}
	for targetID, sequence := range registry.cdpTargetInfoSequences {
		if sequence > refreshFloor {
			infoSequences[targetID] = sequence
		}
	}
	registry.cdpTargets = targets
	registry.cdpTargetSequences = make(map[string]uint64, len(targets))
	registry.cdpTargetInfoSequences = infoSequences
	for targetID := range targets {
		registry.cdpTargetSequences[targetID] = refreshFloor
	}
	registry.cdpEventFloor = refreshFloor
	registry.cdpTargetsKnown = true
	registry.cdpAwaitRefresh = false
	registry.cdpMu.Unlock()
	return nil
}

func (registry *wrapperTargetRegistry) cdpTargetSnapshot() ([]cdpTargetWindow, error) {
	registry.cdpMu.Lock()
	defer registry.cdpMu.Unlock()
	if !registry.cdpTargetsKnown {
		return nil, errors.New("browser CDP targets are not available")
	}
	if registry.cdpAwaitRefresh {
		return nil, errors.New("browser CDP targets require authoritative refresh")
	}
	if registry.cdp != nil {
		select {
		case <-registry.cdp.done:
			return nil, errors.New("browser CDP connection is closing")
		default:
		}
	}
	var destroyed map[string]uint64
	if registry.cdp != nil {
		destroyed = registry.cdp.destroyedSnapshot()
		for targetID := range destroyed {
			delete(registry.cdpTargets, targetID)
		}
	}
	targets := make([]cdpTargetWindow, 0, len(registry.cdpTargets))
	for _, target := range registry.cdpTargets {
		targets = append(targets, target)
	}
	return targets, nil
}

func (registry *wrapperTargetRegistry) applyCDPEvent(ctx context.Context, connection *cdpBrowserConnection, event cdpEvent) error {
	switch event.Method {
	case "Target.targetCreated", "Target.targetInfoChanged":
		return registry.applyCDPTargetInfoEvent(ctx, connection, event)
	case "Target.targetDestroyed":
		return registry.applyCDPTargetDestroyedEvent(ctx, connection, event)
	default:
		return nil
	}
}

func (registry *wrapperTargetRegistry) applyCDPTargetInfoEvent(ctx context.Context, connection *cdpBrowserConnection, event cdpEvent) error {
	var changed struct {
		TargetInfo cdpTargetInfo `json:"targetInfo"`
	}
	if err := json.Unmarshal(event.Params, &changed); err != nil {
		return fmt.Errorf("decode %s: %w", event.Method, err)
	}
	if changed.TargetInfo.TargetID == "" {
		return fmt.Errorf("%s omitted target id", event.Method)
	}
	if event.Sequence == 0 {
		event.Sequence = connection.sequence.Add(1)
	}
	targetID := changed.TargetInfo.TargetID
	registry.cdpMu.Lock()
	if registry.cdp != connection {
		registry.cdpMu.Unlock()
		return errors.New("browser CDP connection was replaced")
	}
	if connection.overflowed.Load() {
		registry.cdpTargets = make(map[string]cdpTargetWindow)
		registry.cdpTargetSequences = make(map[string]uint64)
		registry.cdpTargetInfoSequences = make(map[string]uint64)
		registry.cdpTargetsKnown = false
		registry.cdpAwaitRefresh = true
		registry.cdpMu.Unlock()
		registry.notifyCDPUpdate()
		return nil
	}
	if event.Sequence != 0 && event.Sequence <= registry.cdpEventFloor {
		registry.cdpMu.Unlock()
		return nil
	}
	if registry.cdpAwaitRefresh {
		registry.cdpMu.Unlock()
		return nil
	}
	if closedAt, closed := registry.cdpClosed[targetID]; closed {
		if event.Method != "Target.targetCreated" || event.Sequence == 0 || event.Sequence <= closedAt {
			registry.cdpMu.Unlock()
			return nil
		}
		delete(registry.cdpClosed, targetID)
	}
	if _, destroyed := connection.destroyedSnapshot()[targetID]; destroyed {
		registry.cdpMu.Unlock()
		return nil
	}
	registry.cdpMu.Unlock()

	if !isUserCDPTarget(changed.TargetInfo) {
		registry.cdpMu.Lock()
		if registry.cdp != connection || registry.cdpAwaitRefresh || (event.Sequence != 0 && event.Sequence <= registry.cdpEventFloor) {
			registry.cdpMu.Unlock()
			return nil
		}
		_, existed := registry.cdpTargets[targetID]
		delete(registry.cdpTargets, targetID)
		delete(registry.cdpTargetSequences, targetID)
		delete(registry.cdpTargetInfoSequences, targetID)
		overflowed := registry.recordCDPClosedLocked(targetID, event.Sequence)
		registry.cdpEventEpoch++
		registry.cdpMu.Unlock()
		if !existed {
			registry.mu.Lock()
			_, existed = registry.targets[targetID]
			registry.mu.Unlock()
		}
		if existed || overflowed {
			registry.notifyCDPUpdate()
		}
		return nil
	}
	if registry.cdpTargetInfoSequences == nil {
		registry.cdpTargetInfoSequences = make(map[string]uint64)
	}
	registry.cdpTargetInfoSequences[targetID] = event.Sequence
	registry.enqueueCDPTargetInfo(ctx, connection, event, changed.TargetInfo)
	return nil
}

func (registry *wrapperTargetRegistry) enqueueCDPTargetInfo(ctx context.Context, connection *cdpBrowserConnection, event cdpEvent, info cdpTargetInfo) {
	work := cdpInfoWork{registry: registry, ctx: ctx, connection: connection, event: event, info: info}
	connection.infoMu.Lock()
	if connection.infoWork == nil {
		connection.infoWork = make(chan cdpInfoWork, cdpInfoWorkLimit)
		connection.infoPending = make(map[string]cdpInfoWork)
		connection.infoQueued = make(map[string]bool)
		connection.infoRunning = make(map[string]bool)
		for i := 0; i < cdpInfoWorkerLimit; i++ {
			go connection.cdpInfoWorker()
		}
	}
	if connection.infoRunning[info.TargetID] || connection.infoQueued[info.TargetID] {
		if _, exists := connection.infoPending[info.TargetID]; !exists && len(connection.infoPending) >= cdpInfoWorkLimit {
			connection.infoMu.Unlock()
			connection.signalInfoOverflow()
			return
		}
		connection.infoPending[info.TargetID] = work
		connection.infoMu.Unlock()
		return
	}
	select {
	case connection.infoWork <- work:
		connection.infoQueued[info.TargetID] = true
		connection.infoMu.Unlock()
	default:
		connection.infoMu.Unlock()
		connection.signalInfoOverflow()
	}
}

func (connection *cdpBrowserConnection) cdpInfoWorker() {
	for {
		select {
		case <-connection.done:
			return
		case work := <-connection.infoWork:
			connection.infoMu.Lock()
			delete(connection.infoQueued, work.info.TargetID)
			connection.infoRunning[work.info.TargetID] = true
			connection.infoMu.Unlock()
			for {
				work.registry.completeCDPTargetInfo(work.ctx, work.connection, work.event, work.info)
				connection.infoMu.Lock()
				next, pending := connection.infoPending[work.info.TargetID]
				if pending {
					delete(connection.infoPending, work.info.TargetID)
					connection.infoMu.Unlock()
					work = next
					continue
				}
				delete(connection.infoRunning, work.info.TargetID)
				connection.infoMu.Unlock()
				break
			}
		}
	}
}

func (connection *cdpBrowserConnection) signalInfoOverflow() {
	connection.overflowed.Store(true)
	select {
	case connection.overflow <- struct{}{}:
	default:
	}
}

func (registry *wrapperTargetRegistry) completeCDPTargetInfo(ctx context.Context, connection *cdpBrowserConnection, event cdpEvent, info cdpTargetInfo) {
	windowCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var window struct {
		WindowID int64 `json:"windowId"`
	}
	windowErr := connection.call(windowCtx, "Browser.getWindowForTarget", map[string]any{"targetId": info.TargetID}, &window)
	if windowErr != nil || window.WindowID <= 0 {
		return
	}
	targetWindow := cdpTargetWindow{Target: info}
	targetWindow.Window = window.WindowID
	registry.cdpMu.Lock()
	if registry.cdp != connection || registry.cdpAwaitRefresh || (event.Sequence != 0 && event.Sequence <= registry.cdpEventFloor) {
		registry.cdpMu.Unlock()
		return
	}
	if closedAt, closed := registry.cdpClosed[info.TargetID]; closed {
		if event.Method != "Target.targetCreated" || event.Sequence == 0 || event.Sequence <= closedAt {
			registry.cdpMu.Unlock()
			return
		}
		delete(registry.cdpClosed, info.TargetID)
	}
	if _, destroyed := connection.destroyedSnapshot()[info.TargetID]; destroyed {
		registry.cdpMu.Unlock()
		return
	}
	if latest := registry.cdpTargetInfoSequences[info.TargetID]; latest == 0 || latest != event.Sequence {
		registry.cdpMu.Unlock()
		return
	}
	if registry.cdpTargets == nil {
		registry.cdpTargets = make(map[string]cdpTargetWindow)
	}
	if registry.cdpTargetSequences == nil {
		registry.cdpTargetSequences = make(map[string]uint64)
	}
	registry.cdpTargets[info.TargetID] = targetWindow
	registry.cdpTargetSequences[info.TargetID] = event.Sequence
	registry.cdpTargetsKnown = true
	registry.cdpEventEpoch++
	registry.cdpMu.Unlock()
	registry.notifyCDPUpdate()
}

func (registry *wrapperTargetRegistry) applyCDPTargetDestroyedEvent(_ context.Context, connection *cdpBrowserConnection, event cdpEvent) error {
	var destroyed struct {
		TargetID string `json:"targetId"`
	}
	if err := json.Unmarshal(event.Params, &destroyed); err != nil {
		return fmt.Errorf("decode target destroyed: %w", err)
	}
	if destroyed.TargetID == "" {
		return errors.New("target destroyed omitted target id")
	}
	registry.cdpMu.Lock()
	if registry.cdp != connection {
		registry.cdpMu.Unlock()
		return errors.New("browser CDP connection was replaced")
	}
	if event.Sequence != 0 && event.Sequence <= registry.cdpEventFloor {
		if _, present := registry.cdpTargets[destroyed.TargetID]; present {
			registry.cdpMu.Unlock()
			connection.clearDestroyed(destroyed.TargetID)
			return nil
		}
		delete(registry.cdpTargets, destroyed.TargetID)
		delete(registry.cdpTargetSequences, destroyed.TargetID)
		delete(registry.cdpTargetInfoSequences, destroyed.TargetID)
		registry.cdpEventEpoch++
		registry.cdpMu.Unlock()
		connection.clearDestroyed(destroyed.TargetID)
		registry.markCDPTargetClosedLocked(destroyed.TargetID)
		return nil
	}
	if registry.cdpAwaitRefresh {
		delete(registry.cdpTargets, destroyed.TargetID)
		delete(registry.cdpTargetSequences, destroyed.TargetID)
		delete(registry.cdpTargetInfoSequences, destroyed.TargetID)
		registry.cdpEventEpoch++
		registry.cdpMu.Unlock()
		connection.clearDestroyed(destroyed.TargetID)
		registry.markCDPTargetClosedLocked(destroyed.TargetID)
		return nil
	}
	_, existed := registry.cdpTargets[destroyed.TargetID]
	delete(registry.cdpTargets, destroyed.TargetID)
	delete(registry.cdpTargetSequences, destroyed.TargetID)
	delete(registry.cdpTargetInfoSequences, destroyed.TargetID)
	registry.cdpEventEpoch++
	overflowed := registry.recordCDPClosedLocked(destroyed.TargetID, event.Sequence)
	registry.cdpMu.Unlock()
	connection.clearDestroyed(destroyed.TargetID)
	if overflowed {
		registry.notifyCDPUpdate()
	}
	if !existed {
		registry.mu.Lock()
		_, existed = registry.targets[destroyed.TargetID]
		registry.mu.Unlock()
	}
	if existed {
		registry.notifyCDPUpdate()
	}
	registry.markCDPTargetClosedLocked(destroyed.TargetID)
	return nil
}

func (registry *wrapperTargetRegistry) markCDPTargetClosedLocked(targetID string) {
	registry.mu.Lock()
	target, exists := registry.targets[targetID]
	if !exists || target.State == wrapperTargetClosed {
		registry.mu.Unlock()
		return
	}
	target.State = wrapperTargetClosed
	registry.targets[targetID] = target
	registry.mu.Unlock()
	go func() {
		registry.mu.Lock()
		current, owns := registry.targets[target.TargetID]
		owns = owns && current.Generation == target.Generation
		registry.mu.Unlock()
		if owns {
			registry.runtime.targetClosed(target)
		} else {
			registry.runtime.stopTargetRecordingsGeneration(target.TargetID, target.Generation)
		}
		registry.deferTargetCleanup(target)
	}()
}

func dialCDPBrowserConnection(ctx context.Context, port int) (*cdpBrowserConnection, error) {
	discoveryCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	webSocketURL, err := discoverCDPWebSocketURL(discoveryCtx, port)
	if err != nil {
		return nil, err
	}
	connection, _, err := websocket.Dial(discoveryCtx, webSocketURL, nil)
	if err != nil {
		return nil, fmt.Errorf("connect browser CDP endpoint: %w", err)
	}
	connection.SetReadLimit(cdpDiscoveryMessageLimit)
	client := &cdpBrowserConnection{
		connection: connection,
		pending:    make(map[int64]chan cdpCallResult),
		destroyed:  make(map[string]uint64),
		done:       make(chan struct{}),
		events:     make(chan cdpEvent, 128),
		overflow:   make(chan struct{}, 1),
	}
	go client.readLoop()
	return client, nil
}

func discoverCDPWebSocketURL(ctx context.Context, port int) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+strconv.Itoa(port)+"/json/version", nil)
	if err != nil {
		return "", err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", fmt.Errorf("discover browser CDP endpoint: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("discover browser CDP endpoint: status %d", response.StatusCode)
	}
	var version struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(response.Body).Decode(&version); err != nil {
		return "", fmt.Errorf("decode browser CDP endpoint: %w", err)
	}
	if strings.TrimSpace(version.WebSocketDebuggerURL) == "" {
		return "", errors.New("browser CDP endpoint omitted webSocketDebuggerUrl")
	}
	return version.WebSocketDebuggerURL, nil
}

func (connection *cdpBrowserConnection) call(ctx context.Context, method string, params any, output any) error {
	_, err := connection.callWithSequence(ctx, method, params, output)
	return err
}

func (connection *cdpBrowserConnection) callWithSequence(ctx context.Context, method string, params any, output any) (uint64, error) {
	select {
	case <-connection.done:
		return 0, connection.closeError()
	default:
	}
	id := connection.nextID.Add(1)
	requestBody, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil {
		return 0, err
	}
	response := make(chan cdpCallResult, 1)
	connection.pendingMu.Lock()
	select {
	case <-connection.done:
		connection.pendingMu.Unlock()
		return 0, connection.closeError()
	default:
		if connection.pending == nil {
			connection.pending = make(map[int64]chan cdpCallResult)
		}
		connection.pending[id] = response
	}
	connection.pendingMu.Unlock()
	connection.writeMu.Lock()
	err = connection.connection.Write(ctx, websocket.MessageText, requestBody)
	connection.writeMu.Unlock()
	if err != nil {
		connection.removePending(id)
		connection.Close()
		return 0, err
	}
	for {
		select {
		case <-ctx.Done():
			connection.removePending(id)
			return 0, ctx.Err()
		case callResult := <-response:
			connection.lastResponse.Store(callResult.sequence)
			if callResult.err != nil {
				return callResult.sequence, callResult.err
			}
			if output == nil || len(callResult.result) == 0 || string(callResult.result) == "null" {
				return callResult.sequence, nil
			}
			return callResult.sequence, json.Unmarshal(callResult.result, output)
		case <-connection.done:
			return 0, connection.closeError()
		}
	}
}

func (connection *cdpBrowserConnection) removePending(id int64) {
	connection.pendingMu.Lock()
	delete(connection.pending, id)
	connection.pendingMu.Unlock()
}

func (connection *cdpBrowserConnection) markDestroyed(targetID string, sequence uint64) {
	connection.overflowMu.Lock()
	defer connection.overflowMu.Unlock()
	connection.destroyedMu.Lock()
	if connection.destroyed == nil {
		connection.destroyed = make(map[string]uint64)
	}
	if _, exists := connection.destroyed[targetID]; !exists && len(connection.destroyed) >= cdpClosedTargetLimit {
		connection.destroyed = make(map[string]uint64)
		connection.overflowed.Store(true)
		select {
		case connection.overflow <- struct{}{}:
		default:
		}
	}
	connection.destroyed[targetID] = sequence
	connection.destroyedMu.Unlock()
}

func (connection *cdpBrowserConnection) destroyedSnapshot() map[string]uint64 {
	connection.destroyedMu.Lock()
	defer connection.destroyedMu.Unlock()
	destroyed := make(map[string]uint64, len(connection.destroyed))
	for targetID, sequence := range connection.destroyed {
		destroyed[targetID] = sequence
	}
	return destroyed
}

func (connection *cdpBrowserConnection) clearDestroyed(targetID string) {
	connection.destroyedMu.Lock()
	delete(connection.destroyed, targetID)
	connection.destroyedMu.Unlock()
}

func (connection *cdpBrowserConnection) closeError() error {
	connection.errMu.Lock()
	defer connection.errMu.Unlock()
	if connection.err == nil {
		return errors.New("browser CDP connection is closed")
	}
	return connection.err
}

func (connection *cdpBrowserConnection) drainEventsThrough(sequence uint64) []cdpEvent {
	var pending []cdpEvent
	for {
		select {
		case event := <-connection.events:
			if event.Sequence > sequence {
				pending = append(pending, event)
			}
		default:
			return pending
		}
	}
}

func (connection *cdpBrowserConnection) readLoop() {
	for {
		_, body, err := connection.connection.Read(context.Background())
		if err != nil {
			connection.shutdown(err)
			return
		}
		var envelope struct {
			ID     int64           `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil {
			connection.shutdown(fmt.Errorf("decode browser CDP message: %w", err))
			return
		}
		sequence := connection.sequence.Add(1)
		if envelope.ID != 0 {
			result := cdpCallResult{sequence: sequence, result: envelope.Result}
			if envelope.Error != nil {
				result.err = fmt.Errorf("CDP command failed (%d): %s", envelope.Error.Code, envelope.Error.Message)
			}
			connection.pendingMu.Lock()
			response := connection.pending[envelope.ID]
			delete(connection.pending, envelope.ID)
			connection.pendingMu.Unlock()
			if response != nil {
				response <- result
			}
			continue
		}
		if envelope.Method == "" {
			continue
		}
		event := cdpEvent{
			Method:   envelope.Method,
			Params:   envelope.Params,
			Sequence: sequence,
		}
		if envelope.Method == "Target.targetDestroyed" {
			var destroyed struct {
				TargetID string `json:"targetId"`
			}
			if err := json.Unmarshal(envelope.Params, &destroyed); err == nil && destroyed.TargetID != "" {
				connection.markDestroyed(destroyed.TargetID, sequence)
			}
		}
		select {
		case connection.events <- event:
		default:
			select {
			case connection.overflow <- struct{}{}:
			default:
			}
		}
	}
}

func (connection *cdpBrowserConnection) shutdown(err error) {
	connection.closeOnce.Do(func() {
		connection.errMu.Lock()
		connection.err = err
		connection.errMu.Unlock()
		connection.pendingMu.Lock()
		pending := connection.pending
		connection.pending = make(map[int64]chan cdpCallResult)
		connection.pendingMu.Unlock()
		for _, response := range pending {
			response <- cdpCallResult{err: err}
		}
		close(connection.done)
	})
}

func (connection *cdpBrowserConnection) Close() {
	_ = connection.connection.CloseNow()
	connection.shutdown(errors.New("browser CDP connection closed"))
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
