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
	// Mapped is the number of mapped surfaces bound to the output. With none the
	// output shows only its background.
	Mapped int
	// LastChange is Since converted to wall time. The compositor answers within
	// a millisecond, so it is placed at the middle of the request.
	LastChange time.Time
}

// parseCaptureDamage reads a "damage-status" response: "ok <ms since last
// change> <change count> <mapped surfaces>".
func parseCaptureDamage(response string) (captureDamage, error) {
	fields := strings.Fields(response)
	if len(fields) != 4 || fields[0] != "ok" {
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
	mapped, err := strconv.Atoi(fields[3])
	if err != nil || mapped < 0 {
		return captureDamage{}, fmt.Errorf("parse damage status surfaces %q", fields[3])
	}
	return captureDamage{Since: time.Duration(sinceMS) * time.Millisecond, Count: count, Mapped: mapped}, nil
}

// readCaptureDamage asks the compositor when a capture output's content last changed.
func readCaptureDamage(ctx context.Context, controlSocket, captureID string) (captureDamage, error) {
	requested := time.Now()
	response, err := sendCompositorControlCommand(ctx, controlSocket, "damage-status "+captureID+"\n")
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

// captureIdleFor returns how long the content of a capture output has been
// unchanged: zero right after a change, and growing while the page is still.
// It is the query behind "wait until the screen settles".
func (r *wrapperRuntime) captureIdleFor(ctx context.Context, captureID string) (time.Duration, error) {
	damage, err := readCaptureDamage(ctx, r.controlSocket, captureID)
	if err != nil {
		return 0, err
	}
	return damage.Since, nil
}
