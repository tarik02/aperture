package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type wrapperRecordingStatus struct {
	RecordingID       string                  `json:"recordingId"`
	Mode              string                  `json:"mode"`
	TargetID          string                  `json:"targetId"`
	CaptureGeneration uint64                  `json:"captureGeneration"`
	Status            string                  `json:"status"`
	StopReason        string                  `json:"stopReason,omitempty"`
	Path              string                  `json:"path"`
	StartedAt         string                  `json:"startedAt"`
	StoppedAt         string                  `json:"stoppedAt,omitempty"`
	SizeBytes         int64                   `json:"sizeBytes,omitempty"`
	FPS               int                     `json:"fps"`
	BitrateKbps       int                     `json:"bitrateKbps"`
	Codec             string                  `json:"codec"`
	CDP               *mcpCDPRecordingOptions `json:"cdp,omitempty"`
	AcceptedFrames    uint64                  `json:"acceptedFrames,omitempty"`
	DroppedFrames     uint64                  `json:"droppedFrames,omitempty"`
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
		"mode": "tab", "targetId": in.TargetID, "fps": in.FPS, "bitrateKbps": in.BitrateKbps, "codec": in.Codec, "cdp": in.CDP,
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

func (s *Server) mcpBoundRecordingStart(ctx context.Context, req *mcp.CallToolRequest, in mcpBoundRecordingStartInput) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	return s.mcpRecordingStart(ctx, req, mcpRecordingStartInput{TenantID: a.tenantID, SessionID: a.sessionID, TargetID: in.TargetID, FPS: in.FPS, BitrateKbps: in.BitrateKbps, Codec: in.Codec, CDP: in.CDP})
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

func (s *Server) mcpRecordingRequest(ctx context.Context, tenantID, sessionID, method, path string, body any, stop bool) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	port, release, err := s.Sessions.AcquireWrapperPort(ctx, tenantID, sessionID)
	if err != nil {
		return nil, mcpRecordingOutput{}, mcpToolError("session_unavailable", err)
	}
	defer release()
	var requestBody io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, mcpRecordingOutput{}, mcpToolError("internal", err)
		}
		requestBody = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), requestBody)
	if err != nil {
		return nil, mcpRecordingOutput{}, mcpToolError("internal", err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if stop {
		request.Header.Set("Range", "bytes=0-0")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, mcpRecordingOutput{}, mcpToolError("recording_unavailable", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		return nil, mcpRecordingOutput{}, mcpToolError("recording_unavailable", fmt.Errorf("wrapper returned %s: %s", response.Status, message))
	}
	if stop {
		return nil, mcpRecordingOutput{}, nil
	}
	var status wrapperRecordingStatus
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&status); err != nil {
		return nil, mcpRecordingOutput{}, mcpToolError("recording_unavailable", err)
	}
	return nil, mcpRecordingOutputFromStatus(status), nil
}

func (s *Server) mcpRecordingsRequest(ctx context.Context, tenantID, sessionID string) (*mcp.CallToolResult, mcpRecordingsOutput, error) {
	port, release, err := s.Sessions.AcquireWrapperPort(ctx, tenantID, sessionID)
	if err != nil {
		return nil, mcpRecordingsOutput{}, mcpToolError("session_unavailable", err)
	}
	defer release()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/recordings", port), nil)
	if err != nil {
		return nil, mcpRecordingsOutput{}, mcpToolError("internal", err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, mcpRecordingsOutput{}, mcpToolError("recording_unavailable", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		return nil, mcpRecordingsOutput{}, mcpToolError("recording_unavailable", fmt.Errorf("wrapper returned %s: %s", response.Status, message))
	}
	var statuses []wrapperRecordingStatus
	if err := json.NewDecoder(io.LimitReader(response.Body, 1024*1024)).Decode(&statuses); err != nil {
		return nil, mcpRecordingsOutput{}, mcpToolError("recording_unavailable", err)
	}
	output := mcpRecordingsOutput{Recordings: make([]mcpRecordingOutput, 0, len(statuses))}
	for _, status := range statuses {
		output.Recordings = append(output.Recordings, mcpRecordingOutputFromStatus(status))
	}
	return nil, output, nil
}

func mcpRecordingOutputFromStatus(status wrapperRecordingStatus) mcpRecordingOutput {
	output := mcpRecordingOutput{
		RecordingID: status.RecordingID, Mode: status.Mode, TargetID: status.TargetID, CaptureGeneration: status.CaptureGeneration,
		Status: status.Status, StopReason: status.StopReason, StartedAt: status.StartedAt, StoppedAt: status.StoppedAt,
		SizeBytes: status.SizeBytes, FPS: status.FPS, BitrateKbps: status.BitrateKbps, Codec: status.Codec,
		CDP: status.CDP, AcceptedFrames: status.AcceptedFrames, DroppedFrames: status.DroppedFrames,
	}
	if status.Path != "" {
		output.RelativePath = filepath.ToSlash(filepath.Join("recordings", filepath.Base(status.Path)))
	}
	return output
}
