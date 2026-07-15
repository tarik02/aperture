package httpapi

import (
	"context"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/db"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpSnapshotNameInput struct {
	TenantID string `json:"tenantId,omitempty"`
	Name     string `json:"name"`
}

type mcpSnapshotUpdateInput struct {
	TenantID    string  `json:"tenantId,omitempty"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
}

type mcpSnapshotTagsInput struct {
	TenantID string            `json:"tenantId,omitempty"`
	Name     string            `json:"name"`
	Tags     map[string]string `json:"tags"`
}

type mcpSessionTagsInput struct {
	TenantID  string            `json:"tenantId,omitempty"`
	SessionID string            `json:"sessionId"`
	Tags      map[string]string `json:"tags"`
}

type mcpTenantIDInput struct {
	TenantID string `json:"tenantId"`
}

type mcpTenantUpdateInput struct {
	DisplayName string `json:"displayName"`
}

type mcpAdminTenantUpdateInput struct {
	TenantID    string `json:"tenantId"`
	DisplayName string `json:"displayName"`
}

type mcpTenantOutput struct {
	Tenant db.Tenant `json:"tenant"`
}

type mcpBrowserChannel struct {
	Name string `json:"name"`
}

type mcpBrowserChannelsOutput struct {
	Channels []mcpBrowserChannel `json:"channels"`
}

func (s *Server) mcpSnapshotUpdate(ctx context.Context, _ *mcp.CallToolRequest, in mcpSnapshotUpdateInput) (*mcp.CallToolResult, mcpSnapshotOutput, error) {
	if err := validateSnapshotName(in.Name); err != nil {
		return nil, mcpSnapshotOutput{}, mcpToolError("invalid_arguments", err)
	}
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpSnapshotOutput{}, err
	}
	tenantID, err := s.mcpTenant(a, in.TenantID, auth.ScopeSnapshotsWrite)
	if err != nil {
		return nil, mcpSnapshotOutput{}, err
	}
	view, err := s.Snapshots.UpdateDescription(ctx, tenantID, in.Name, in.Description)
	if err != nil {
		return nil, mcpSnapshotOutput{}, mcpToolError("snapshot_unavailable", err)
	}
	return nil, mcpSnapshotOutput{Snapshot: mcpSnapshotView(view)}, nil
}

func (s *Server) mcpSnapshotDelete(ctx context.Context, _ *mcp.CallToolRequest, in mcpSnapshotNameInput) (*mcp.CallToolResult, mcpSnapshotOutput, error) {
	if err := validateSnapshotName(in.Name); err != nil {
		return nil, mcpSnapshotOutput{}, mcpToolError("invalid_arguments", err)
	}
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpSnapshotOutput{}, err
	}
	tenantID, err := s.mcpTenant(a, in.TenantID, auth.ScopeSnapshotsWrite)
	if err != nil {
		return nil, mcpSnapshotOutput{}, err
	}
	view, err := s.Snapshots.Delete(ctx, tenantID, in.Name)
	if err != nil {
		return nil, mcpSnapshotOutput{}, mcpToolError("snapshot_unavailable", err)
	}
	return nil, mcpSnapshotOutput{Snapshot: mcpSnapshotView(view)}, nil
}

func (s *Server) mcpSnapshotReplaceTags(ctx context.Context, _ *mcp.CallToolRequest, in mcpSnapshotTagsInput) (*mcp.CallToolResult, mcpSnapshotOutput, error) {
	if err := validateSnapshotName(in.Name); err != nil {
		return nil, mcpSnapshotOutput{}, mcpToolError("invalid_arguments", err)
	}
	if err := (replaceTagsRequest{Tags: in.Tags}).Validate(); err != nil {
		return nil, mcpSnapshotOutput{}, mcpToolError("invalid_arguments", err)
	}
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpSnapshotOutput{}, err
	}
	tenantID, err := s.mcpTenant(a, in.TenantID, auth.ScopeSnapshotsWrite)
	if err != nil {
		return nil, mcpSnapshotOutput{}, err
	}
	view, err := s.Snapshots.ReplaceTags(ctx, tenantID, in.Name, in.Tags)
	if err != nil {
		return nil, mcpSnapshotOutput{}, mcpToolError("snapshot_unavailable", err)
	}
	return nil, mcpSnapshotOutput{Snapshot: mcpSnapshotView(view)}, nil
}

func (s *Server) mcpSnapshotRestore(ctx context.Context, _ *mcp.CallToolRequest, in mcpSnapshotNameInput) (*mcp.CallToolResult, mcpSnapshotOutput, error) {
	if err := validateSnapshotName(in.Name); err != nil {
		return nil, mcpSnapshotOutput{}, mcpToolError("invalid_arguments", err)
	}
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpSnapshotOutput{}, err
	}
	tenantID, err := s.mcpTenant(a, in.TenantID, auth.ScopeSnapshotsWrite)
	if err != nil {
		return nil, mcpSnapshotOutput{}, err
	}
	view, err := s.Snapshots.Restore(ctx, tenantID, in.Name)
	if err != nil {
		return nil, mcpSnapshotOutput{}, mcpToolError("snapshot_unavailable", err)
	}
	return nil, mcpSnapshotOutput{Snapshot: mcpSnapshotView(view)}, nil
}

func (s *Server) mcpSessionReopen(ctx context.Context, _ *mcp.CallToolRequest, in mcpSessionIDInput) (*mcp.CallToolResult, mcpStatusOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpStatusOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, mcpStatusOutput{}, err
	}
	updated, err := s.Sessions.Reopen(ctx, view.Session.TenantID, view.Session.ID)
	if err != nil {
		return nil, mcpStatusOutput{}, mcpToolError("session_unavailable", err)
	}
	return nil, mcpStatusOutput{Session: mcpSessionView(updated)}, nil
}

func (s *Server) mcpSessionReplaceTags(ctx context.Context, _ *mcp.CallToolRequest, in mcpSessionTagsInput) (*mcp.CallToolResult, mcpStatusOutput, error) {
	if err := (replaceTagsRequest{Tags: in.Tags}).Validate(); err != nil {
		return nil, mcpStatusOutput{}, mcpToolError("invalid_arguments", err)
	}
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpStatusOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, mcpStatusOutput{}, err
	}
	updated, err := s.Sessions.ReplaceTags(ctx, view.Session.TenantID, view.Session.ID, in.Tags)
	if err != nil {
		return nil, mcpStatusOutput{}, mcpToolError("session_unavailable", err)
	}
	return nil, mcpStatusOutput{Session: mcpSessionView(updated)}, nil
}

func (s *Server) mcpTenantGet(ctx context.Context, _ *mcp.CallToolRequest, _ mcpSessionOnlyInput) (*mcp.CallToolResult, mcpTenantOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpTenantOutput{}, err
	}
	if a.principal == nil || a.principal.AuthorityType != auth.AuthorityTenant || a.principal.TenantID == nil || !auth.HasScope(a.principal.Scopes, auth.ScopeTenantWrite) {
		return nil, mcpTenantOutput{}, mcpToolError("forbidden", nil)
	}
	tenant, err := s.Auth.RequireActiveTenant(ctx, *a.principal.TenantID)
	if err != nil {
		return nil, mcpTenantOutput{}, mcpToolError("tenant_not_found", err)
	}
	return nil, mcpTenantOutput{Tenant: *tenant}, nil
}

func (s *Server) mcpTenantUpdate(ctx context.Context, _ *mcp.CallToolRequest, in mcpTenantUpdateInput) (*mcp.CallToolResult, mcpTenantOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpTenantOutput{}, err
	}
	if a.principal == nil || a.principal.AuthorityType != auth.AuthorityTenant || a.principal.TenantID == nil || !auth.HasScope(a.principal.Scopes, auth.ScopeTenantWrite) {
		return nil, mcpTenantOutput{}, mcpToolError("forbidden", nil)
	}
	tenant, err := s.Auth.UpdateTenant(ctx, *a.principal.TenantID, auth.UpdateTenantInput{DisplayName: in.DisplayName})
	if err != nil {
		return nil, mcpTenantOutput{}, mcpToolError("invalid_arguments", err)
	}
	return nil, mcpTenantOutput{Tenant: *tenant}, nil
}

func (s *Server) mcpTenantsUpdate(ctx context.Context, _ *mcp.CallToolRequest, in mcpAdminTenantUpdateInput) (*mcp.CallToolResult, mcpTenantOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpTenantOutput{}, err
	}
	if a.principal == nil || a.principal.AuthorityType != auth.AuthoritySystemAdmin || !auth.HasScope(a.principal.Scopes, auth.ScopeTenantsWrite) {
		return nil, mcpTenantOutput{}, mcpToolError("forbidden", nil)
	}
	tenant, err := s.Auth.UpdateTenant(ctx, in.TenantID, auth.UpdateTenantInput{DisplayName: in.DisplayName})
	if err != nil {
		return nil, mcpTenantOutput{}, mcpToolError("invalid_arguments", err)
	}
	return nil, mcpTenantOutput{Tenant: *tenant}, nil
}

func (s *Server) mcpTenantsDelete(ctx context.Context, _ *mcp.CallToolRequest, in mcpTenantIDInput) (*mcp.CallToolResult, mcpTenantOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpTenantOutput{}, err
	}
	if a.principal == nil || a.principal.AuthorityType != auth.AuthoritySystemAdmin || !auth.HasScope(a.principal.Scopes, auth.ScopeTenantsWrite) {
		return nil, mcpTenantOutput{}, mcpToolError("forbidden", nil)
	}
	tenant, err := s.Auth.DeleteTenant(ctx, in.TenantID)
	if err != nil {
		return nil, mcpTenantOutput{}, mcpToolError("tenant_not_found", err)
	}
	return nil, mcpTenantOutput{Tenant: *tenant}, nil
}

func (s *Server) mcpTenantsRestore(ctx context.Context, _ *mcp.CallToolRequest, in mcpTenantIDInput) (*mcp.CallToolResult, mcpTenantOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpTenantOutput{}, err
	}
	if a.principal == nil || a.principal.AuthorityType != auth.AuthoritySystemAdmin || !auth.HasScope(a.principal.Scopes, auth.ScopeTenantsWrite) {
		return nil, mcpTenantOutput{}, mcpToolError("forbidden", nil)
	}
	tenant, err := s.Auth.RestoreTenant(ctx, in.TenantID)
	if err != nil {
		return nil, mcpTenantOutput{}, mcpToolError("tenant_not_found", err)
	}
	return nil, mcpTenantOutput{Tenant: *tenant}, nil
}

func (s *Server) mcpBrowserChannels(ctx context.Context, _ *mcp.CallToolRequest, _ mcpSessionOnlyInput) (*mcp.CallToolResult, mcpBrowserChannelsOutput, error) {
	if s.Channels == nil {
		return nil, mcpBrowserChannelsOutput{}, mcpToolError("internal", errChannelsUnavailable)
	}
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpBrowserChannelsOutput{}, err
	}
	if a.principal == nil || !auth.HasScope(a.principal.Scopes, auth.ScopeSessionsRead) {
		return nil, mcpBrowserChannelsOutput{}, mcpToolError("forbidden", nil)
	}
	names := s.Channels.Names()
	out := mcpBrowserChannelsOutput{Channels: make([]mcpBrowserChannel, 0, len(names))}
	for _, name := range names {
		out.Channels = append(out.Channels, mcpBrowserChannel{Name: name})
	}
	return nil, out, nil
}
