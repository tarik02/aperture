package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	liveSessionBrowserCommandTimeout = 5 * time.Second
	liveSessionTargetReadyTimeout    = 15 * time.Second
)

type liveSessionTarget struct {
	ID       string              `json:"id"`
	Type     string              `json:"type"`
	Title    string              `json:"title"`
	URL      string              `json:"url"`
	Loading  bool                `json:"loading"`
	Viewport *compositorViewport `json:"viewport,omitempty"`
}

type liveSessionBrowser struct {
	runtime *wrapperRuntime

	mu     sync.Mutex
	client *liveSessionCDP

	stateMu                      sync.Mutex
	observedClient               *liveSessionCDP
	observedTargets              map[string]string
	targetBySession              map[string]string
	attaching                    map[string]struct{}
	loading                      map[string]bool
	initialOrder                 map[string]int
	initialActiveID              string
	fetchWaiters                 map[string]chan json.RawMessage
	initialSessionStorageScripts map[string]map[string]string
}

func newLiveSessionBrowser(runtime *wrapperRuntime) *liveSessionBrowser {
	return &liveSessionBrowser{
		runtime:                      runtime,
		observedTargets:              make(map[string]string),
		targetBySession:              make(map[string]string),
		attaching:                    make(map[string]struct{}),
		loading:                      make(map[string]bool),
		initialOrder:                 make(map[string]int),
		fetchWaiters:                 make(map[string]chan json.RawMessage),
		initialSessionStorageScripts: make(map[string]map[string]string),
	}
}

func (browser *liveSessionBrowser) targets() ([]liveSessionTarget, error) {
	var result struct {
		TargetInfos []cdpTargetInfo `json:"targetInfos"`
	}
	if err := browser.call("Target.getTargets", map[string]any{}, "", &result); err != nil {
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
	targets := make([]liveSessionTarget, 0, len(result.TargetInfos))
	for _, target := range result.TargetInfos {
		if !isUserCDPTarget(target) {
			continue
		}
		resolved := liveSessionTarget{
			ID:      target.TargetID,
			Type:    target.Type,
			Title:   target.Title,
			URL:     target.URL,
			Loading: browser.targetLoading(target.TargetID),
		}
		if viewport, ok := viewports[target.TargetID]; ok {
			resolved.Viewport = &viewport
		}
		targets = append(targets, resolved)
	}
	browser.stateMu.Lock()
	initialOrder := make(map[string]int, len(browser.initialOrder))
	for targetID, index := range browser.initialOrder {
		initialOrder[targetID] = index
	}
	browser.stateMu.Unlock()
	sort.Slice(targets, func(left, right int) bool {
		leftIndex, leftInitialized := initialOrder[targets[left].ID]
		rightIndex, rightInitialized := initialOrder[targets[right].ID]
		if leftInitialized != rightInitialized {
			return leftInitialized
		}
		if leftInitialized && leftIndex != rightIndex {
			return leftIndex < rightIndex
		}
		return targets[left].ID < targets[right].ID
	})
	return targets, nil
}

func (browser *liveSessionBrowser) firstSelectableTargetID(targets []liveSessionTarget) string {
	browser.runtime.mu.Lock()
	hasTargetRegistry := browser.runtime.targets != nil
	browser.runtime.mu.Unlock()
	browser.stateMu.Lock()
	initialActiveID := browser.initialActiveID
	browser.stateMu.Unlock()
	if initialActiveID != "" {
		for _, target := range targets {
			if target.ID == initialActiveID && (!hasTargetRegistry || target.Viewport != nil) {
				return target.ID
			}
		}
	}
	for _, target := range targets {
		if !hasTargetRegistry || target.Viewport != nil {
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
	var result struct {
		TargetID string `json:"targetId"`
	}
	if err := browser.call("Target.createTarget", map[string]any{"url": rawURL}, "", &result); err != nil {
		return "", err
	}
	if result.TargetID == "" {
		return "", errors.New("browser omitted the created target ID")
	}
	if err := browser.waitUntilTargetReady(result.TargetID); err != nil {
		return "", err
	}
	return result.TargetID, nil
}

func (browser *liveSessionBrowser) createChildTarget(ctx context.Context, openerID string) (string, error) {
	existing, err := browser.targetInfos()
	if err != nil {
		return "", err
	}
	existingIDs := make(map[string]struct{}, len(existing))
	for _, target := range existing {
		existingIDs[target.TargetID] = struct{}{}
	}
	var evaluation struct {
		Result struct {
			Value bool `json:"value"`
		} `json:"result"`
		ExceptionDetails *json.RawMessage `json:"exceptionDetails"`
	}
	if err := browser.withTarget(openerID, func(sessionID string) error {
		return browser.call("Runtime.evaluate", map[string]any{
			"expression":    fmt.Sprintf(`globalThis[Symbol.for(%q)]("about:blank", "_blank") !== null`, initialWindowOpenSymbol),
			"returnByValue": true,
			"userGesture":   true,
		}, sessionID, &evaluation)
	}); err != nil {
		return "", err
	}
	if evaluation.ExceptionDetails != nil || !evaluation.Result.Value {
		return "", errors.New("browser rejected the initial popup target")
	}

	waitCtx, cancel := context.WithTimeout(ctx, liveSessionTargetReadyTimeout)
	defer cancel()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		infos, err := browser.targetInfos()
		if err == nil {
			matches := make([]string, 0, 1)
			for _, target := range infos {
				_, existed := existingIDs[target.TargetID]
				if !existed && target.Type == "page" && target.OpenerID == openerID {
					matches = append(matches, target.TargetID)
				}
			}
			if len(matches) > 1 {
				return "", errors.New("browser created multiple initial popup targets")
			}
			if len(matches) == 1 {
				if err := browser.waitUntilTargetReady(matches[0]); err != nil {
					_ = browser.closeTarget(matches[0])
					return "", err
				}
				return matches[0], nil
			}
		}
		select {
		case <-waitCtx.Done():
			return "", fmt.Errorf("initial popup target did not appear: %w", waitCtx.Err())
		case <-ticker.C:
		}
	}
}

func (browser *liveSessionBrowser) targetInfos() ([]cdpTargetInfo, error) {
	var result struct {
		TargetInfos []cdpTargetInfo `json:"targetInfos"`
	}
	if err := browser.call("Target.getTargets", map[string]any{}, "", &result); err != nil {
		return nil, err
	}
	return result.TargetInfos, nil
}

func (browser *liveSessionBrowser) closeTarget(targetID string) error {
	err := browser.call("Target.closeTarget", map[string]any{"targetId": targetID}, "", nil)
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
	err := browser.withTarget(targetID, func(sessionID string) error {
		return browser.call("Page.navigate", map[string]any{"url": rawURL}, sessionID, nil)
	})
	if err != nil {
		browser.setTargetLoading(targetID, false)
	}
	return err
}

func (browser *liveSessionBrowser) reload(targetID string) error {
	browser.setTargetLoading(targetID, true)
	err := browser.withTarget(targetID, func(sessionID string) error {
		return browser.call("Page.reload", map[string]any{}, sessionID, nil)
	})
	if err != nil {
		browser.setTargetLoading(targetID, false)
	}
	return err
}

func (browser *liveSessionBrowser) stopLoading(targetID string) error {
	return browser.withTarget(targetID, func(sessionID string) error {
		return browser.call("Page.stopLoading", map[string]any{}, sessionID, nil)
	})
}

func (browser *liveSessionBrowser) navigateHistory(targetID string, delta int) error {
	return browser.withTarget(targetID, func(sessionID string) error {
		var history struct {
			CurrentIndex int `json:"currentIndex"`
			Entries      []struct {
				ID int64 `json:"id"`
			} `json:"entries"`
		}
		if err := browser.call("Page.getNavigationHistory", map[string]any{}, sessionID, &history); err != nil {
			return err
		}
		index := history.CurrentIndex + delta
		if index < 0 || index >= len(history.Entries) {
			return nil
		}
		return browser.call("Page.navigateToHistoryEntry", map[string]any{"entryId": history.Entries[index].ID}, sessionID, nil)
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
	return browser.withTarget(targetID, func(sessionID string) error {
		return browser.call("Emulation.setDeviceMetricsOverride", map[string]any{
			"width":             width,
			"height":            height,
			"deviceScaleFactor": deviceScaleFactor,
			"mobile":            false,
		}, sessionID, nil)
	})
}

func (browser *liveSessionBrowser) withTarget(targetID string, action func(string) error) error {
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err := browser.call("Target.attachToTarget", map[string]any{"targetId": targetID, "flatten": true}, "", &attached); err != nil {
		return err
	}
	if attached.SessionID == "" {
		return errors.New("browser omitted the target attachment ID")
	}
	defer func() {
		_ = browser.call("Target.detachFromTarget", map[string]any{"sessionId": attached.SessionID}, "", nil)
	}()
	return action(attached.SessionID)
}

func (browser *liveSessionBrowser) waitForObservedTargetSession(ctx context.Context, targetID string) (string, error) {
	waitCtx, cancel := context.WithTimeout(ctx, liveSessionTargetReadyTimeout)
	defer cancel()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		browser.stateMu.Lock()
		sessionID := browser.observedTargets[targetID]
		browser.stateMu.Unlock()
		if sessionID != "" {
			return sessionID, nil
		}
		select {
		case <-waitCtx.Done():
			return "", errors.New("created browser target did not get a persistent CDP attachment")
		case <-ticker.C:
		}
	}
}

func (browser *liveSessionBrowser) call(method string, params any, sessionID string, result any) error {
	return browser.callWithTimeout(liveSessionBrowserCommandTimeout, method, params, sessionID, result)
}

func (browser *liveSessionBrowser) callWithTimeout(timeout time.Duration, method string, params any, sessionID string, result any) error {
	browser.mu.Lock()
	defer browser.mu.Unlock()
	ctx, cancel := context.WithTimeout(browser.runtime.ctx, timeout)
	defer cancel()
	if browser.client == nil {
		client, err := connectLiveSessionCDP(ctx, browser.runtime.values.CDPPort)
		if err != nil {
			return err
		}
		browser.client = client
		browser.startObserving(client)
		if err := client.call(ctx, "Target.setDiscoverTargets", map[string]any{"discover": true}, "", nil); err != nil {
			browser.stopObserving(client)
			client.close()
			browser.client = nil
			return err
		}
	}
	if err := browser.client.call(ctx, method, params, sessionID, result); err != nil {
		var commandErr *liveSessionCDPCommandError
		if errors.As(err, &commandErr) {
			return err
		}
		browser.stopObserving(browser.client)
		browser.client.close()
		browser.client = nil
		return err
	}
	return nil
}

func (browser *liveSessionBrowser) send(method string, params any, sessionID string) error {
	browser.mu.Lock()
	defer browser.mu.Unlock()
	ctx, cancel := context.WithTimeout(browser.runtime.ctx, liveSessionBrowserCommandTimeout)
	defer cancel()
	if browser.client == nil {
		return errors.New("browser CDP connection is unavailable")
	}
	return browser.client.send(ctx, method, params, sessionID)
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
	clear(browser.fetchWaiters)
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
	switch event.Method {
	case "Target.targetCreated", "Target.targetInfoChanged":
		var params struct {
			TargetInfo cdpTargetInfo `json:"targetInfo"`
		}
		if json.Unmarshal(event.Params, &params) == nil && isUserCDPTarget(params.TargetInfo) {
			go browser.observeTarget(client, params.TargetInfo.TargetID)
		}
	case "Target.targetDestroyed":
		var params struct {
			TargetID string `json:"targetId"`
		}
		if json.Unmarshal(event.Params, &params) == nil {
			browser.removeObservedTarget(params.TargetID)
		}
	case "Target.detachedFromTarget":
		var params struct {
			SessionID string `json:"sessionId"`
		}
		if json.Unmarshal(event.Params, &params) == nil {
			browser.removeObservedSession(params.SessionID)
		}
	case "Page.frameStartedLoading":
		browser.setSessionLoading(event.SessionID, true)
	case "Page.frameStoppedLoading", "Page.loadEventFired", "Page.navigatedWithinDocument":
		browser.setSessionLoading(event.SessionID, false)
	case "Page.frameNavigated":
		browser.setSessionLoading(event.SessionID, false)
		browser.restoreInitialFrameSessionStorage(event)
	case "Fetch.requestPaused":
		browser.stateMu.Lock()
		waiter := browser.fetchWaiters[event.SessionID]
		browser.stateMu.Unlock()
		if waiter != nil {
			select {
			case waiter <- event.Params:
			default:
			}
		}
	}
}

func (browser *liveSessionBrowser) registerFetchWaiter(sessionID string) (<-chan json.RawMessage, func()) {
	waiter := make(chan json.RawMessage, 1)
	browser.stateMu.Lock()
	browser.fetchWaiters[sessionID] = waiter
	browser.stateMu.Unlock()
	return waiter, func() {
		browser.stateMu.Lock()
		delete(browser.fetchWaiters, sessionID)
		browser.stateMu.Unlock()
	}
}

func (browser *liveSessionBrowser) registerInitialSessionStorageScripts(targetID string, scripts map[string]string) {
	if len(scripts) == 0 {
		return
	}
	browser.stateMu.Lock()
	browser.initialSessionStorageScripts[targetID] = scripts
	browser.stateMu.Unlock()
}

func (browser *liveSessionBrowser) restoreInitialFrameSessionStorage(event liveSessionCDPEvent) {
	var params struct {
		Frame struct {
			URL string `json:"url"`
		} `json:"frame"`
	}
	if json.Unmarshal(event.Params, &params) != nil {
		return
	}
	parsed, err := url.Parse(params.Frame.URL)
	if err != nil {
		return
	}
	origin, err := canonicalHTTPOrigin(parsed.Scheme + "://" + parsed.Host)
	if err != nil {
		return
	}

	browser.stateMu.Lock()
	targetID := browser.targetBySession[event.SessionID]
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
		err := browser.call("Page.removeScriptToEvaluateOnNewDocument", map[string]any{
			"identifier": identifier,
		}, event.SessionID, nil)
		if err == nil {
			return
		}
		browser.stateMu.Lock()
		if browser.initialSessionStorageScripts[targetID] == nil {
			browser.initialSessionStorageScripts[targetID] = make(map[string]string)
		}
		browser.initialSessionStorageScripts[targetID][origin] = identifier
		browser.stateMu.Unlock()
	}()
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
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	err := client.call(ctx, "Target.attachToTarget", map[string]any{
		"targetId": targetID,
		"flatten":  true,
	}, "", &attached)
	if err == nil && attached.SessionID != "" {
		err = client.call(ctx, "Page.enable", map[string]any{}, attached.SessionID, nil)
	}

	browser.stateMu.Lock()
	delete(browser.attaching, targetID)
	current := browser.observedClient == client
	if current && err == nil && attached.SessionID != "" && browser.observedTargets[targetID] == "" {
		browser.observedTargets[targetID] = attached.SessionID
		browser.targetBySession[attached.SessionID] = targetID
		browser.stateMu.Unlock()
		return
	}
	browser.stateMu.Unlock()
	if attached.SessionID != "" {
		_ = client.call(ctx, "Target.detachFromTarget", map[string]any{"sessionId": attached.SessionID}, "", nil)
	}
}

func (browser *liveSessionBrowser) removeObservedTarget(targetID string) {
	browser.stateMu.Lock()
	sessionID := browser.observedTargets[targetID]
	delete(browser.observedTargets, targetID)
	delete(browser.attaching, targetID)
	delete(browser.loading, targetID)
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
