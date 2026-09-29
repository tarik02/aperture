package httpapi

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/pointer"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func listMCPTools(t *testing.T, a mcpAuth) map[string]*mcp.Tool {
	t.Helper()
	ctx := context.Background()
	server := (&Server{}).newMCPServer(a)
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatalf("connect server: %v", err)
	}
	t.Cleanup(func() { _ = serverSession.Close() })
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	clientSession, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("connect client: %v", err)
	}
	t.Cleanup(func() { _ = clientSession.Close() })
	listed, err := clientSession.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	tools := make(map[string]*mcp.Tool, len(listed.Tools))
	for _, tool := range listed.Tools {
		tools[tool.Name] = tool
	}
	return tools
}

func schemaProperties(t *testing.T, tool *mcp.Tool) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(tool.InputSchema)
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Properties map[string]any `json:"properties"`
	}
	if err := json.Unmarshal(encoded, &schema); err != nil {
		t.Fatal(err)
	}
	return schema.Properties
}

func schemaRequired(t *testing.T, tool *mcp.Tool) []string {
	t.Helper()
	encoded, err := json.Marshal(tool.InputSchema)
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Required []string `json:"required"`
	}
	if err := json.Unmarshal(encoded, &schema); err != nil {
		t.Fatal(err)
	}
	return schema.Required
}

func TestMCPServerExposesApertureNativePointerTools(t *testing.T) {
	for _, pathBound := range []bool{true, false} {
		tools := listMCPTools(t, mcpAuth{
			profiles:    []string{"core", "vision", "network", "storage"},
			sessionID:   "session-1",
			sessionOnly: true,
			pathBound:   pathBound,
		})

		for _, name := range []string{"browser_click", "browser_move", "browser_drag", "browser_scroll"} {
			tool := tools[name]
			if tool == nil {
				t.Fatalf("pathBound=%t: tool %s is not registered", pathBound, name)
			}
			properties := schemaProperties(t, tool)
			for _, property := range []string{"motion", "holdMs", "caption", "timeoutMs"} {
				if _, ok := properties[property]; !ok {
					t.Errorf("pathBound=%t: %s has no %s parameter", pathBound, name, property)
				}
			}
			_, hasSessionID := properties["sessionId"]
			if hasSessionID == pathBound {
				t.Errorf("pathBound=%t: %s sessionId present = %t", pathBound, name, hasSessionID)
			}
			if !pathBound && !slices.Contains(schemaRequired(t, tool), "sessionId") {
				t.Errorf("%s does not require sessionId on a central connection", name)
			}
		}
		// The native tools carry Aperture's own schema, not Playwright's.
		if _, ok := schemaProperties(t, tools["browser_click"])["clickCount"]; !ok {
			t.Errorf("pathBound=%t: browser_click is not the Aperture tool", pathBound)
		}
		// doubleClick stays as a documented alias for clickCount 2.
		if _, ok := schemaProperties(t, tools["browser_click"])["doubleClick"]; !ok {
			t.Errorf("pathBound=%t: browser_click lost the doubleClick alias", pathBound)
		}

		// Playwright's hidden pointer tools are gone; the rest are still proxied.
		for _, name := range []string{"browser_hover", "browser_mouse_click_xy", "browser_mouse_move_xy", "browser_mouse_drag_xy", "browser_mouse_down", "browser_mouse_up", "browser_mouse_wheel"} {
			if tools[name] != nil {
				t.Errorf("pathBound=%t: hidden Playwright tool %s is exposed", pathBound, name)
			}
		}
		for _, name := range []string{"browser_snapshot", "browser_type", "browser_navigate", "browser_evaluate"} {
			if tools[name] == nil {
				t.Errorf("pathBound=%t: Playwright tool %s is missing", pathBound, name)
			}
		}
	}
}

func TestMCPServerOmitsPointerToolsWithoutWriteAccess(t *testing.T) {
	tools := listMCPTools(t, mcpAuth{profiles: []string{"core"}, principal: &auth.Principal{Scopes: []string{auth.ScopeSessionsRead}}, pathBound: true})
	for _, name := range []string{"browser_click", "browser_move", "browser_drag", "browser_scroll", "browser_snapshot"} {
		if tools[name] != nil {
			t.Errorf("tool %s is exposed without sessions:write", name)
		}
	}
}

func TestMCPCursorToolsCarryMotion(t *testing.T) {
	for _, pathBound := range []bool{true, false} {
		tools := listMCPTools(t, mcpAuth{profiles: []string{"core"}, sessionID: "session-1", sessionOnly: true, pathBound: pathBound})
		set := tools["cursor.set"]
		if set == nil || tools["cursor.get"] == nil {
			t.Fatalf("pathBound=%t: cursor tools are missing", pathBound)
		}
		if _, ok := schemaProperties(t, set)["motion"]; !ok {
			t.Errorf("pathBound=%t: cursor.set has no motion parameter", pathBound)
		}
	}
}

func TestCursorUpdateValidation(t *testing.T) {
	visible := true
	fast := pointer.Motion{Kind: pointer.KindFast}
	tests := []struct {
		name    string
		update  cursorUpdate
		wantErr bool
	}{
		{name: "visible only", update: cursorUpdate{Visible: &visible}},
		{name: "motion only", update: cursorUpdate{Motion: &fast}},
		{name: "both", update: cursorUpdate{Visible: &visible, Motion: &fast}},
		{name: "empty", update: cursorUpdate{}, wantErr: true},
	}
	for _, test := range tests {
		if err := test.update.Validate(); (err != nil) != test.wantErr {
			t.Errorf("%s: Validate() error = %v, wantErr %t", test.name, err, test.wantErr)
		}
	}
}

func TestMCPToolInputSchemasHaveNoTopLevelCombinators(t *testing.T) {
	for _, pathBound := range []bool{true, false} {
		tools := listMCPTools(t, mcpAuth{
			profiles:    []string{"core", "vision", "network", "storage"},
			sessionID:   "session-1",
			sessionOnly: pathBound,
			pathBound:   pathBound,
		})
		for name, tool := range tools {
			encoded, err := json.Marshal(tool.InputSchema)
			if err != nil {
				t.Fatal(err)
			}
			var schema map[string]json.RawMessage
			if err := json.Unmarshal(encoded, &schema); err != nil {
				t.Fatal(err)
			}
			for _, keyword := range []string{"oneOf", "anyOf", "allOf"} {
				if _, ok := schema[keyword]; ok {
					t.Errorf("pathBound=%t: tool %s has a top-level %s in its input schema", pathBound, name, keyword)
				}
			}
		}
	}
}
