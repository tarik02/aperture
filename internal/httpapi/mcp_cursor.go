package httpapi

import (
	"context"
	"net/http"

	"github.com/aperture/aperture/internal/pointer"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpCursorGetInput struct {
	TenantID  string `json:"tenantId,omitempty"`
	SessionID string `json:"sessionId"`
}

type mcpCursorSetInput struct {
	TenantID  string          `json:"tenantId,omitempty"`
	SessionID string          `json:"sessionId"`
	Visible   *bool           `json:"visible,omitempty"`
	Motion    *pointer.Motion `json:"motion,omitempty"`
}

type mcpBoundCursorSetInput struct {
	Visible *bool           `json:"visible,omitempty"`
	Motion  *pointer.Motion `json:"motion,omitempty"`
}

// The SDK infers tool schemas from Go types, which cannot express the motion
// setting's string-or-object form, so the cursor tools that carry it spell out
// their schemas.
func mcpCursorOutputSchema() map[string]any {
	return map[string]any{
		"type":     "object",
		"required": []any{"visible", "motion"},
		"properties": map[string]any{
			"visible": map[string]any{"type": "boolean", "description": "Whether the remote cursor is included in the live stream and recordings."},
			"motion":  mcpPointerMotionSchema("The session's default motion for pointer gestures; natural until set."),
		},
	}
}

func mcpCursorSetInputSchema(pathBound bool) map[string]any {
	properties := map[string]any{
		"visible": map[string]any{"type": "boolean", "description": "Whether to include the remote cursor in the live stream and recordings. Give visible, motion, or both."},
		"motion":  mcpPointerMotionSchema(`Default motion for the browser_click, browser_move and browser_drag tools in this session: "natural", "fast", "instant", {"speed": px/s} or {"durationMs": ms}. A tool's own motion parameter overrides it. It lasts until the session stops.`),
	}
	schema := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"properties":           properties,
		// Top-level anyOf/oneOf/allOf are avoided because many LLM clients reject
		// or mishandle them; the "at least one of visible and motion" rule is in
		// the description and enforced by cursorUpdate.Validate.
		"description": "Set at least one of visible and motion.",
	}
	if !pathBound {
		properties["tenantId"] = map[string]any{"type": "string"}
		properties["sessionId"] = map[string]any{"type": "string"}
		schema["required"] = []any{"sessionId"}
	}
	return schema
}

func (s *Server) mcpCursorGet(ctx context.Context, _ *mcp.CallToolRequest, in mcpCursorGetInput) (*mcp.CallToolResult, cursorSettings, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, cursorSettings{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, false)
	if err != nil {
		return nil, cursorSettings{}, err
	}
	settings, err := s.sessionCursorSettings(ctx, view.Session.TenantID, view.Session.ID, http.MethodGet, nil)
	if err != nil {
		return nil, cursorSettings{}, mcpToolError("cursor_unavailable", err)
	}
	return nil, settings, nil
}

func (s *Server) mcpCursorSet(ctx context.Context, _ *mcp.CallToolRequest, in mcpCursorSetInput) (*mcp.CallToolResult, cursorSettings, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, cursorSettings{}, err
	}
	update := cursorUpdate{Visible: in.Visible, Motion: in.Motion}
	if err := update.Validate(); err != nil {
		return nil, cursorSettings{}, mcpToolError("invalid_arguments", err)
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, cursorSettings{}, err
	}
	settings, err := s.sessionCursorSettings(ctx, view.Session.TenantID, view.Session.ID, http.MethodPut, &update)
	if err != nil {
		return nil, cursorSettings{}, mcpToolError("cursor_unavailable", err)
	}
	return nil, settings, nil
}

func (s *Server) mcpBoundCursorGet(ctx context.Context, req *mcp.CallToolRequest, _ mcpSessionOnlyInput) (*mcp.CallToolResult, cursorSettings, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, cursorSettings{}, err
	}
	return s.mcpCursorGet(ctx, req, mcpCursorGetInput{TenantID: a.tenantID, SessionID: a.sessionID})
}

func (s *Server) mcpBoundCursorSet(ctx context.Context, req *mcp.CallToolRequest, in mcpBoundCursorSetInput) (*mcp.CallToolResult, cursorSettings, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, cursorSettings{}, err
	}
	return s.mcpCursorSet(ctx, req, mcpCursorSetInput{TenantID: a.tenantID, SessionID: a.sessionID, Visible: in.Visible, Motion: in.Motion})
}
