package browser

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/chromedp/cdproto/target"
)

const (
	targetWatchRetryDelay   = time.Second
	lastTabReplacementGrace = 2 * time.Second
)

// watchBrowserTargets logs tab crashes, which Chromium itself reports only as an
// internal reason code. With reopenLastTab, Chromium runs with --keep-alive-for-test
// and this opens a blank tab once the last one closes, so the session keeps a page
// to drive and show.
func watchBrowserTargets(ctx context.Context, port int, reopenLastTab bool) {
	for ctx.Err() == nil {
		if err := watchBrowserTargetsOnce(ctx, port, reopenLastTab); err != nil && ctx.Err() == nil {
			fmt.Fprintf(os.Stderr, "browser-session-wrapper: watch browser targets: %v\n", err)
		}
		timer := time.NewTimer(targetWatchRetryDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

// watchBrowserTargetsOnce follows targets until the CDP connection ends. A
// browser that is not listening yet or has exited is not an error: the caller
// reconnects.
func watchBrowserTargetsOnce(ctx context.Context, port int, reopenLastTab bool) error {
	connectCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	client, err := connectLiveSessionCDP(connectCtx, port)
	cancel()
	if err != nil {
		return nil
	}
	defer client.close()
	discoverCtx, cancel := context.WithTimeout(ctx, liveSessionBrowserCommandTimeout)
	err = target.SetDiscoverTargets(true).Do(client.executorContext(discoverCtx, ""))
	cancel()
	if err != nil {
		return fmt.Errorf("discover targets: %w", err)
	}

	pages := make(map[target.ID]string)
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-client.done:
			return nil
		case event := <-client.events:
			switch value := event.Value.(type) {
			case *target.EventTargetCreated:
				trackUserPage(pages, value.TargetInfo)
			case *target.EventTargetInfoChanged:
				trackUserPage(pages, value.TargetInfo)
			case *target.EventTargetCrashed:
				url, known := pages[value.TargetID]
				if !known {
					url = "unknown URL"
				}
				fmt.Fprintf(
					os.Stderr,
					"browser-session-wrapper: tab %s (%s) crashed: status %s, error code %d\n",
					value.TargetID, url, value.Status, value.ErrorCode,
				)
			case *target.EventTargetDestroyed:
				if _, wasPage := pages[value.TargetID]; !wasPage {
					continue
				}
				delete(pages, value.TargetID)
				if reopenLastTab && len(pages) == 0 {
					go openBlankTab(ctx, client)
				}
			}
		}
	}
}

func trackUserPage(pages map[target.ID]string, info *target.Info) {
	if isUserCDPTarget(info) {
		pages[info.TargetID] = info.URL
	}
}

// openBlankTab waits for whoever closed the last tab to open its own replacement,
// as Playwright MCP does for a crashed tab, before opening one.
func openBlankTab(ctx context.Context, client *liveSessionCDP) {
	timer := time.NewTimer(lastTabReplacementGrace)
	select {
	case <-ctx.Done():
		timer.Stop()
		return
	case <-timer.C:
	}
	createCtx, cancel := context.WithTimeout(ctx, liveSessionBrowserCommandTimeout)
	defer cancel()
	executorCtx := client.executorContext(createCtx, "")
	targets, err := target.GetTargets().Do(executorCtx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: list targets after the last tab closed: %v\n", err)
		return
	}
	for _, info := range targets {
		if isUserCDPTarget(info) {
			return
		}
	}
	// No window is left to hold a tab, so the tab needs a window of its own.
	if _, err := target.CreateTarget("about:blank").WithNewWindow(true).Do(executorCtx); err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: open a blank tab after the last tab closed: %v\n", err)
		return
	}
	fmt.Fprintln(os.Stderr, "browser-session-wrapper: the last tab closed; opened a blank tab")
}
