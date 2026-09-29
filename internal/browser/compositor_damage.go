package browser

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// captureDamage is the compositor's account of content changes on one capture
// output, from its "damage-status" control command.
//
// A change is content damage: a client surface bound to the output committed
// new pixels, or a surface was bound to it. The compositor deliberately does not
// count repaints, which happen without new content (a forced "output-repaint",
// a PipeWire consumer connecting) or for the cursor alone, so a static page
// reports no changes however the output is repainted, and moving the mouse over
// it is not a change either. The pointer tools track gestures themselves.
type captureDamage struct {
	// Since is how long before the sample the last change happened. Before any
	// change it counts from the output's creation.
	Since time.Duration
	// Count is the number of changes so far. It only grows, so a sampler
	// detects a change by comparing it with the previous sample.
	Count uint64
	// LastChange is Since converted to wall time. The compositor answers within
	// a millisecond, so it is placed at the middle of the request.
	LastChange time.Time
}

// parseCaptureDamage reads a "damage-status" response: "ok <ms since last
// change> <change count>".
func parseCaptureDamage(response string) (captureDamage, error) {
	fields := strings.Fields(response)
	if len(fields) != 3 || fields[0] != "ok" {
		return captureDamage{}, fmt.Errorf("unexpected damage status %q", response)
	}
	sinceMS, err := strconv.ParseUint(fields[1], 10, 63)
	if err != nil {
		return captureDamage{}, fmt.Errorf("parse damage status age: %w", err)
	}
	count, err := strconv.ParseUint(fields[2], 10, 64)
	if err != nil {
		return captureDamage{}, fmt.Errorf("parse damage status count: %w", err)
	}
	return captureDamage{Since: time.Duration(sinceMS) * time.Millisecond, Count: count}, nil
}

// readCaptureDamage asks the compositor when a capture output's content last changed.
func readCaptureDamage(ctx context.Context, controlSocket, captureID string) (captureDamage, error) {
	requested := time.Now()
	response, err := sendCompositorQuery(ctx, controlSocket, "damage-status "+captureID+"\n")
	if err != nil {
		return captureDamage{}, err
	}
	answered := time.Now()
	damage, err := parseCaptureDamage(response)
	if err != nil {
		return captureDamage{}, err
	}
	damage.LastChange = requested.Add(answered.Sub(requested) / 2).Add(-damage.Since)
	return damage, nil
}
