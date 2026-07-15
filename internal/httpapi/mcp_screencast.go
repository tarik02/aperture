package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type wrapperScreencastStatus struct {
	Active    bool   `json:"active"`
	Path      string `json:"path,omitempty"`
	StartedAt string `json:"startedAt,omitempty"`
	StoppedAt string `json:"stoppedAt,omitempty"`
	SizeBytes int64  `json:"sizeBytes,omitempty"`
	FPS       int    `json:"fps,omitempty"`
	Codec     string `json:"codec,omitempty"`
}

func (s *Server) mcpScreencastStart(ctx context.Context, _ *mcp.CallToolRequest, in mcpScreencastInput) (*mcp.CallToolResult, mcpScreencastOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpScreencastOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, mcpScreencastOutput{}, err
	}
	return s.mcpScreencastRequest(ctx, view.Session.TenantID, view.Session.ID, http.MethodPost, "/screencast/start", map[string]any{
		"fps": in.FPS, "bitrateKbps": in.BitrateKbps, "codec": in.Codec,
	}, false)
}

func (s *Server) mcpScreencastStatus(ctx context.Context, _ *mcp.CallToolRequest, in mcpSessionIDInput) (*mcp.CallToolResult, mcpScreencastOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpScreencastOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, mcpScreencastOutput{}, err
	}
	return s.mcpScreencastRequest(ctx, view.Session.TenantID, view.Session.ID, http.MethodGet, "/screencast/status", nil, false)
}

func (s *Server) mcpScreencastStop(ctx context.Context, _ *mcp.CallToolRequest, in mcpSessionIDInput) (*mcp.CallToolResult, mcpScreencastOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpScreencastOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, mcpScreencastOutput{}, err
	}
	return s.mcpScreencastRequest(ctx, view.Session.TenantID, view.Session.ID, http.MethodPost, "/screencast/stop", nil, true)
}

func (s *Server) mcpBoundScreencastStart(ctx context.Context, req *mcp.CallToolRequest, in mcpBoundScreencastInput) (*mcp.CallToolResult, mcpScreencastOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpScreencastOutput{}, err
	}
	return s.mcpScreencastStart(ctx, req, mcpScreencastInput{TenantID: a.tenantID, SessionID: a.sessionID, FPS: in.FPS, BitrateKbps: in.BitrateKbps, Codec: in.Codec})
}

func (s *Server) mcpBoundScreencastStatus(ctx context.Context, req *mcp.CallToolRequest, _ mcpSessionOnlyInput) (*mcp.CallToolResult, mcpScreencastOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpScreencastOutput{}, err
	}
	return s.mcpScreencastStatus(ctx, req, mcpSessionIDInput{TenantID: a.tenantID, SessionID: a.sessionID})
}

func (s *Server) mcpBoundScreencastStop(ctx context.Context, req *mcp.CallToolRequest, _ mcpSessionOnlyInput) (*mcp.CallToolResult, mcpScreencastOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpScreencastOutput{}, err
	}
	return s.mcpScreencastStop(ctx, req, mcpSessionIDInput{TenantID: a.tenantID, SessionID: a.sessionID})
}

func (s *Server) mcpScreencastRequest(ctx context.Context, tenantID, sessionID, method, path string, body any, stop bool) (*mcp.CallToolResult, mcpScreencastOutput, error) {
	port, release, err := s.Sessions.AcquireWrapperPort(ctx, tenantID, sessionID)
	if err != nil {
		return nil, mcpScreencastOutput{}, mcpToolError("session_unavailable", err)
	}
	defer release()
	var requestBody io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, mcpScreencastOutput{}, mcpToolError("internal", err)
		}
		requestBody = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), requestBody)
	if err != nil {
		return nil, mcpScreencastOutput{}, mcpToolError("internal", err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if stop {
		request.Header.Set("Range", "bytes=0-0")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, mcpScreencastOutput{}, mcpToolError("screencast_unavailable", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		return nil, mcpScreencastOutput{}, mcpToolError("screencast_unavailable", fmt.Errorf("wrapper returned %s: %s", response.Status, message))
	}
	if stop {
		return s.mcpScreencastRequest(ctx, tenantID, sessionID, http.MethodGet, "/screencast/status", nil, false)
	}
	var status wrapperScreencastStatus
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&status); err != nil {
		return nil, mcpScreencastOutput{}, mcpToolError("screencast_unavailable", err)
	}
	output := mcpScreencastOutput{Active: status.Active, StartedAt: status.StartedAt, StoppedAt: status.StoppedAt, SizeBytes: status.SizeBytes, FPS: status.FPS, Codec: status.Codec}
	if status.Path != "" {
		output.RelativePath = filepath.ToSlash(filepath.Join("recordings", filepath.Base(status.Path)))
	}
	return nil, output, nil
}
