package playwrightmcp

import (
	"slices"
	"testing"
)

// Aperture provides its own pointer tools under these names, so the Playwright
// tools must stay out of the metadata that decides what clients can call.
var apertureReplacedTools = []string{
	"browser_click",
	"browser_drag",
	"browser_hover",
	"browser_mouse_click_xy",
	"browser_mouse_down",
	"browser_mouse_drag_xy",
	"browser_mouse_move_xy",
	"browser_mouse_up",
	"browser_mouse_wheel",
}

func TestReplacedPointerToolsAreNotExposed(t *testing.T) {
	metadata, err := MetadataFromEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range apertureReplacedTools {
		if HasTool(name) {
			t.Errorf("%s is exposed to clients", name)
		}
		for profile, entry := range metadata.Profiles {
			if slices.Contains(entry.Tools, name) {
				t.Errorf("profile %s lists %s", profile, name)
			}
		}
	}
	for _, name := range []string{"browser_snapshot", "browser_evaluate", "browser_type", "browser_press_key"} {
		if !HasTool(name) {
			t.Errorf("%s is missing", name)
		}
	}
}

func TestVisionProfileStaysValidWithoutTools(t *testing.T) {
	profiles, err := ParseProfiles("core,vision,network")
	if err != nil {
		t.Fatalf("vision profile is rejected: %v", err)
	}
	if !slices.Contains(profiles, "vision") {
		t.Fatalf("profiles = %v", profiles)
	}
	tools, err := ToolsForProfilesMetadata([]string{"vision"})
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 0 {
		t.Fatalf("vision profile exposes %d tools", len(tools))
	}
	// The wrapper needs the capability for the coordinate tools it calls when it uses Playwright input.
	if !slices.Contains(RuntimeCapabilities(), "vision") {
		t.Fatal("the vision capability is not enabled in Playwright MCP")
	}
}
