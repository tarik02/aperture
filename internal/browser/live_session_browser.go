package browser

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/emulation"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/target"
)

const liveSessionBrowserCommandTimeout = 5 * time.Second

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

	stateMu         sync.Mutex
	observedClient  *liveSessionCDP
	observedTargets map[string]string
	targetBySession map[string]string
	attaching       map[string]struct{}
	loading         map[string]bool
}

func newLiveSessionBrowser(runtime *wrapperRuntime) *liveSessionBrowser {
	return &liveSessionBrowser{
		runtime:         runtime,
		observedTargets: make(map[string]string),
		targetBySession: make(map[string]string),
		attaching:       make(map[string]struct{}),
		loading:         make(map[string]bool),
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
		if viewport, ok := viewports[string(targetInfo.TargetID)]; ok {
			resolved.Viewport = &viewport
		}
		targets = append(targets, resolved)
	}
	sort.Slice(targets, func(left, right int) bool {
		return targets[left].ID < targets[right].ID
	})
	return targets, nil
}

func (browser *liveSessionBrowser) firstSelectableTargetID(targets []liveSessionTarget) string {
	browser.runtime.mu.Lock()
	hasTargetRegistry := browser.runtime.targets != nil
	browser.runtime.mu.Unlock()
	for _, target := range targets {
		if !hasTargetRegistry || target.Viewport != nil {
			return target.ID
		}
	}
	return ""
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
	ctx, cancel := context.WithTimeout(browser.runtime.ctx, liveSessionBrowserCommandTimeout)
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
			return nil
		}
		return page.NavigateToHistoryEntry(entries[index].ID).Do(ctx)
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
	case *page.EventFrameStoppedLoading, *page.EventLoadEventFired, *page.EventFrameNavigated, *page.EventNavigatedWithinDocument:
		browser.setSessionLoading(string(event.SessionID), false)
	}
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
