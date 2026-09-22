package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpBrowserTarget struct {
	TargetID string `json:"targetId"`
	State    string `json:"state"`
	Title    string `json:"title"`
	URL      string `json:"url"`
}

type mcpBrowserTargetsOutput struct {
	Targets []mcpBrowserTarget `json:"targets"`
}

func (s *Server) mcpBrowserTargets(ctx context.Context, _ *mcp.CallToolRequest, in mcpSessionIDInput) (*mcp.CallToolResult, mcpBrowserTargetsOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpBrowserTargetsOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, false)
	if err != nil {
		return nil, mcpBrowserTargetsOutput{}, err
	}
	output, err := s.mcpBrowserTargetsForSession(ctx, view.Session.TenantID, view.Session.ID)
	if err != nil {
		return nil, mcpBrowserTargetsOutput{}, mcpToolError("browser_targets_unavailable", err)
	}
	return nil, output, nil
}

func (s *Server) mcpBoundBrowserTargets(ctx context.Context, req *mcp.CallToolRequest, _ mcpSessionOnlyInput) (*mcp.CallToolResult, mcpBrowserTargetsOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpBrowserTargetsOutput{}, err
	}
	return s.mcpBrowserTargets(ctx, req, mcpSessionIDInput{TenantID: a.tenantID, SessionID: a.sessionID})
}

func (s *Server) mcpBrowserTargetsForSession(ctx context.Context, tenantID, sessionID string) (mcpBrowserTargetsOutput, error) {
	port, release, err := s.Sessions.AcquireWrapperPort(ctx, tenantID, sessionID)
	if err != nil {
		return mcpBrowserTargetsOutput{}, err
	}
	defer release()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/targets", port), nil)
	if err != nil {
		return mcpBrowserTargetsOutput{}, fmt.Errorf("create browser targets request: %w", err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return mcpBrowserTargetsOutput{}, fmt.Errorf("request browser targets: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		return mcpBrowserTargetsOutput{}, fmt.Errorf("browser targets returned %s: %s", response.Status, message)
	}

	output := mcpBrowserTargetsOutput{Targets: make([]mcpBrowserTarget, 0)}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1024*1024)).Decode(&output.Targets); err != nil {
		return mcpBrowserTargetsOutput{}, fmt.Errorf("decode browser targets: %w", err)
	}
	sort.Slice(output.Targets, func(left, right int) bool {
		return output.Targets[left].TargetID < output.Targets[right].TargetID
	})
	return output, nil
}
