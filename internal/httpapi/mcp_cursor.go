package httpapi

import (
	"context"
	"net/http"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpCursorGetInput struct {
	TenantID  string `json:"tenantId,omitempty"`
	SessionID string `json:"sessionId"`
}

type mcpCursorSetInput struct {
	TenantID  string `json:"tenantId,omitempty"`
	SessionID string `json:"sessionId"`
	Visible   bool   `json:"visible"`
}

type mcpBoundCursorSetInput struct {
	Visible bool `json:"visible"`
}

func (s *Server) mcpCursorGet(ctx context.Context, _ *mcp.CallToolRequest, in mcpCursorGetInput) (*mcp.CallToolResult, cursorVisibility, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, cursorVisibility{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, false)
	if err != nil {
		return nil, cursorVisibility{}, err
	}
	visibility, err := s.sessionCursorVisibility(ctx, view.Session.TenantID, view.Session.ID, http.MethodGet, nil)
	if err != nil {
		return nil, cursorVisibility{}, mcpToolError("cursor_unavailable", err)
	}
	return nil, visibility, nil
}

func (s *Server) mcpCursorSet(ctx context.Context, _ *mcp.CallToolRequest, in mcpCursorSetInput) (*mcp.CallToolResult, cursorVisibility, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, cursorVisibility{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, cursorVisibility{}, err
	}
	visibility, err := s.sessionCursorVisibility(ctx, view.Session.TenantID, view.Session.ID, http.MethodPut, &in.Visible)
	if err != nil {
		return nil, cursorVisibility{}, mcpToolError("cursor_unavailable", err)
	}
	return nil, visibility, nil
}

func (s *Server) mcpBoundCursorGet(ctx context.Context, req *mcp.CallToolRequest, _ mcpSessionOnlyInput) (*mcp.CallToolResult, cursorVisibility, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, cursorVisibility{}, err
	}
	return s.mcpCursorGet(ctx, req, mcpCursorGetInput{TenantID: a.tenantID, SessionID: a.sessionID})
}

func (s *Server) mcpBoundCursorSet(ctx context.Context, req *mcp.CallToolRequest, in mcpBoundCursorSetInput) (*mcp.CallToolResult, cursorVisibility, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, cursorVisibility{}, err
	}
	return s.mcpCursorSet(ctx, req, mcpCursorSetInput{TenantID: a.tenantID, SessionID: a.sessionID, Visible: in.Visible})
}
