package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Playwright reveals an element with one DOM.scrollIntoViewIfNeeded, which Chromium performs as a
// single-frame jump. The proxy scrolls smoothly first and then forwards the original command so
// Chromium still validates the element and answers.
const (
	// revealNeededFunction reports whether the element is not fully visible; other objects count as visible.
	revealNeededFunction = `function(){const el=this.nodeType===1?this:this.parentElement;if(!el||!el.isConnected)return false;
return new Promise(done=>{const io=new IntersectionObserver(entries=>{io.disconnect();const e=entries[0];const viewport=innerHeight*innerWidth;const area=e.boundingClientRect.width*e.boundingClientRect.height;done(e.intersectionRatio<Math.min(0.98,0.98*viewport/Math.max(area,1)))});io.observe(el)})}`
	revealScrollFunction   = `function(){const el=this.nodeType===1?this:this.parentElement;el.scrollIntoView({behavior:'smooth',block:'center',inline:'center'});return true}`
	revealPositionFunction = `function(){const el=this.nodeType===1?this:this.parentElement;const r=el.getBoundingClientRect();return [r.top,r.left,scrollX,scrollY].join()}`
)

// revealScroll takes over a reveal command when it can smooth it. It reports whether it did; the
// original command is forwarded by the takeover once the scroll has settled.
func (c *cdpProxyConn) revealScroll(raw []byte, method string) bool {
	if method == "Runtime.callFunctionOn" && (!bytes.Contains(raw, []byte("scrollIntoView")) || !bytes.Contains(raw, []byte("instant"))) {
		return false
	}
	var message cdpMessage
	var params struct {
		ObjectID  string `json:"objectId"`
		Arguments []struct {
			ObjectID string `json:"objectId"`
		} `json:"arguments"`
	}
	if json.Unmarshal(raw, &message) != nil || json.Unmarshal(message.Params, &params) != nil || message.SessionID == "" {
		return false
	}
	// A DOM command names its element; Playwright's retry path passes it among the arguments of
	// a function call, so every handle is probed and non-elements count as visible.
	var handles []string
	if method == "DOM.scrollIntoViewIfNeeded" {
		handles = append(handles, params.ObjectID)
	} else {
		for _, argument := range params.Arguments {
			if argument.ObjectID != "" && argument.ObjectID != params.ObjectID {
				handles = append(handles, argument.ObjectID)
			}
		}
	}
	if len(handles) == 0 || handles[0] == "" {
		return false
	}
	go func() {
		c.smoothReveal(message.SessionID, handles)
		c.toUp(raw)
	}()
	return true
}

func (c *cdpProxyConn) smoothReveal(sessionID string, handles []string) {
	ctx, cancel := context.WithTimeout(c.ctx, revealMaxDuration)
	defer cancel()
	for _, handle := range handles {
		probe, cancelProbe := context.WithTimeout(ctx, pageProbeTimeout)
		needed, err := c.callOn(probe, sessionID, handle, revealNeededFunction)
		cancelProbe()
		if err != nil || strings.TrimSpace(string(needed)) != "true" {
			continue
		}
		c.revealAndSettle(ctx, sessionID, handle)
		return
	}
}

// revealAndSettle scrolls the element to the center and waits until it and the page's own scroll
// position stop moving, so the original command finds the final layout.
func (c *cdpProxyConn) revealAndSettle(ctx context.Context, sessionID, handle string) {
	rootSession, _, _ := c.rootSession(sessionID)
	position := func() string {
		element, _ := c.callOn(ctx, sessionID, handle, revealPositionFunction)
		var page json.RawMessage
		if rootSession != sessionID {
			_ = c.evaluate(ctx, rootSession, "[scrollX,scrollY].join()", &page)
		}
		return string(element) + "|" + string(page)
	}
	start := position()
	if _, err := c.callOn(ctx, sessionID, handle, revealScrollFunction); err != nil {
		return
	}
	began := time.Now()
	last, stable := start, 0
	for ctx.Err() == nil {
		if sleepContext(ctx, revealPollInterval) != nil {
			return
		}
		current := position()
		if current == last {
			stable++
		} else {
			stable = 0
		}
		last = current
		// A scroll that has not started yet looks stable; only trust that once it had time to start.
		if stable >= revealStableRuns && (current != start || time.Since(began) > revealStartGrace) {
			return
		}
	}
}

// callOn calls a function with an object as this and returns its by-value result.
func (c *cdpProxyConn) callOn(ctx context.Context, sessionID, objectID, function string) (json.RawMessage, error) {
	result, err := c.call(ctx, sessionID, "Runtime.callFunctionOn", map[string]any{
		"objectId":            objectID,
		"functionDeclaration": function,
		"awaitPromise":        true,
		"returnByValue":       true,
	})
	if err != nil {
		return nil, err
	}
	var called struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		ExceptionDetails json.RawMessage `json:"exceptionDetails"`
	}
	if err := json.Unmarshal(result, &called); err != nil {
		return nil, err
	}
	if len(called.ExceptionDetails) > 0 {
		return nil, errors.New("page function failed")
	}
	return called.Result.Value, nil
}
