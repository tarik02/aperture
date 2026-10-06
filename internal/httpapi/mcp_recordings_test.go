package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/aperture/aperture/internal/db"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// mcpClient connects a client to the MCP server a credential sees, with the credential in the
// context the tools read it from.
func mcpClient(t *testing.T, s *Server, a mcpAuth) *mcp.ClientSession {
	t.Helper()
	server := s.newMCPServer(a)
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	if _, err := server.Connect(withMCPAuth(context.Background(), a), serverTransport, nil); err != nil {
		t.Fatal(err)
	}
	client, err := mcp.NewClient(&mcp.Implementation{Name: "client"}, nil).Connect(context.Background(), clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

// call runs a tool and returns its text: the error of a refused call, or its output.
func call(t *testing.T, client *mcp.ClientSession, name string, args map[string]any) (string, bool) {
	t.Helper()
	result, err := client.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		return err.Error(), false
	}
	var text []string
	for _, content := range result.Content {
		if c, ok := content.(*mcp.TextContent); ok {
			text = append(text, c.Text)
		}
	}
	return strings.Join(text, "\n"), !result.IsError
}

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
		if !slices.Equal(names, []string{"recording.attention", "recording.caption", "recording.focus", "recording.reset_focus"}) {
			t.Errorf("tools = %v", names)
		}
	}
}

func TestRecordingStartSchemaSaysWhatIsChecked(t *testing.T) {
	t.Parallel()
	env := newRecordingTestEnv(t, "/usr/bin/ffmpeg")
	for _, a := range []mcpAuth{{tenantID: env.tenantID, sessionID: env.sessionID, pathBound: true, sessionOnly: true}, {tenantID: env.tenantID, sessionOnly: true}} {
		tools, err := mcpClient(t, env.server, a).ListTools(context.Background(), nil)
		if err != nil {
			t.Fatal(err)
		}
		index := slices.IndexFunc(tools.Tools, func(tool *mcp.Tool) bool { return tool.Name == "recording.start" })
		if index < 0 {
			t.Fatal("no recording.start")
		}
		properties := tools.Tools[index].InputSchema.(map[string]any)["properties"].(map[string]any)
		if enum, _ := json.Marshal(properties["capture"].(map[string]any)["enum"]); string(enum) != `["continuous","bursts"]` {
			t.Errorf("capture enum = %s", enum)
		}
		if enum, _ := json.Marshal(properties["idle"].(map[string]any)["enum"]); string(enum) != `["cut","speed"]` {
			t.Errorf("idle enum = %s", enum)
		}
		burst := properties["burst"].(map[string]any)["properties"].(map[string]any)
		for _, name := range []string{"leadMs", "tailMs", "settleMs", "maxTailMs"} {
			if field := burst[name].(map[string]any); field["maximum"] != 60000.0 || field["minimum"] != 0.0 {
				t.Errorf("%s = %v", name, field)
			}
		}
	}
}

func TestMCPRecordingStartIsCheckedBeforeTheWrapperAndTheWake(t *testing.T) {
	t.Parallel()
	env := newRecordingTestEnv(t, "/usr/bin/ffmpeg")
	env.suspend(t)
	client := mcpClient(t, env.server, mcpAuth{tenantID: env.tenantID, sessionID: env.sessionID, pathBound: true, sessionOnly: true})
	if text, ok := call(t, client, "recording.start", map[string]any{"targetId": "T1", "capture": "bursts", "idle": "cut"}); ok || !strings.HasPrefix(text, "invalid_arguments") {
		t.Fatalf("result = %q, %v", text, ok)
	}
	if calls := env.wrapper.requests(); len(calls) != 0 || env.status(t) != db.SessionStatusSuspended {
		t.Fatalf("wrapper saw %v, session is %s", calls, env.status(t))
	}
	// An edit on an instance without ffmpeg is refused the same way.
	noFFmpeg := newRecordingTestEnv(t, "")
	client = mcpClient(t, noFFmpeg.server, mcpAuth{tenantID: noFFmpeg.tenantID, sessionID: noFFmpeg.sessionID, pathBound: true, sessionOnly: true})
	if text, ok := call(t, client, "recording.start", map[string]any{"targetId": "T1", "idle": "cut"}); ok || !strings.HasPrefix(text, "invalid_arguments") || !strings.Contains(text, "recording_ffmpeg_executable") {
		t.Fatalf("result = %q, %v", text, ok)
	}
	if calls := noFFmpeg.wrapper.requests(); len(calls) != 0 {
		t.Fatalf("wrapper saw %v", calls)
	}
}

func TestMCPRecordingErrorsFollowTheWrapperStatus(t *testing.T) {
	t.Parallel()
	env := newRecordingTestEnv(t, "/usr/bin/ffmpeg")
	client := mcpClient(t, env.server, mcpAuth{tenantID: env.tenantID, sessionID: env.sessionID, pathBound: true, sessionOnly: true})
	for status, code := range map[int]string{
		http.StatusBadRequest: "invalid_arguments", http.StatusNotFound: "recording_not_found",
		http.StatusConflict: "recording_invalid_state", http.StatusUnprocessableEntity: "recording_codec_unavailable",
		http.StatusBadGateway: "recording_unavailable",
	} {
		env.wrapper.refuseWith(status, "why")
		if text, ok := call(t, client, "recording.start", map[string]any{"targetId": "T1"}); ok || !strings.HasPrefix(text, code+": ") {
			t.Errorf("%d: result = %q, %v", status, text, ok)
		}
	}
}

func TestMCPRecordingStopReturnsTheEditingRecording(t *testing.T) {
	t.Parallel()
	env := newRecordingTestEnv(t, "/usr/bin/ffmpeg")
	client := mcpClient(t, env.server, mcpAuth{tenantID: env.tenantID, sessionID: env.sessionID, pathBound: true, sessionOnly: true})
	result, err := client.CallTool(context.Background(), &mcp.CallToolParams{Name: "recording.stop", Arguments: map[string]any{"recordingId": testRecordingID}})
	if err != nil || result.IsError {
		t.Fatalf("result = %+v, %v", result, err)
	}
	encoded, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	var output mcpRecordingOutput
	if err := json.Unmarshal(encoded, &output); err != nil {
		t.Fatal(err)
	}
	if output.RecordingID != testRecordingID || output.Status != "stopped" || !output.Editing || output.TimelineRelativePath != "" {
		t.Fatalf("output = %+v", output)
	}
}

func TestMCPAnnotationToolsCheckTheirArgumentsAndNeverWake(t *testing.T) {
	t.Parallel()
	env := newRecordingTestEnv(t, "/usr/bin/ffmpeg")
	addressed := mcpAuth{tenantID: env.tenantID, sessionOnly: true}
	client := mcpClient(t, env.server, addressed)
	if text, ok := call(t, client, "recording.caption", map[string]any{"sessionId": env.sessionID, "text": strings.Repeat("a", 201)}); ok || !strings.Contains(text, "invalid_arguments") {
		t.Fatalf("result = %q, %v", text, ok)
	}
	if calls := env.wrapper.requests(); len(calls) != 0 {
		t.Fatalf("wrapper saw %v", calls)
	}
	// A good one reaches the wrapper typed, with its defaults filled and without the session address.
	if text, ok := call(t, client, "recording.caption", map[string]any{"sessionId": env.sessionID, "tenantId": env.tenantID, "text": " Hello "}); !ok {
		t.Fatalf("result = %q", text)
	}
	calls := env.wrapper.requests()
	if len(calls) != 1 || calls[0].Path != "/recordings/annotations/caption" {
		t.Fatalf("wrapper saw %+v", calls)
	}
	if body := calls[0].Body; body["text"] != "Hello" || body["durationMs"] != 3000.0 || body["sessionId"] != nil || body["tenantId"] != nil || body["recordingId"] != nil {
		t.Fatalf("body = %v", body)
	}
	// A suspended session has no running recording, and is not woken to say so.
	env.suspend(t)
	if text, ok := call(t, client, "recording.focus", map[string]any{"sessionId": env.sessionID, "target": map[string]any{"pointer": true}, "zoom": 2}); ok || !strings.Contains(text, "recording_invalid_state") {
		t.Fatalf("result = %q, %v", text, ok)
	}
	if calls := env.wrapper.requests(); len(calls) != 1 || env.status(t) != db.SessionStatusSuspended {
		t.Fatalf("wrapper saw %v, session is %s", calls, env.status(t))
	}
}
