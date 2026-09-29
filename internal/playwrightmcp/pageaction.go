package playwrightmcp

import "strings"

// This file is the one classification of the browser tools by what a call does
// to the page. Recordings that capture in bursts open a burst on the calls that
// can change the page, and the tools that can open one take a caption to show in
// a recording's edited video, so both read it from here.

// PageAction says what a browser tool call does to the page, and so what it
// means to a recording made with capture "bursts".
type PageAction int

const (
	// ActionNone calls neither change what the page shows nor take time the
	// page needs: they never open, extend or hold a burst.
	ActionNone PageAction = iota
	// ActionPointer is a pointer tool. The burst starts a lead before the
	// gesture, so the video shows the page before the pointer arrives.
	ActionPointer
	// ActionChange is a call that can change what the page shows. It opens a
	// burst without a lead: nothing visible happens before it.
	ActionChange
	// ActionObserve is a wait for time to pass. It holds an open burst open
	// for as long as it lasts, and never opens one.
	ActionObserve
)

// String names the action kind.
func (k PageAction) String() string {
	switch k {
	case ActionPointer:
		return "pointer"
	case ActionChange:
		return "change"
	case ActionObserve:
		return "observe"
	default:
		return "none"
	}
}

// toolActions classifies the browser tools by name. A tool that is missing
// is treated as ActionChange by ClassifyTool, which records more rather than miss
// what a new tool does; the test that walks the Playwright MCP's tool list fails when a
// tool is not here, so an upgrade forces a decision.
//
// browser_tabs and browser_wait_for depend on their arguments and are handled in
// ClassifyTool; their entries here only say they were decided.
var toolActions = map[string]PageAction{
	// Aperture's pointer tools, which run through /automation/pointer.
	"browser_click":  ActionPointer,
	"browser_move":   ActionPointer,
	"browser_drag":   ActionPointer,
	"browser_scroll": ActionPointer,

	// Actions that change what the page shows. browser_evaluate is the escape
	// hatch that can mutate anything, so it counts; a false positive costs about
	// a second of video.
	"browser_navigate":      ActionChange,
	"browser_navigate_back": ActionChange,
	"browser_type":          ActionChange,
	"browser_press_key":     ActionChange,
	"browser_select_option": ActionChange,
	"browser_fill_form":     ActionChange,
	"browser_file_upload":   ActionChange,
	"browser_handle_dialog": ActionChange,
	"browser_drop":          ActionChange,
	"browser_resize":        ActionChange,
	"browser_emulate_media": ActionChange,
	"browser_evaluate":      ActionChange,
	"browser_tabs":          ActionChange,
	"browser_wait_for":      ActionObserve,

	// Reading calls.
	"browser_snapshot":         ActionNone,
	"browser_find":             ActionNone,
	"browser_take_screenshot":  ActionNone,
	"browser_console_messages": ActionNone,
	"browser_network_request":  ActionNone,
	"browser_network_requests": ActionNone,
	"browser_storage_state":    ActionNone,
	"browser_route_list":       ActionNone,

	// Storage and network state changes that move no pixels by themselves.
	"browser_cookie_clear":          ActionNone,
	"browser_cookie_delete":         ActionNone,
	"browser_cookie_get":            ActionNone,
	"browser_cookie_list":           ActionNone,
	"browser_cookie_set":            ActionNone,
	"browser_localstorage_clear":    ActionNone,
	"browser_localstorage_delete":   ActionNone,
	"browser_localstorage_get":      ActionNone,
	"browser_localstorage_list":     ActionNone,
	"browser_localstorage_set":      ActionNone,
	"browser_sessionstorage_clear":  ActionNone,
	"browser_sessionstorage_delete": ActionNone,
	"browser_sessionstorage_get":    ActionNone,
	"browser_sessionstorage_list":   ActionNone,
	"browser_sessionstorage_set":    ActionNone,
	"browser_set_storage_state":     ActionNone,
	"browser_route":                 ActionNone,
	"browser_unroute":               ActionNone,
	"browser_network_state_set":     ActionNone,
}

// ClassifyTool says what a call to a browser tool does to the page. arguments are the call's arguments, which decide browser_tabs
// (listing tabs changes nothing) and browser_wait_for (waiting for text is the
// page changing, waiting for time is only time passing).
func ClassifyTool(tool string, arguments map[string]any) PageAction {
	kind, known := toolActions[tool]
	if !known {
		return ActionChange
	}
	switch tool {
	case "browser_tabs":
		if action, _ := arguments["action"].(string); strings.EqualFold(strings.TrimSpace(action), "list") {
			return ActionNone
		}
		return ActionChange
	case "browser_wait_for":
		for _, key := range []string{"text", "textGone"} {
			if text, _ := arguments[key].(string); text != "" {
				return ActionChange
			}
		}
		return ActionObserve
	}
	return kind
}

// AcceptsCaption says whether a tool takes a caption for a recording's edited
// video: exactly the tools that can open a burst, which are the pointer tools,
// those that change the page, and browser_wait_for, which opens one when it
// waits for text. A call that turns out not to change the page (browser_tabs
// listing tabs, browser_wait_for waiting for time) has its caption dropped by
// whoever reads it, see ClassifyTool. Tools that are unknown to the table take
// none, unlike ClassifyTool, which treats them as changing the page.
func AcceptsCaption(tool string) bool {
	kind, known := toolActions[tool]
	return known && (kind == ActionPointer || kind == ActionChange || tool == "browser_wait_for")
}

// IsPointerTool says whether the tool is one of Aperture's pointer tools.
func IsPointerTool(tool string) bool {
	return toolActions[tool] == ActionPointer
}

// ToolActions returns the classification of every decided tool, for tests.
func ToolActions() map[string]PageAction {
	out := make(map[string]PageAction, len(toolActions))
	for name, kind := range toolActions {
		out[name] = kind
	}
	return out
}
