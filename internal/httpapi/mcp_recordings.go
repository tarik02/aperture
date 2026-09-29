package httpapi

import (
	"context"
	"net/http"
	"net/url"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const mcpRecordingStartDescription = `Start a tab recording of one ready top-level target. By default it records continuously. With capture "bursts" it records only around browser actions: an action (a pointer tool, navigation, typing, waiting for text and other page-changing tools) opens a burst, which stays open while actions keep coming and closes once the screen has settled; the bursts are joined into one video, and the recording's timeline lists them. A pointer tool's burst starts burst.leadMs before the gesture. Bursts record the page the automation is acting on. The tool call that runs an action returns when the action is done; recording.stop waits for a burst that is still settling, at most burst.maxTailMs. Stopping a bursts recording in which no action ran fails it with stopReason no_bursts and no video. motion sets how the pointer travels in this recording, below a tool's own motion and above the session's (cursor.set).`

func mcpRecordingStartInputSchema(pathBound bool) map[string]any {
	burstField := func(description string, maximum int) map[string]any {
		return map[string]any{"type": "integer", "minimum": 0, "maximum": maximum, "description": description}
	}
	properties := map[string]any{
		"targetId":    map[string]any{"type": "string", "description": "Identifier of the ready top-level target to record."},
		"fps":         map[string]any{"type": "integer"},
		"bitrateKbps": map[string]any{"type": "integer"},
		"codec":       map[string]any{"type": "string", "enum": []any{"vp8", "h264-va"}},
		"capture": map[string]any{
			"type": "string", "enum": []any{recordingCaptureContinuous, recordingCaptureBursts},
			"description": `"continuous" (the default) records the whole time; "bursts" records only around browser actions.`,
		},
		"motion": mcpPointerMotionSchema(`Pointer motion for gestures made while this recording runs: "natural", "fast", "instant", {"speed": px/s} or {"durationMs": ms}. A tool's own motion overrides it, and it overrides the session's (cursor.set).`),
		"burst": map[string]any{
			"type": "object", "additionalProperties": false,
			"description": `Timing of a bursts recording (capture "bursts" only). Omitted fields take the defaults.`,
			"properties": map[string]any{
				"leadMs":    burstField("Video recorded before a pointer action starts, so the page is seen before the pointer moves. Default 400, up to 10000.", recordingBurstMaxLeadMs),
				"tailMs":    burstField("The least video recorded after an action ends. Default 600, up to 30000. Also holdMs of a pointer tool counts.", recordingBurstMaxTailMs),
				"settleMs":  burstField("How long the screen must stay unchanged, after the tail, for the burst to close. Default 500, up to 30000.", recordingBurstMaxSettleMs),
				"maxTailMs": burstField("The most video recorded after an action ends, however long the screen keeps changing (an animation or a video never settles). Default 4000, up to 60000, and not less than tailMs.", recordingBurstMaxMaxTailMs),
			},
		},
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
	request := createSessionRecordingRequest{
		TargetID: in.TargetID, FPS: in.FPS, BitrateKbps: in.BitrateKbps, Codec: in.Codec,
		Capture: in.Capture, Motion: in.Motion, Burst: in.Burst,
	}
	if err := request.Validate(); err != nil {
		return nil, mcpRecordingOutput{}, mcpToolError("invalid_arguments", err)
	}
	return s.mcpRecordingRequest(ctx, view.Session.TenantID, view.Session.ID, http.MethodPost, "/recordings", map[string]any{
		"mode": "tab", "targetId": in.TargetID, "fps": in.FPS, "bitrateKbps": in.BitrateKbps, "codec": in.Codec,
		"capture": in.Capture, "motion": in.Motion, "burst": in.Burst,
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
	return s.mcpRecordingStart(ctx, req, mcpRecordingStartInput{
		TenantID: a.tenantID, SessionID: a.sessionID, TargetID: in.TargetID, FPS: in.FPS, BitrateKbps: in.BitrateKbps, Codec: in.Codec,
		Capture: in.Capture, Motion: in.Motion, Burst: in.Burst,
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
		Capture: status.Capture,
	}
	if status.Motion != nil {
		output.Motion = status.Motion
	}
	if status.Burst != nil {
		burst := mcpBurstStatus(*status.Burst)
		output.Burst = &burst
	}
	return output, nil
}
