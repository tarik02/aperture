package playwrightmcp

import (
	"strings"
	"testing"
)

// Every tool of the bundled Playwright MCP has to be decided on, so that
// upgrading it forces a choice about whether the tool opens a burst.
func TestEveryBrowserToolIsClassified(t *testing.T) {
	metadata, err := MetadataFromEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	for name, tool := range metadata.Tools {
		kind, decided := toolActions[name]
		if !decided {
			t.Errorf("%s has no entry in toolActions", name)
			continue
		}
		if kind != ActionNone {
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
	for name, kind := range toolActions {
		if _, exposed := metadata.Tools[name]; !exposed && kind != ActionPointer {
			t.Errorf("toolActions has %s, which the Playwright MCP does not have", name)
		}
	}
}

func TestCaptionIsAcceptedExactlyWhereABurstCanOpen(t *testing.T) {
	for name, kind := range toolActions {
		want := kind == ActionPointer || kind == ActionChange || name == "browser_wait_for"
		if AcceptsCaption(name) != want {
			t.Errorf("AcceptsCaption(%s) = %t, want %t", name, !want, want)
		}
	}
	if AcceptsCaption("browser_new_tool") {
		t.Error("a tool nobody decided on takes a caption")
	}
}
