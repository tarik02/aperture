package browser

import (
	"strings"
	"testing"

	"github.com/aperture/aperture/internal/playwrightmcp"
)

func TestClassifyBurstAction(t *testing.T) {
	for _, test := range []struct {
		tool      string
		arguments map[string]any
		want      burstActionKind
	}{
		{"browser_click", nil, burstActionPointer},
		{"browser_scroll", nil, burstActionPointer},
		{"browser_navigate", map[string]any{"url": "https://example.com"}, burstActionChange},
		{"browser_evaluate", map[string]any{"function": "() => 1"}, burstActionChange},
		{"browser_tabs", map[string]any{"action": "list"}, burstActionNone},
		{"browser_tabs", map[string]any{"action": "new"}, burstActionChange},
		{"browser_tabs", map[string]any{"action": "select", "index": 1.0}, burstActionChange},
		{"browser_wait_for", map[string]any{"time": 2.0}, burstActionObserve},
		{"browser_wait_for", map[string]any{"text": "Done"}, burstActionChange},
		{"browser_wait_for", map[string]any{"textGone": "Loading"}, burstActionChange},
		{"browser_snapshot", nil, burstActionNone},
		{"browser_cookie_set", map[string]any{"name": "a"}, burstActionNone},
		// A tool nobody has classified is recorded: better a clip too many than a
		// missed effect.
		{"browser_new_tool", nil, burstActionChange},
	} {
		if got := classifyBurstAction(test.tool, test.arguments); got != test.want {
			t.Errorf("%s %v: %v, want %v", test.tool, test.arguments, got, test.want)
		}
	}
}

// Every tool of the bundled Playwright MCP has to be decided on, so that
// upgrading it forces a choice about whether the tool opens a burst.
func TestEveryBrowserToolIsClassified(t *testing.T) {
	metadata, err := playwrightmcp.MetadataFromEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	for name, tool := range metadata.Tools {
		kind, decided := burstToolKinds[name]
		if !decided {
			t.Errorf("%s has no entry in burstToolKinds", name)
			continue
		}
		if kind != burstActionNone {
			continue
		}
		// A tool that opens no burst either only reads, or changes state that is
		// not on screen.
		annotations, _ := tool.Annotations.(map[string]any)
		readOnly, _ := annotations["readOnlyHint"].(bool)
		offScreen := strings.Contains(name, "cookie") || strings.Contains(name, "storage") ||
			name == "browser_route" || name == "browser_unroute" || name == "browser_network_state_set"
		if !readOnly && !offScreen {
			t.Errorf("%s changes the page but opens no burst", name)
		}
	}
	for name := range burstToolKinds {
		if _, exposed := metadata.Tools[name]; !exposed && !isPointerToolName(name) {
			t.Errorf("burstToolKinds has %s, which the Playwright MCP does not have", name)
		}
	}
}

func isPointerToolName(name string) bool {
	switch name {
	case pointerToolClick, pointerToolMove, pointerToolDrag, pointerToolScroll:
		return true
	}
	return false
}
