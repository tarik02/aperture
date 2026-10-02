package httpapi

import (
	"context"
	"slices"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestRecordingAnnotationToolsAreAddressedBySessionUnlessBound(t *testing.T) {
	t.Parallel()
	for _, bound := range []bool{false, true} {
		server := mcp.NewServer(&mcp.Implementation{Name: "test"}, nil)
		(&Server{}).addRecordingAnnotationTools(server, mcpAuth{pathBound: bound})
		serverTransport, clientTransport := mcp.NewInMemoryTransports()
		if _, err := server.Connect(context.Background(), serverTransport, nil); err != nil {
			t.Fatal(err)
		}
		session, err := mcp.NewClient(&mcp.Implementation{Name: "client"}, nil).Connect(context.Background(), clientTransport, nil)
		if err != nil {
			t.Fatal(err)
		}
		tools, err := session.ListTools(context.Background(), nil)
		if err != nil {
			t.Fatal(err)
		}
		names := make([]string, 0, len(tools.Tools))
		for _, tool := range tools.Tools {
			names = append(names, tool.Name)
			schema := tool.InputSchema.(map[string]any)
			_, hasSession := schema["properties"].(map[string]any)["sessionId"]
			required, _ := schema["required"].([]any)
			if hasSession == bound || slices.Contains(required, any("sessionId")) == bound {
				t.Errorf("bound=%v: %s schema = %v", bound, tool.Name, schema)
			}
		}
		slices.Sort(names)
		if !slices.Equal(names, []string{"recording.attention", "recording.caption", "recording.focus"}) {
			t.Errorf("tools = %v", names)
		}
	}
}
