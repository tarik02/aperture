package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The explicit recording tools act on one running recording of the session: recordingId, or the only
// one running. Coordinates are CSS px of the recorded tab's viewport.
type mcpSurfaceRect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}
type mcpSurfacePoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}
type mcpRecordingCaptionArgs struct {
	RecordingID string `json:"recordingId,omitempty" jsonschema:"Recording to caption; omit when exactly one recording is running."`
	Text        string `json:"text" jsonschema:"Caption text, 1 to 200 characters."`
	DurationMs  int    `json:"durationMs,omitempty" jsonschema:"How long the caption shows, 200 to 30000. Defaults to 3000."`
}
type mcpRecordingFocusArgs struct {
	RecordingID string          `json:"recordingId,omitempty" jsonschema:"Recording to zoom; omit when exactly one recording is running."`
	Rect        *mcpSurfaceRect `json:"rect,omitempty" jsonschema:"Area to zoom on. Pass rect or selector."`
	Selector    string          `json:"selector,omitempty" jsonschema:"CSS selector of the element to zoom on, in the top-level document. Pass rect or selector."`
	Zoom        float64         `json:"zoom" jsonschema:"Zoom factor above 1, up to 4."`
	DurationMs  int             `json:"durationMs,omitempty" jsonschema:"How long the zoom holds, 200 to 10000. Defaults to 2000. The call blocks for this long."`
}
type mcpRecordingAttentionArgs struct {
	RecordingID string           `json:"recordingId,omitempty" jsonschema:"Recording to annotate; omit when exactly one recording is running."`
	Point       *mcpSurfacePoint `json:"point,omitempty" jsonschema:"Where to draw attention. Pass point or selector."`
	Selector    string           `json:"selector,omitempty" jsonschema:"CSS selector of the element to draw attention to, in the top-level document. Pass point or selector."`
	Radius      float64          `json:"radius,omitempty" jsonschema:"Radius of the pointer's circle in px, 8 to 300. Defaults to 40."`
	Loops       int              `json:"loops,omitempty" jsonschema:"How many times the pointer circles, 1 to 5. Defaults to 2."`
	DurationMs  int              `json:"durationMs,omitempty" jsonschema:"How long the pointer circles, 300 to 5000. Defaults to 1200. The call blocks for this long."`
}

// addRecordingAnnotationTool adds one explicit recording tool, session-addressed or bound to the
// session of its path. Its arguments go to the wrapper, which validates them.
func addRecordingAnnotationTool[Args any](s *Server, server *mcp.Server, a mcpAuth, kind, description string) {
	schema, err := jsonschema.For[Args](nil)
	if err != nil {
		panic(err)
	}
	if !a.pathBound {
		schema.Properties["tenantId"] = &jsonschema.Schema{Type: "string"}
		schema.Properties["sessionId"] = &jsonschema.Schema{Type: "string", Description: "Aperture session ID."}
		schema.Required = append(schema.Required, "sessionId")
	}
	server.AddTool(&mcp.Tool{Name: "recording." + kind, Description: description, InputSchema: schema}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		arguments := map[string]any{}
		if len(req.Params.Arguments) > 0 {
			if err := json.Unmarshal(req.Params.Arguments, &arguments); err != nil {
				return nil, mcpToolError("invalid_arguments", err)
			}
		}
		sessionID, _ := arguments["sessionId"].(string)
		tenantID, _ := arguments["tenantId"].(string)
		delete(arguments, "sessionId")
		delete(arguments, "tenantId")
		view, err := s.sessionForMCP(ctx, a, sessionID, tenantID, true)
		if err != nil {
			return nil, err
		}
		port, release, err := s.Sessions.AcquireWrapperPort(ctx, view.Session.TenantID, view.Session.ID)
		if err != nil {
			return nil, mcpToolError("session_unavailable", err)
		}
		defer release()
		if err := requestWrapperRecording(ctx, port, http.MethodPost, "/recordings/annotations/"+kind, arguments, false, nil); err != nil {
			return nil, mcpToolError("recording_unavailable", err)
		}
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "ok"}}}, nil
	})
}

func (s *Server) addRecordingAnnotationTools(server *mcp.Server, a mcpAuth) {
	addRecordingAnnotationTool[mcpRecordingCaptionArgs](s, server, a, "caption", "Show a caption in the recording from now on. Returns at once.")
	addRecordingAnnotationTool[mcpRecordingFocusArgs](s, server, a, "focus", "Zoom the recording on a rect or element for a while. Blocks for the duration, so no browser tool runs meanwhile.")
	addRecordingAnnotationTool[mcpRecordingAttentionArgs](s, server, a, "attention", "Circle the real pointer around a point or element so a viewer looks there. Blocks for the duration. Needs a compositor session.")
}

func (s *Server) mcpRecordingStart(ctx context.Context, _ *mcp.CallToolRequest, in mcpRecordingStartInput) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	return s.mcpRecordingRequest(ctx, view.Session.TenantID, view.Session.ID, http.MethodPost, "/recordings", map[string]any{
		"mode": "tab", "targetId": in.TargetID, "fps": in.FPS, "bitrateKbps": in.BitrateKbps, "codec": in.Codec,
	}, false)
}

func (s *Server) mcpRecordingsList(ctx context.Context, _ *mcp.CallToolRequest, in mcpSessionIDInput) (*mcp.CallToolResult, mcpRecordingsOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingsOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, mcpRecordingsOutput{}, err
	}
	return s.mcpRecordingsRequest(ctx, view.Session.TenantID, view.Session.ID)
}

func (s *Server) mcpRecordingStatus(ctx context.Context, _ *mcp.CallToolRequest, in mcpRecordingInput) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	return s.mcpRecordingRequest(ctx, view.Session.TenantID, view.Session.ID, http.MethodGet, "/recordings/"+url.PathEscape(in.RecordingID), nil, false)
}

func (s *Server) mcpRecordingStop(ctx context.Context, _ *mcp.CallToolRequest, in mcpRecordingInput) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	path := "/recordings/" + url.PathEscape(in.RecordingID)
	if _, _, err := s.mcpRecordingRequest(ctx, view.Session.TenantID, view.Session.ID, http.MethodPost, path+"/stop", nil, true); err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	return s.mcpRecordingRequest(ctx, view.Session.TenantID, view.Session.ID, http.MethodGet, path, nil, false)
}

func (s *Server) mcpRecordingRetarget(ctx context.Context, _ *mcp.CallToolRequest, in mcpRecordingRetargetInput) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	path := "/recordings/" + url.PathEscape(in.RecordingID) + "/retarget"
	return s.mcpRecordingRequest(ctx, view.Session.TenantID, view.Session.ID, http.MethodPost, path, map[string]string{"targetId": in.TargetID}, false)
}

func (s *Server) mcpBoundRecordingStart(ctx context.Context, req *mcp.CallToolRequest, in mcpBoundRecordingStartInput) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	return s.mcpRecordingStart(ctx, req, mcpRecordingStartInput{TenantID: a.tenantID, SessionID: a.sessionID, TargetID: in.TargetID, FPS: in.FPS, BitrateKbps: in.BitrateKbps, Codec: in.Codec})
}

func (s *Server) mcpBoundRecordingsList(ctx context.Context, req *mcp.CallToolRequest, _ mcpSessionOnlyInput) (*mcp.CallToolResult, mcpRecordingsOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingsOutput{}, err
	}
	return s.mcpRecordingsList(ctx, req, mcpSessionIDInput{TenantID: a.tenantID, SessionID: a.sessionID})
}

func (s *Server) mcpBoundRecordingStatus(ctx context.Context, req *mcp.CallToolRequest, in mcpBoundRecordingInput) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	return s.mcpRecordingStatus(ctx, req, mcpRecordingInput{TenantID: a.tenantID, SessionID: a.sessionID, RecordingID: in.RecordingID})
}

func (s *Server) mcpBoundRecordingStop(ctx context.Context, req *mcp.CallToolRequest, in mcpBoundRecordingInput) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	return s.mcpRecordingStop(ctx, req, mcpRecordingInput{TenantID: a.tenantID, SessionID: a.sessionID, RecordingID: in.RecordingID})
}

func (s *Server) mcpBoundRecordingRetarget(ctx context.Context, req *mcp.CallToolRequest, in mcpBoundRecordingRetargetInput) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	return s.mcpRecordingRetarget(ctx, req, mcpRecordingRetargetInput{
		TenantID: a.tenantID, SessionID: a.sessionID, RecordingID: in.RecordingID, TargetID: in.TargetID,
	})
}

func (s *Server) mcpRecordingRequest(ctx context.Context, tenantID, sessionID, method, path string, body any, stop bool) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	port, release, err := s.Sessions.AcquireWrapperPort(ctx, tenantID, sessionID)
	if err != nil {
		return nil, mcpRecordingOutput{}, mcpToolError("session_unavailable", err)
	}
	defer release()
	if stop {
		if err := requestWrapperRecording(ctx, port, method, path, body, true, nil); err != nil {
			return nil, mcpRecordingOutput{}, mcpToolError("recording_unavailable", err)
		}
		return nil, mcpRecordingOutput{}, nil
	}
	var status wrapperRecordingStatus
	if err := requestWrapperRecording(ctx, port, method, path, body, false, &status); err != nil {
		return nil, mcpRecordingOutput{}, mcpToolError("recording_unavailable", err)
	}
	output, err := s.mcpRecordingOutputFromStatus(sessionID, status)
	if err != nil {
		return nil, mcpRecordingOutput{}, mcpToolError("recording_unavailable", err)
	}
	return nil, output, nil
}

func (s *Server) mcpRecordingsRequest(ctx context.Context, tenantID, sessionID string) (*mcp.CallToolResult, mcpRecordingsOutput, error) {
	port, release, err := s.Sessions.AcquireWrapperPort(ctx, tenantID, sessionID)
	if err != nil {
		return nil, mcpRecordingsOutput{}, mcpToolError("session_unavailable", err)
	}
	defer release()
	var statuses []wrapperRecordingStatus
	if err := requestWrapperRecording(ctx, port, http.MethodGet, "/recordings", nil, false, &statuses); err != nil {
		return nil, mcpRecordingsOutput{}, mcpToolError("recording_unavailable", err)
	}
	output := mcpRecordingsOutput{Recordings: make([]mcpRecordingOutput, 0, len(statuses))}
	for _, status := range statuses {
		recording, err := s.mcpRecordingOutputFromStatus(sessionID, status)
		if err != nil {
			return nil, mcpRecordingsOutput{}, mcpToolError("recording_unavailable", err)
		}
		output.Recordings = append(output.Recordings, recording)
	}
	return nil, output, nil
}

func (s *Server) mcpRecordingOutputFromStatus(sessionID string, status wrapperRecordingStatus) (mcpRecordingOutput, error) {
	relativePath, err := s.recordingRelativePath(sessionID, status)
	if err != nil {
		return mcpRecordingOutput{}, err
	}
	output := mcpRecordingOutput{
		RecordingID: status.RecordingID, Mode: status.Mode, TargetID: status.TargetID, CaptureGeneration: status.CaptureGeneration,
		Status: status.Status, StopReason: status.StopReason, StartedAt: status.StartedAt, StoppedAt: status.StoppedAt,
		RelativePath: relativePath, SizeBytes: status.SizeBytes, FPS: status.FPS, BitrateKbps: status.BitrateKbps, Codec: status.Codec,
	}
	return output, nil
}
