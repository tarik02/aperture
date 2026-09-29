package httpapi

import (
	"context"
	"net/http"
	"net/url"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const mcpRecordingStartDescription = `Start a tab recording of one ready top-level target. The recording keeps the raw video and a timeline of what happened in it, and can also produce an edited video when it stops from effects declared while it runs: idle, ripple and zoom here set the recording's defaults; browser_click, browser_move, browser_drag and browser_scroll take their own zoom (and browser_click ripple), and page-changing tools such as browser_navigate and browser_type, like the pointer tools, take a caption that is burned into the edited video. A recording with none of these produces no edited video.`

const mcpRecordingStopDescription = `Stop and finalize one recording by ID. When the recording has effects to apply (a caption, a zoomed gesture, a rippled click, or idle), the call waits while the edited video is rendered, which takes from seconds to a minute or two, longer for long recordings; the result then has editState done and editedRelativePath next to the raw video's relativePath. If the edit fails the raw video and its timeline are returned all the same, with editState failed and editError saying why (for example unsupported_mixed_sizes after the viewport was resized while recording). editState is none when there was nothing to apply, and pending when a recording that stopped by itself or from the live session still has effects to render: stop it again to render them. A second stop while the edit renders returns at once with editState rendering; poll recordings.list. editWarnings say what of the effects could not be applied.`

func mcpRecordingStartInputSchema(pathBound bool) map[string]any {
	properties := map[string]any{
		"targetId":    map[string]any{"type": "string", "description": "Identifier of the ready top-level target to record."},
		"fps":         map[string]any{"type": "integer"},
		"bitrateKbps": map[string]any{"type": "integer"},
		"codec":       map[string]any{"type": "string", "enum": []any{"vp8", "h264-va"}},
	}
	for name, property := range mcpRecordingEffectsProperties() {
		properties[name] = property
	}
	schema := map[string]any{"type": "object", "additionalProperties": false, "properties": properties, "required": []any{"targetId"}}
	if !pathBound {
		properties["tenantId"] = map[string]any{"type": "string"}
		properties["sessionId"] = map[string]any{"type": "string"}
		schema["required"] = []any{"sessionId", "targetId"}
	}
	return schema
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
	if err := in.validate(); err != nil {
		return nil, mcpRecordingOutput{}, mcpToolError("invalid_arguments", err)
	}
	request := map[string]any{
		"mode": "tab", "targetId": in.TargetID, "fps": in.FPS, "bitrateKbps": in.BitrateKbps, "codec": in.Codec,
	}
	in.wrapperFields(request)
	return s.mcpRecordingRequest(ctx, view.Session.TenantID, view.Session.ID, http.MethodPost, "/recordings", request, false)
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
	return s.mcpRecordingStart(ctx, req, mcpRecordingStartInput{
		TenantID: a.tenantID, SessionID: a.sessionID, TargetID: in.TargetID, FPS: in.FPS, BitrateKbps: in.BitrateKbps, Codec: in.Codec,
		recordingEffectsRequest: in.recordingEffectsRequest,
	})
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
	timelinePath, err := recordingTimelineRelativePath(status)
	if err != nil {
		return mcpRecordingOutput{}, err
	}
	output := mcpRecordingOutput{
		RecordingID: status.RecordingID, Mode: status.Mode, TargetID: status.TargetID, CaptureGeneration: status.CaptureGeneration,
		Status: status.Status, StopReason: status.StopReason, StartedAt: status.StartedAt, StoppedAt: status.StoppedAt,
		RelativePath: relativePath, TimelineRelativePath: timelinePath, SizeBytes: status.SizeBytes, FPS: status.FPS, BitrateKbps: status.BitrateKbps, Codec: status.Codec,
		EditState: status.EditState, EditError: status.EditError, EditWarnings: status.EditWarnings,
	}
	if output.EditedRelativePath, err = recordingEditedRelativePath(status); err != nil {
		return mcpRecordingOutput{}, err
	}
	return output, nil
}
