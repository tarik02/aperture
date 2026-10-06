package browser

import (
	"bytes"
	"encoding/json"
)

// Before a pointer action Playwright installs a hit-target check in the page and then moves the
// mouse there; the check judges the action by where the first trusted mouse event of the action
// lands. A glide sends its first motion events near where the pointer was, so hovering, which
// checks mousemove, would fail and Playwright would retry from another scroll position. The proxy
// therefore glides to the action's point while the check is being installed: the move that follows
// is then already there.

// hitTargetSetup reports whether a command installs Playwright's hit-target check, and where the
// action will happen in the frame's CSS px.
func hitTargetSetup(raw []byte) (cdpPoint, bool) {
	if !bytes.Contains(raw, []byte("setupHitTargetInterceptor")) {
		return cdpPoint{}, false
	}
	var message struct {
		Params struct {
			Arguments []struct {
				Value json.RawMessage `json:"value"`
			} `json:"arguments"`
		} `json:"params"`
	}
	if json.Unmarshal(raw, &message) != nil {
		return cdpPoint{}, false
	}
	for _, argument := range message.Params.Arguments {
		var value any
		if json.Unmarshal(argument.Value, &value) != nil {
			continue
		}
		if point, ok := findHitPoint(value); ok {
			return point, true
		}
	}
	return cdpPoint{}, false
}

// findHitPoint finds the hitPoint property in an argument serialized by Playwright, where an object
// is {"o": [{"k": name, "v": value}, ...]} and a number is itself.
func findHitPoint(value any) (cdpPoint, bool) {
	switch value := value.(type) {
	case []any:
		for _, item := range value {
			if point, ok := findHitPoint(item); ok {
				return point, true
			}
		}
	case map[string]any:
		if value["k"] == "hitPoint" {
			fields, _ := value["v"].(map[string]any)
			properties, _ := fields["o"].([]any)
			var point cdpPoint
			found := 0
			for _, raw := range properties {
				property, _ := raw.(map[string]any)
				number, isNumber := property["v"].(float64)
				switch {
				case !isNumber:
				case property["k"] == "x":
					point.x = number
					found++
				case property["k"] == "y":
					point.y = number
					found++
				}
			}
			return point, found == 2
		}
		for _, item := range value {
			if point, ok := findHitPoint(item); ok {
				return point, true
			}
		}
	}
	return cdpPoint{}, false
}

// glideToHitTarget takes over the installation of a hit-target check at a paced cadence: in the
// mouse FIFO, so it keeps its order with input, it glides to the action's point and then forwards
// the command. Only a page's own session is taken over, where frame px are the surface's.
func (c *cdpProxyConn) glideToHitTarget(raw []byte) bool {
	if c.proxy.pointer == nil || c.proxy.cadence() == cadenceImmediate {
		return false
	}
	point, ok := hitTargetSetup(raw)
	if !ok {
		return false
	}
	var message cdpMessage
	if json.Unmarshal(raw, &message) != nil {
		return false
	}
	rootSession, root, known := c.rootSession(message.SessionID)
	if !known || root.kind != "page" || rootSession != message.SessionID {
		return false
	}
	c.mouseBusy.Add(1)
	select {
	case c.mouse <- func() {
		defer c.mouseBusy.Add(-1)
		if !c.prepareEvaluation(raw) {
			return
		}
		if surface, ok := c.proxy.pointer.surface(root.targetID); ok {
			landed, style := c.aim(rootSession, surface, point, c.proxy.timing(c.proxy.cadence()))
			_ = c.proxy.pointer.glide(c.ctx, surface, landed, style)
		}
		c.toUp(raw)
	}:
	case <-c.ctx.Done():
		c.mouseBusy.Add(-1)
	}
	return true
}
