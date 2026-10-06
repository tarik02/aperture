package browser

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestRecordingWaitsBeforeNavigationAndInput(t *testing.T) {
	for _, method := range []string{"Page.bringToFront", "Page.navigate", "Runtime.evaluate", "Input.dispatchKeyEvent", "Input.dispatchMouseEvent"} {
		t.Run(method, func(t *testing.T) {
			waiting, ready := make(chan string, 1), make(chan struct{})
			h := newProxyHarness(t, cadenceImmediate, func(proxy *cdpProxy) {
				proxy.beginAction(true)
				proxy.prepareTarget = func(ctx context.Context, target string) error {
					waiting <- target
					select {
					case <-ready:
						return nil
					case <-ctx.Done():
						return ctx.Err()
					}
				}
			})
			id := h.send("S2", method, map[string]any{"type": "mouseMoved", "x": 10, "y": 10})
			select {
			case target := <-waiting:
				if target != "T1" {
					t.Fatalf("prepared %s, want page T1", target)
				}
			case <-time.After(time.Second):
				t.Fatal("command did not wait for recording")
			}
			if got := h.chrome.methods(); len(got) != 0 {
				t.Fatalf("browser changed before capture readiness: %v", got)
			}
			close(ready)
			if reply := h.read(); reply.ID == nil || *reply.ID != id || len(reply.Error) != 0 {
				t.Fatalf("reply %+v", reply)
			}
			if got := h.chrome.methods(); len(got) != 1 || got[0] != method {
				t.Fatalf("browser received %v", got)
			}
		})
	}
}

func TestRecordingReadinessFailurePreventsNavigation(t *testing.T) {
	h := newProxyHarness(t, cadenceImmediate, func(proxy *cdpProxy) {
		proxy.prepareTarget = func(context.Context, string) error { return errors.New("capture failed") }
	})
	id := h.send("S1", "Page.navigate", map[string]string{"url": "https://example.com"})
	if reply := h.read(); reply.ID == nil || *reply.ID != id || len(reply.Error) == 0 {
		t.Fatalf("reply %+v", reply)
	}
	if got := h.chrome.methods(); len(got) != 0 {
		t.Fatalf("browser received failed command: %v", got)
	}
}

func TestRecordingTabReadAndClose(t *testing.T) {
	prepared := make(chan string, 10)
	var proxy *cdpProxy
	h := newProxyHarness(t, cadenceImmediate, func(p *cdpProxy) {
		proxy = p
		p.beginAction(true)
		p.prepareTarget = func(_ context.Context, target string) error { prepared <- target; return nil }
	})
	h.chrome.event("Target.attachedToTarget", "", map[string]any{"sessionId": "S3", "targetInfo": map[string]any{"targetId": "T3", "type": "page"}})
	_ = h.read()
	for _, world := range []struct {
		session string
		id      int
		main    bool
	}{{"S1", 11, true}, {"S1", 12, false}, {"S3", 31, true}, {"S3", 32, false}} {
		h.chrome.event("Runtime.executionContextCreated", world.session, map[string]any{"context": map[string]any{"id": world.id, "auxData": map[string]any{"isDefault": world.main}}})
		_ = h.read()
	}
	command := func(session, method string, params map[string]any, wantTarget string) {
		t.Helper()
		id := h.send(session, method, params)
		if reply := h.read(); reply.ID == nil || *reply.ID != id || len(reply.Error) != 0 {
			t.Fatalf("reply %+v", reply)
		}
		select {
		case target := <-prepared:
			if target != wantTarget {
				t.Fatalf("%s prepared %s, want %q", method, target, wantTarget)
			}
		default:
			if wantTarget != "" {
				t.Fatalf("%s did not prepare %s", method, wantTarget)
			}
		}
	}
	command("S1", "Runtime.evaluate", map[string]any{"contextId": 11, "expression": "main-script"}, "T1")
	command("S3", "Runtime.evaluate", map[string]any{"contextId": 32, "expression": "title-script"}, "")
	command("S3", "Runtime.callFunctionOn", map[string]any{"objectId": "title-script", "functionDeclaration": "() => document.title"}, "")
	command("S3", "Page.bringToFront", nil, "T3")
	command("S3", "Runtime.evaluate", map[string]any{"contextId": 31, "expression": "selected-script"}, "T3")
	h.chrome.event("Target.detachedFromTarget", "", map[string]any{"sessionId": "S3", "targetId": "T3"})
	_ = h.read()
	proxy.beginAction(true)
	command("S1", "Runtime.callFunctionOn", map[string]any{"objectId": "main-script", "functionDeclaration": "() => document.body.style.background = 'red'"}, "T1")
	proxy.beginAction(false)
	command("S1", "Runtime.evaluate", map[string]any{"contextId": 11, "expression": "document.title"}, "")
}

func TestRecordingCreatesBlankTabBeforeLoadingRequestedURL(t *testing.T) {
	waiting, ready := make(chan string, 1), make(chan struct{})
	navigated := make(chan [2]string, 1)
	h := newProxyHarness(t, cadenceImmediate, func(proxy *cdpProxy) {
		proxy.following = func() bool { return true }
		proxy.prepareTarget = func(ctx context.Context, target string) error {
			waiting <- target
			select {
			case <-ready:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		proxy.navigateTarget = func(target, url string) error { navigated <- [2]string{target, url}; return nil }
	})
	id := h.send("", "Target.createTarget", map[string]any{"url": "https://example.com/new", "newWindow": true, "browserContextId": "private"})
	select {
	case target := <-waiting:
		if target != "T-new" {
			t.Fatalf("prepared %s", target)
		}
	case <-time.After(time.Second):
		t.Fatal("new tab did not wait for capture")
	}
	h.chrome.mu.Lock()
	create := h.chrome.got[0]
	h.chrome.mu.Unlock()
	var params map[string]any
	if err := json.Unmarshal(create.Params, &params); err != nil {
		t.Fatal(err)
	}
	if params["url"] != "about:blank" || params["newWindow"] != true || params["browserContextId"] != "private" {
		t.Fatalf("creation parameters %v", params)
	}
	select {
	case got := <-navigated:
		t.Fatalf("navigated before capture: %v", got)
	default:
	}
	close(ready)
	if reply := h.read(); reply.ID == nil || *reply.ID != id || string(reply.Result) != `{"targetId":"T-new"}` {
		t.Fatalf("reply %+v", reply)
	}
	if got := <-navigated; got != [2]string{"T-new", "https://example.com/new"} {
		t.Fatalf("navigation %v", got)
	}
}
