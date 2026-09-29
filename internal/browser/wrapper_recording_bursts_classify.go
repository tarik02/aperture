package browser

import "github.com/aperture/aperture/internal/playwrightmcp"

// burstActionKind says what a browser tool call means to a recording made with
// capture "bursts". The classification of the tools lives in playwrightmcp, where
// the captions of the edited video read it too.
type burstActionKind = playwrightmcp.PageAction

const (
	// burstActionNone calls neither change what the page shows nor take time the
	// page needs: they never open, extend or hold a burst.
	burstActionNone = playwrightmcp.ActionNone
	// burstActionPointer is a pointer tool. The burst starts a lead before the
	// gesture, so the video shows the page before the pointer arrives.
	burstActionPointer = playwrightmcp.ActionPointer
	// burstActionChange is a call that can change what the page shows. It opens a
	// burst without a lead: nothing visible happens before it.
	burstActionChange = playwrightmcp.ActionChange
	// burstActionObserve is a wait for time to pass. It holds an open burst open
	// for as long as it lasts, and never opens one.
	burstActionObserve = playwrightmcp.ActionObserve
)

// classifyBurstAction says what a call to a browser tool means to bursts recordings.
func classifyBurstAction(tool string, arguments map[string]any) burstActionKind {
	return playwrightmcp.ClassifyTool(tool, arguments)
}
