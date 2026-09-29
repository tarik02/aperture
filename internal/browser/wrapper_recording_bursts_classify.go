package browser

import "strings"

// burstActionKind says what a browser tool call means to a recording made with
// capture "bursts".
type burstActionKind int

const (
	// burstActionNone calls neither change what the page shows nor take time the
	// page needs: they never open, extend or hold a burst.
	burstActionNone burstActionKind = iota
	// burstActionPointer is a pointer tool. The burst starts a lead before the
	// gesture, so the video shows the page before the pointer arrives.
	burstActionPointer
	// burstActionChange is a call that can change what the page shows. It opens a
	// burst without a lead: nothing visible happens before it.
	burstActionChange
	// burstActionObserve is a wait for time to pass. It holds an open burst open
	// for as long as it lasts, and never opens one.
	burstActionObserve
)

func (k burstActionKind) String() string {
	switch k {
	case burstActionPointer:
		return "pointer"
	case burstActionChange:
		return "change"
	case burstActionObserve:
		return "observe"
	default:
		return "none"
	}
}

// burstToolKinds classifies the browser tools by name. A tool that is missing
// is treated as burstActionChange, which records more rather than miss what a
// new tool does; the test that walks the Playwright MCP's tool list fails when a
// tool is not here, so an upgrade forces a decision.
//
// browser_tabs and browser_wait_for depend on their arguments and are handled in
// classifyBurstAction; their entries here only say they were decided.
var burstToolKinds = map[string]burstActionKind{
	// Aperture's pointer tools, which run through /automation/pointer.
	"browser_click":  burstActionPointer,
	"browser_move":   burstActionPointer,
	"browser_drag":   burstActionPointer,
	"browser_scroll": burstActionPointer,

	// Actions that change what the page shows. browser_evaluate is the escape
	// hatch that can mutate anything, so it counts; a false positive costs about
	// a second of video.
	"browser_navigate":      burstActionChange,
	"browser_navigate_back": burstActionChange,
	"browser_type":          burstActionChange,
	"browser_press_key":     burstActionChange,
	"browser_select_option": burstActionChange,
	"browser_fill_form":     burstActionChange,
	"browser_file_upload":   burstActionChange,
	"browser_handle_dialog": burstActionChange,
	"browser_drop":          burstActionChange,
	"browser_resize":        burstActionChange,
	"browser_emulate_media": burstActionChange,
	"browser_evaluate":      burstActionChange,
	"browser_tabs":          burstActionChange,
	"browser_wait_for":      burstActionObserve,

	// Reading calls.
	"browser_snapshot":         burstActionNone,
	"browser_find":             burstActionNone,
	"browser_take_screenshot":  burstActionNone,
	"browser_console_messages": burstActionNone,
	"browser_network_request":  burstActionNone,
	"browser_network_requests": burstActionNone,
	"browser_storage_state":    burstActionNone,
	"browser_route_list":       burstActionNone,

	// Storage and network state changes that move no pixels by themselves.
	"browser_cookie_clear":          burstActionNone,
	"browser_cookie_delete":         burstActionNone,
	"browser_cookie_get":            burstActionNone,
	"browser_cookie_list":           burstActionNone,
	"browser_cookie_set":            burstActionNone,
	"browser_localstorage_clear":    burstActionNone,
	"browser_localstorage_delete":   burstActionNone,
	"browser_localstorage_get":      burstActionNone,
	"browser_localstorage_list":     burstActionNone,
	"browser_localstorage_set":      burstActionNone,
	"browser_sessionstorage_clear":  burstActionNone,
	"browser_sessionstorage_delete": burstActionNone,
	"browser_sessionstorage_get":    burstActionNone,
	"browser_sessionstorage_list":   burstActionNone,
	"browser_sessionstorage_set":    burstActionNone,
	"browser_set_storage_state":     burstActionNone,
	"browser_route":                 burstActionNone,
	"browser_unroute":               burstActionNone,
	"browser_network_state_set":     burstActionNone,
}

// classifyBurstAction says what a call to a browser tool means to bursts
// recordings. arguments are the call's arguments, which decide browser_tabs
// (listing tabs changes nothing) and browser_wait_for (waiting for text is the
// page changing, waiting for time is only time passing).
func classifyBurstAction(tool string, arguments map[string]any) burstActionKind {
	kind, known := burstToolKinds[tool]
	if !known {
		return burstActionChange
	}
	switch tool {
	case "browser_tabs":
		if action, _ := arguments["action"].(string); strings.EqualFold(strings.TrimSpace(action), "list") {
			return burstActionNone
		}
		return burstActionChange
	case "browser_wait_for":
		for _, key := range []string{"text", "textGone"} {
			if text, _ := arguments[key].(string); text != "" {
				return burstActionChange
			}
		}
		return burstActionObserve
	}
	return kind
}
