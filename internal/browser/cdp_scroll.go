package browser

import (
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
	// revealNeededFunction reports whether the element is not fully visible. An IntersectionObserver
	// sees clipping by inner scrollers and by outer frames, including out-of-process ones, which a
	// synchronous rect check from inside the frame cannot.
	revealNeededFunction = `function(){const el=this.nodeType===1?this:this.parentElement;if(!el||!el.isConnected)return false;
return new Promise(done=>{const io=new IntersectionObserver(entries=>{io.disconnect();const e=entries[0];const viewport=innerHeight*innerWidth;const area=e.boundingClientRect.width*e.boundingClientRect.height;done(e.intersectionRatio<Math.min(0.98,0.98*viewport/Math.max(area,1)))});io.observe(el)})}`
	revealScrollFunction = `function(){const el=this.nodeType===1?this:this.parentElement;el.scrollIntoView({behavior:'smooth',block:'center',inline:'center'});return true}`
	// revealPositionFunction samples the element and every scroll position up its frame chain
	// (the walk stops at a cross-origin frame).
	revealPositionFunction = `function(){const el=this.nodeType===1?this:this.parentElement;const r=el.getBoundingClientRect();const s=[r.top,r.left];
try{for(let w=window;;w=w.parent){s.push(w.scrollX,w.scrollY);if(w===w.parent)break}}catch(e){}return s.join()}`
)

// revealScroll takes over a reveal command when it can smooth it. It reports whether it did; the
// original command is forwarded by the takeover once the scroll has settled.
func (c *cdpProxyConn) revealScroll(raw []byte) bool {
	var params struct {
		ObjectID string `json:"objectId"`
	}
	message, ok := decodeCDP(raw, &params)
	if !ok || params.ObjectID == "" || message.SessionID == "" {
		return false
	}
	go func() {
		c.smoothReveal(message.SessionID, params.ObjectID)
		c.toUp(raw)
	}()
	return true
}

func (c *cdpProxyConn) smoothReveal(sessionID, handle string) {
	ctx, cancel := context.WithTimeout(c.ctx, revealMaxDuration)
	defer cancel()
	if needed, err := c.callOn(ctx, sessionID, handle, revealNeededFunction); err != nil || strings.TrimSpace(string(needed)) != "true" {
		return
	}
	// A failed probe ends the wait: a page blocked by a dialog must not hold the command up.
	rootSession, root, _ := c.rootSession(sessionID)
	defer c.proxy.journal.add("reveal", time.Now(), map[string]any{"targetId": root.targetID})
	c.proxy.journal.add("target", time.Now(), map[string]any{"targetId": root.targetID})
	position := func() (string, error) {
		element, err := c.callOn(ctx, sessionID, handle, revealPositionFunction)
		var page json.RawMessage
		if err == nil && rootSession != sessionID {
			err = c.evaluate(ctx, rootSession, "[scrollX,scrollY].join()", &page)
		}
		return string(element) + "|" + string(page), err
	}
	// The element and the page's own scroll position settle together, so the original command
	// finds the final layout.
	last, err := position()
	if err != nil {
		return
	}
	start := last
	if _, err := c.callOn(ctx, sessionID, handle, revealScrollFunction); err != nil {
		return
	}
	began := time.Now()
	for stable := 0; ctx.Err() == nil; {
		if sleepContext(ctx, revealPollInterval) != nil {
			return
		}
		current, err := position()
		if err != nil {
			return
		}
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
