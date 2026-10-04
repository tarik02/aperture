package browser

import (
	"context"
	"errors"
	"maps"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/emulation"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/target"
)

const (
	liveSessionBrowserCommandTimeout = 5 * time.Second
	liveSessionTargetReadyTimeout    = 15 * time.Second
)

type liveSessionTarget struct {
	ID           string              `json:"id"`
	Type         string              `json:"type"`
	Title        string              `json:"title"`
	URL          string              `json:"url"`
	Loading      bool                `json:"loading"`
	CanGoBack    *bool               `json:"canGoBack,omitempty"`
	CanGoForward *bool               `json:"canGoForward,omitempty"`
	Viewport     *compositorViewport `json:"viewport,omitempty"`
}

type liveSessionTargetHistory struct {
	canGoBack    bool
	canGoForward bool
}

type liveSessionBrowser struct {
	runtime *wrapperRuntime

	mu     sync.Mutex
	client *liveSessionCDP

	stateMu           sync.Mutex
	observedClient    *liveSessionCDP
	observedTargets   map[string]string
	targetBySession   map[string]string
	attaching         map[string]struct{}
	loading           map[string]bool
	history           map[string]liveSessionTargetHistory
	historyGeneration map[string]uint64
	initialOrder      map[string]int
	// CDP target IDs are random, so preserve discovery order for tabs created after restore.
	firstSeen                    map[string]uint64
	nextFirstSeen                uint64
	initialActiveID              string
	initialSessionStorageScripts map[string]map[string]string
}

func newLiveSessionBrowser(runtime *wrapperRuntime) *liveSessionBrowser {
	return &liveSessionBrowser{
		runtime:                      runtime,
		observedTargets:              make(map[string]string),
		targetBySession:              make(map[string]string),
		attaching:                    make(map[string]struct{}),
		loading:                      make(map[string]bool),
		history:                      make(map[string]liveSessionTargetHistory),
		historyGeneration:            make(map[string]uint64),
		initialOrder:                 make(map[string]int),
		firstSeen:                    make(map[string]uint64),
		initialSessionStorageScripts: make(map[string]map[string]string),
	}
}

func (browser *liveSessionBrowser) targets() ([]liveSessionTarget, error) {
	var targetInfos []*target.Info
	if err := browser.execute("", func(ctx context.Context) error {
		var err error
		targetInfos, err = target.GetTargets().Do(ctx)
		return err
	}); err != nil {
		return nil, err
	}
	browser.runtime.mu.Lock()
	registry := browser.runtime.targets
	browser.runtime.mu.Unlock()
	viewports := make(map[string]compositorViewport)
	if registry != nil {
		for _, target := range registry.snapshots() {
			if target.State == wrapperTargetReady {
				viewports[target.TargetID] = target.Viewport
			}
		}
	}
	targets := make([]liveSessionTarget, 0, len(targetInfos))
	for _, targetInfo := range targetInfos {
		if !isUserCDPTarget(targetInfo) {
			continue
		}
		resolved := liveSessionTarget{
			ID:      string(targetInfo.TargetID),
			Type:    targetInfo.Type,
			Title:   targetInfo.Title,
			URL:     targetInfo.URL,
			Loading: browser.targetLoading(string(targetInfo.TargetID)),
		}
		if history, ok := browser.targetHistory(string(targetInfo.TargetID)); ok {
			resolved.CanGoBack = &history.canGoBack
			resolved.CanGoForward = &history.canGoForward
		}
		if viewport, ok := viewports[string(targetInfo.TargetID)]; ok {
			resolved.Viewport = &viewport
		}
		targets = append(targets, resolved)
	}
	browser.stateMu.Lock()
	initialOrder := maps.Clone(browser.initialOrder)
	firstSeen := browser.recordFirstSeenLocked(targets)
	browser.stateMu.Unlock()
	// Restored targets keep their requested order ahead of any others, which follow in the order
	// they appeared, so a new tab lands at the end.
	sort.Slice(targets, func(left, right int) bool {
		leftIndex, leftInitialized := initialOrder[targets[left].ID]
		rightIndex, rightInitialized := initialOrder[targets[right].ID]
		if leftInitialized != rightInitialized {
			return leftInitialized
		}
		if leftInitialized && leftIndex != rightIndex {
			return leftIndex < rightIndex
		}
		if firstSeen[targets[left].ID] != firstSeen[targets[right].ID] {
			return firstSeen[targets[left].ID] < firstSeen[targets[right].ID]
		}
		return targets[left].ID < targets[right].ID
	})
	return targets, nil
}

func (browser *liveSessionBrowser) recordFirstSeenLocked(targets []liveSessionTarget) map[string]uint64 {
	present := make(map[string]struct{}, len(targets))
	for _, target := range targets {
		present[target.ID] = struct{}{}
		if _, seen := browser.firstSeen[target.ID]; !seen {
			browser.nextFirstSeen++
			browser.firstSeen[target.ID] = browser.nextFirstSeen
		}
	}
	for targetID := range browser.firstSeen {
		if _, ok := present[targetID]; !ok {
			delete(browser.firstSeen, targetID)
		}
	}
	return maps.Clone(browser.firstSeen)
}

func (browser *liveSessionBrowser) firstSelectableTargetID(targets []liveSessionTarget) string {
	browser.runtime.mu.Lock()
	hasTargetRegistry := browser.runtime.targets != nil
	browser.runtime.mu.Unlock()
	browser.stateMu.Lock()
	initialActiveID := browser.initialActiveID
	browser.stateMu.Unlock()
	selectable := func(target liveSessionTarget) bool {
		return !hasTargetRegistry || target.Viewport != nil
	}
	for _, target := range targets {
		if target.ID == initialActiveID && selectable(target) {
			return target.ID
		}
	}
	for _, target := range targets {
		if selectable(target) {
			return target.ID
		}
	}
	return ""
}

func (browser *liveSessionBrowser) setInitialTargetOrder(targetIDs []string, activeIndex int) {
	browser.stateMu.Lock()
	defer browser.stateMu.Unlock()
	clear(browser.initialOrder)
	for index, targetID := range targetIDs {
		browser.initialOrder[targetID] = index
	}
	browser.initialActiveID = ""
	if activeIndex >= 0 && activeIndex < len(targetIDs) {
		browser.initialActiveID = targetIDs[activeIndex]
	}
}

func (browser *liveSessionBrowser) createTarget(rawURL string) (string, error) {
	if strings.TrimSpace(rawURL) == "" {
		rawURL = "about:blank"
	}
	var targetID target.ID
	if err := browser.execute("", func(ctx context.Context) error {
		var err error
		targetID, err = target.CreateTarget(rawURL).Do(ctx)
		return err
	}); err != nil {
		return "", err
	}
	if targetID == "" {
		return "", errors.New("browser omitted the created target ID")
	}
	if err := browser.waitUntilTargetReady(string(targetID)); err != nil {
		return "", err
	}
	return string(targetID), nil
}

func (browser *liveSessionBrowser) closeTarget(targetID string) error {
	err := browser.execute("", func(ctx context.Context) error {
		return target.CloseTarget(target.ID(targetID)).Do(ctx)
	})
	if err != nil {
		return err
	}
	browser.removeObservedTarget(targetID)
	return browser.waitUntilTargetClosed(targetID)
}

func (browser *liveSessionBrowser) waitUntilTargetReady(targetID string) error {
	browser.runtime.mu.Lock()
	registry := browser.runtime.targets
	browser.runtime.mu.Unlock()
	if registry == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(browser.runtime.ctx, liveSessionTargetReadyTimeout)
	defer cancel()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, ready := registry.readyTarget(targetID); ready {
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.New("created browser target did not become ready")
		case <-ticker.C:
		}
	}
}

func (browser *liveSessionBrowser) waitUntilStartupTargetReady(ctx context.Context) error {
	browser.runtime.mu.Lock()
	registry := browser.runtime.targets
	browser.runtime.mu.Unlock()
	if registry == nil {
		return nil
	}
	waitCtx, cancel := context.WithTimeout(ctx, liveSessionTargetReadyTimeout)
	defer cancel()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		for _, target := range registry.snapshots() {
			if target.State == wrapperTargetReady {
				return nil
			}
		}
		select {
		case <-waitCtx.Done():
			return errors.New("startup browser target did not become ready")
		case <-ticker.C:
		}
	}
}

func (browser *liveSessionBrowser) waitUntilTargetClosed(targetID string) error {
	ctx, cancel := context.WithTimeout(browser.runtime.ctx, liveSessionBrowserCommandTimeout)
	defer cancel()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		targets, err := browser.targets()
		if err != nil {
			return err
		}
		found := false
		for _, target := range targets {
			if target.ID == targetID {
				found = true
				break
			}
		}
		if !found {
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.New("browser target did not close")
		case <-ticker.C:
		}
	}
}

func (browser *liveSessionBrowser) navigate(targetID, rawURL string) error {
	browser.setTargetLoading(targetID, true)
	err := browser.withTarget(targetID, func(ctx context.Context) error {
		_, _, _, _, err := page.Navigate(rawURL).Do(ctx)
		return err
	})
	if err != nil {
		browser.setTargetLoading(targetID, false)
	}
	return err
}

func (browser *liveSessionBrowser) reload(targetID string) error {
	browser.setTargetLoading(targetID, true)
	err := browser.withTarget(targetID, func(ctx context.Context) error {
		return page.Reload().Do(ctx)
	})
	if err != nil {
		browser.setTargetLoading(targetID, false)
	}
	return err
}

func (browser *liveSessionBrowser) stopLoading(targetID string) error {
	return browser.withTarget(targetID, func(ctx context.Context) error {
		return page.StopLoading().Do(ctx)
	})
}

func (browser *liveSessionBrowser) navigateHistory(targetID string, delta int) error {
	return browser.withTarget(targetID, func(ctx context.Context) error {
		currentIndex, entries, err := page.GetNavigationHistory().Do(ctx)
		if err != nil {
			return err
		}
		index := currentIndex + int64(delta)
		if index < 0 || index >= int64(len(entries)) {
			browser.setTargetHistory(targetID, browser.nextHistoryGeneration(targetID), currentIndex, len(entries))
			return nil
		}
		if err := page.NavigateToHistoryEntry(entries[index].ID).Do(ctx); err != nil {
			return err
		}
		browser.setTargetHistory(targetID, browser.nextHistoryGeneration(targetID), index, len(entries))
		return nil
	})
}

func (browser *liveSessionBrowser) setViewport(targetID string, width, height int, deviceScaleFactor float64) error {
	if width <= 0 || height <= 0 || deviceScaleFactor <= 0 {
		return errors.New("viewport is invalid")
	}
	browser.runtime.mu.Lock()
	registry := browser.runtime.targets
	browser.runtime.mu.Unlock()
	if registry != nil {
		ctx, cancel := context.WithTimeout(browser.runtime.ctx, liveSessionBrowserCommandTimeout)
		defer cancel()
		_, err := registry.resizeTarget(ctx, targetID, width, height, deviceScaleFactor)
		return err
	}
	return browser.withTarget(targetID, func(ctx context.Context) error {
		return emulation.SetDeviceMetricsOverride(int64(width), int64(height), deviceScaleFactor, false).Do(ctx)
	})
}

func (browser *liveSessionBrowser) withTarget(targetID string, action func(context.Context) error) error {
	var sessionID target.SessionID
	if err := browser.execute("", func(ctx context.Context) error {
		var err error
		sessionID, err = target.AttachToTarget(target.ID(targetID)).WithFlatten(true).Do(ctx)
		return err
	}); err != nil {
		return err
	}
	if sessionID == "" {
		return errors.New("browser omitted the target attachment ID")
	}
	defer func() {
		_ = browser.execute("", func(ctx context.Context) error {
			return target.DetachFromTarget().WithSessionID(sessionID).Do(ctx)
		})
	}()
	return browser.execute(sessionID, action)
}

func (browser *liveSessionBrowser) waitForObservedTargetSession(ctx context.Context, targetID string) (target.SessionID, error) {
	waitCtx, cancel := context.WithTimeout(ctx, liveSessionTargetReadyTimeout)
	defer cancel()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		browser.stateMu.Lock()
		sessionID := browser.observedTargets[targetID]
		browser.stateMu.Unlock()
		if sessionID != "" {
			return target.SessionID(sessionID), nil
		}
		select {
		case <-waitCtx.Done():
			return "", errors.New("created browser target did not get a persistent CDP attachment")
		case <-ticker.C:
		}
	}
}

func (browser *liveSessionBrowser) execute(sessionID target.SessionID, action func(context.Context) error) error {
	browser.mu.Lock()
	defer browser.mu.Unlock()
	ctx, cancel := context.WithTimeout(browser.runtime.ctx, liveSessionBrowserCommandTimeout)
	defer cancel()
	if browser.client == nil {
		client, err := connectLiveSessionCDP(ctx, browser.runtime.values.CDPPort)
		if err != nil {
			return err
		}
		browser.client = client
		browser.startObserving(client)
		if err := target.SetDiscoverTargets(true).Do(client.executorContext(ctx, "")); err != nil {
			browser.stopObserving(client)
			client.close()
			browser.client = nil
			return err
		}
	}
	if err := action(browser.client.executorContext(ctx, sessionID)); err != nil {
		browser.stopObserving(browser.client)
		browser.client.close()
		browser.client = nil
		return err
	}
	return nil
}

func (browser *liveSessionBrowser) close() {
	browser.mu.Lock()
	defer browser.mu.Unlock()
	if browser.client != nil {
		browser.stopObserving(browser.client)
		browser.client.close()
		browser.client = nil
	}
}

func (browser *liveSessionBrowser) startObserving(client *liveSessionCDP) {
	browser.stateMu.Lock()
	browser.observedClient = client
	clear(browser.observedTargets)
	clear(browser.targetBySession)
	clear(browser.attaching)
	clear(browser.loading)
	clear(browser.history)
	clear(browser.historyGeneration)
	browser.stateMu.Unlock()
	go browser.observe(client)
}

func (browser *liveSessionBrowser) stopObserving(client *liveSessionCDP) {
	browser.stateMu.Lock()
	defer browser.stateMu.Unlock()
	if browser.observedClient != client {
		return
	}
	browser.observedClient = nil
	clear(browser.observedTargets)
	clear(browser.targetBySession)
	clear(browser.attaching)
	clear(browser.loading)
	clear(browser.history)
	clear(browser.historyGeneration)
}

func (browser *liveSessionBrowser) observe(client *liveSessionCDP) {
	defer browser.stopObserving(client)
	for {
		select {
		case <-client.done:
			return
		case event := <-client.events:
			browser.observeEvent(client, event)
		}
	}
}

func (browser *liveSessionBrowser) observeEvent(client *liveSessionCDP, event liveSessionCDPEvent) {
	switch value := event.Value.(type) {
	case *target.EventTargetCreated:
		if isUserCDPTarget(value.TargetInfo) {
			go browser.observeTarget(client, string(value.TargetInfo.TargetID))
		}
	case *target.EventTargetInfoChanged:
		if isUserCDPTarget(value.TargetInfo) {
			go browser.observeTarget(client, string(value.TargetInfo.TargetID))
		}
	case *target.EventTargetDestroyed:
		browser.removeObservedTarget(string(value.TargetID))
	case *target.EventDetachedFromTarget:
		browser.removeObservedSession(string(value.SessionID))
	case *page.EventFrameStartedLoading:
		browser.setSessionLoading(string(event.SessionID), true)
	case *page.EventFrameStoppedLoading, *page.EventLoadEventFired:
		browser.setSessionLoading(string(event.SessionID), false)
	case *page.EventNavigatedWithinDocument:
		browser.setSessionLoading(string(event.SessionID), false)
		// Subframe same-document navigations can add entries to the tab's joint session history too.
		browser.refreshSessionHistory(client, event.SessionID)
	case *page.EventFrameNavigated:
		browser.setSessionLoading(string(event.SessionID), false)
		browser.releaseInitialSessionStorageFrame(event.SessionID, value.Frame)
		if value.Frame != nil && value.Frame.ParentID == "" {
			browser.refreshSessionHistory(client, event.SessionID)
		}
	}
}

// installInitialSessionStorageScripts takes over session storage preload scripts
// from the restore worker for origins a restored target has not loaded yet.
// Each script is removed once a frame first navigates to its origin.
func (browser *liveSessionBrowser) installInitialSessionStorageScripts(ctx context.Context, targetID string, sources map[string]string) error {
	if len(sources) == 0 {
		return nil
	}
	// Make sure the persistent CDP client is connected.
	if err := browser.execute("", func(context.Context) error { return nil }); err != nil {
		return err
	}
	browser.mu.Lock()
	client := browser.client
	browser.mu.Unlock()
	if client == nil {
		return errors.New("browser CDP connection closed before session storage was installed")
	}
	browser.observeTarget(client, targetID)
	sessionID, err := browser.waitForObservedTargetSession(ctx, targetID)
	if err != nil {
		return err
	}
	for origin, source := range sources {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := browser.execute(sessionID, func(callCtx context.Context) error {
			identifier, err := page.AddScriptToEvaluateOnNewDocument(source).Do(callCtx)
			if err != nil {
				return err
			}
			if identifier == "" {
				return errors.New("browser omitted the session storage preload script identifier")
			}
			browser.trackInitialSessionStorageScript(targetID, origin, string(identifier))
			return nil
		})
		if err != nil {
			return err
		}
	}

	// An origin may have loaded after the worker reported it as pending but before the
	// scripts above were registered; its navigation event then found nothing to release.
	var frames *page.FrameTree
	if err := browser.execute(sessionID, func(ctx context.Context) error {
		var err error
		frames, err = page.GetFrameTree().Do(ctx)
		return err
	}); err != nil {
		return err
	}
	for _, frame := range flattenFrames(frames) {
		browser.releaseInitialSessionStorageFrame(sessionID, frame)
	}
	return nil
}

func flattenFrames(tree *page.FrameTree) []*cdp.Frame {
	if tree == nil {
		return nil
	}
	frames := []*cdp.Frame{tree.Frame}
	for _, child := range tree.ChildFrames {
		frames = append(frames, flattenFrames(child)...)
	}
	return frames
}

// releaseInitialSessionStorageFrame removes a target's session storage preload
// script once a frame has loaded its origin, so later navigations keep page-written data.
func (browser *liveSessionBrowser) releaseInitialSessionStorageFrame(sessionID target.SessionID, frame *cdp.Frame) {
	if frame == nil {
		return
	}
	parsed, err := url.Parse(frame.URL)
	if err != nil {
		return
	}
	origin, err := canonicalHTTPOrigin(parsed.Scheme + "://" + parsed.Host)
	if err != nil {
		return
	}

	browser.stateMu.Lock()
	targetID := browser.targetBySession[string(sessionID)]
	scripts := browser.initialSessionStorageScripts[targetID]
	identifier := scripts[origin]
	if identifier != "" {
		delete(scripts, origin)
		if len(scripts) == 0 {
			delete(browser.initialSessionStorageScripts, targetID)
		}
	}
	browser.stateMu.Unlock()
	if identifier == "" {
		return
	}
	go func() {
		err := browser.execute(sessionID, func(ctx context.Context) error {
			return page.RemoveScriptToEvaluateOnNewDocument(page.ScriptIdentifier(identifier)).Do(ctx)
		})
		if err != nil {
			browser.trackInitialSessionStorageScript(targetID, origin, identifier)
		}
	}()
}

func (browser *liveSessionBrowser) trackInitialSessionStorageScript(targetID, origin, identifier string) {
	browser.stateMu.Lock()
	defer browser.stateMu.Unlock()
	if browser.initialSessionStorageScripts[targetID] == nil {
		browser.initialSessionStorageScripts[targetID] = make(map[string]string)
	}
	browser.initialSessionStorageScripts[targetID][origin] = identifier
}

func (browser *liveSessionBrowser) observeTarget(client *liveSessionCDP, targetID string) {
	if strings.TrimSpace(targetID) == "" {
		return
	}
	browser.stateMu.Lock()
	if browser.observedClient != client || browser.observedTargets[targetID] != "" {
		browser.stateMu.Unlock()
		return
	}
	if _, exists := browser.attaching[targetID]; exists {
		browser.stateMu.Unlock()
		return
	}
	browser.attaching[targetID] = struct{}{}
	browser.stateMu.Unlock()

	ctx, cancel := context.WithTimeout(browser.runtime.ctx, liveSessionBrowserCommandTimeout)
	defer cancel()
	sessionID, err := target.AttachToTarget(target.ID(targetID)).WithFlatten(true).Do(client.executorContext(ctx, ""))
	if err == nil && sessionID != "" {
		err = page.Enable().Do(client.executorContext(ctx, sessionID))
	}

	browser.stateMu.Lock()
	delete(browser.attaching, targetID)
	current := browser.observedClient == client
	if current && err == nil && sessionID != "" && browser.observedTargets[targetID] == "" {
		browser.observedTargets[targetID] = string(sessionID)
		browser.targetBySession[string(sessionID)] = targetID
		browser.stateMu.Unlock()
		browser.refreshSessionHistory(client, sessionID)
		return
	}
	browser.stateMu.Unlock()
	if sessionID != "" {
		_ = target.DetachFromTarget().WithSessionID(sessionID).Do(client.executorContext(ctx, ""))
	}
}

func (browser *liveSessionBrowser) removeObservedTarget(targetID string) {
	browser.stateMu.Lock()
	sessionID := browser.observedTargets[targetID]
	delete(browser.observedTargets, targetID)
	delete(browser.attaching, targetID)
	delete(browser.loading, targetID)
	delete(browser.history, targetID)
	delete(browser.historyGeneration, targetID)
	delete(browser.initialSessionStorageScripts, targetID)
	if sessionID != "" {
		delete(browser.targetBySession, sessionID)
	}
	browser.stateMu.Unlock()
}

func (browser *liveSessionBrowser) removeObservedSession(sessionID string) {
	browser.stateMu.Lock()
	targetID := browser.targetBySession[sessionID]
	delete(browser.targetBySession, sessionID)
	if targetID != "" && browser.observedTargets[targetID] == sessionID {
		delete(browser.observedTargets, targetID)
	}
	browser.stateMu.Unlock()
}

func (browser *liveSessionBrowser) setSessionLoading(sessionID string, loading bool) {
	browser.stateMu.Lock()
	targetID := browser.targetBySession[sessionID]
	if targetID != "" {
		browser.loading[targetID] = loading
	}
	browser.stateMu.Unlock()
}

func (browser *liveSessionBrowser) setTargetLoading(targetID string, loading bool) {
	browser.stateMu.Lock()
	if targetID != "" {
		browser.loading[targetID] = loading
	}
	browser.stateMu.Unlock()
}

func (browser *liveSessionBrowser) targetLoading(targetID string) bool {
	browser.stateMu.Lock()
	defer browser.stateMu.Unlock()
	return browser.loading[targetID]
}

// refreshSessionHistory reads an observed target's navigation history in the background,
// because it is called from the event loop that also delivers the command's response.
func (browser *liveSessionBrowser) refreshSessionHistory(client *liveSessionCDP, sessionID target.SessionID) {
	browser.stateMu.Lock()
	targetID := browser.targetBySession[string(sessionID)]
	if browser.observedClient != client || targetID == "" {
		browser.stateMu.Unlock()
		return
	}
	browser.historyGeneration[targetID]++
	generation := browser.historyGeneration[targetID]
	browser.stateMu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(browser.runtime.ctx, liveSessionBrowserCommandTimeout)
		defer cancel()
		currentIndex, entries, err := page.GetNavigationHistory().Do(client.executorContext(ctx, sessionID))
		if err != nil {
			return
		}
		browser.setTargetHistory(targetID, generation, currentIndex, len(entries))
	}()
}

func (browser *liveSessionBrowser) nextHistoryGeneration(targetID string) uint64 {
	browser.stateMu.Lock()
	defer browser.stateMu.Unlock()
	browser.historyGeneration[targetID]++
	return browser.historyGeneration[targetID]
}

// setTargetHistory drops results from superseded reads, which can finish after newer ones.
func (browser *liveSessionBrowser) setTargetHistory(targetID string, generation uint64, currentIndex int64, entryCount int) {
	browser.stateMu.Lock()
	defer browser.stateMu.Unlock()
	if browser.historyGeneration[targetID] != generation {
		return
	}
	browser.history[targetID] = liveSessionTargetHistory{
		canGoBack:    currentIndex > 0,
		canGoForward: currentIndex+1 < int64(entryCount),
	}
}

func (browser *liveSessionBrowser) targetHistory(targetID string) (liveSessionTargetHistory, bool) {
	browser.stateMu.Lock()
	defer browser.stateMu.Unlock()
	history, ok := browser.history[targetID]
	return history, ok
}
