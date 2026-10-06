package browser

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Playwright retries a pointer or input action until its checks pass: the element must be visible,
// stable and enabled, and the action's point must hit it. Every retry scrolls the element again,
// alternately to the centre, the bottom and the top of the view, so in a recording the page jumps
// about, and the tool still succeeds without saying why. The proxy reads why each check failed
// from Playwright's answers, so the retries can be journaled and reported with the tool's result.

// actionCheckMarkers name the page functions whose answer says whether an action's check passed.
var actionCheckMarkers = [][]byte{
	[]byte("setupHitTargetInterceptor"), // fails with the description of the element in the way
	[]byte("h.stop()"),                  // the hit-target check's verdict on the action's first event
	[]byte("checkElementStates"),        // fails with the state the element lacks
}

func isActionCheck(raw []byte) bool {
	for _, marker := range actionCheckMarkers {
		if bytes.Contains(raw, marker) {
			return true
		}
	}
	return false
}

// watchActionCheck remembers a check Playwright runs during an action, so its answer is read.
func (c *cdpProxyConn) watchActionCheck(raw []byte) {
	if !c.proxy.action.Load() || !isActionCheck(raw) {
		return
	}
	id, _ := peekCDP(raw)
	if id == nil {
		return
	}
	c.mu.Lock()
	c.checks[*id] = struct{}{}
	c.mu.Unlock()
}

// readActionCheck takes the answer to a watched check and records the failure it reports.
func (c *cdpProxyConn) readActionCheck(id int64, raw []byte) {
	c.mu.Lock()
	_, watched := c.checks[id]
	delete(c.checks, id)
	c.mu.Unlock()
	if !watched {
		return
	}
	var message cdpMessage
	if json.Unmarshal(raw, &message) != nil || len(message.Result) == 0 {
		return
	}
	value, err := decodeRemoteObject(message.Result)
	if err != nil || len(value) == 0 {
		return
	}
	var decoded any
	if json.Unmarshal(value, &decoded) != nil {
		return
	}
	if reason := actionCheckFailure(decoded); reason != "" {
		c.proxy.noteRetry(reason)
	}
}

// actionCheckFailure reads a check's answer, serialized by Playwright, where an object is
// {"o": [{"k": name, "v": value}, ...]} and undefined is {"v": "undefined"}: nothing or "done"
// passed, anything else is the reason the action has to be tried again.
func actionCheckFailure(value any) string {
	switch value := value.(type) {
	case string:
		switch value {
		case "", "done", "error:notconnected":
			return ""
		case "error:notvisible":
			return "element is not visible"
		case "error:notinviewport":
			return "element is outside of the viewport"
		}
		// A preliminary hit-target check answers with the description of the element in the way.
		return value + " intercepts pointer events"
	case map[string]any:
		properties, _ := value["o"].([]any)
		for _, raw := range properties {
			property, _ := raw.(map[string]any)
			text, _ := property["v"].(string)
			switch property["k"] {
			case "hitTargetDescription":
				return text + " intercepts pointer events"
			case "missingState":
				return "element is not " + text
			}
		}
	}
	return ""
}

// noteRetry records one failed check of the running action, and journals it for the recordings that run.
func (p *cdpProxy) noteRetry(reason string) {
	p.actionMu.Lock()
	if p.action.Load() {
		p.retries = append(p.retries, reason)
	}
	p.actionMu.Unlock()
	p.journal.add("retry", time.Now(), map[string]any{"reason": reason})
}

// takeRetries returns the failed checks of the action that ran and forgets them.
func (p *cdpProxy) takeRetries() []string {
	p.actionMu.Lock()
	defer p.actionMu.Unlock()
	retries := p.retries
	p.retries = nil
	return retries
}

// retryNote tells the caller that its action only succeeded after retries, and why, so it can
// clear the way first the next time: a page that moved or an element in the way makes a recording jump.
func retryNote(tool string, retries []string) string {
	counts := map[string]int{}
	var reasons []string
	for _, reason := range retries {
		if counts[reason] == 0 {
			reasons = append(reasons, reason)
		}
		counts[reason]++
	}
	for i, reason := range reasons {
		if counts[reason] > 1 {
			reasons[i] = fmt.Sprintf("%s (%d×)", reason, counts[reason])
		}
	}
	return fmt.Sprintf("Note: %s had to retry %d time(s) before it succeeded, scrolling the element again each time: %s. "+
		"Make the element reachable first (scroll it into view, dismiss what covers it, wait for the page to settle) or act on another element.",
		tool, len(retries), strings.Join(reasons, "; "))
}
