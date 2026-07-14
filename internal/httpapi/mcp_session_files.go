package httpapi

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/sessionfiles"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func (s *Server) mcpSessionFilesList(ctx context.Context, _ *mcp.CallToolRequest, in mcpSessionFilesInput) (*mcp.CallToolResult, mcpSessionFilesOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpSessionFilesOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, false)
	if err != nil {
		return nil, mcpSessionFilesOutput{}, err
	}
	layout, err := paths.Session(s.Config, view.Session.ID)
	if err != nil {
		return nil, mcpSessionFilesOutput{}, mcpToolError("internal", err)
	}
	files, err := sessionfiles.List(layout)
	if err != nil {
		return nil, mcpSessionFilesOutput{}, mcpToolError("internal", err)
	}
	out := mcpSessionFilesOutput{Files: make([]mcpSessionFile, 0, len(files))}
	for _, file := range files {
		out.Files = append(out.Files, mcpSessionFile{Name: file.Name, RelativePath: file.RelativePath, Size: file.Size, ModifiedAt: file.ModifiedAt, MIMEType: file.MIMEType})
	}
	return nil, out, nil
}

func (s *Server) mcpBoundSessionFilesList(ctx context.Context, req *mcp.CallToolRequest, _ mcpSessionOnlyInput) (*mcp.CallToolResult, mcpSessionFilesOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpSessionFilesOutput{}, err
	}
	return s.mcpSessionFilesList(ctx, req, mcpSessionFilesInput{TenantID: a.tenantID, SessionID: a.sessionID})
}

func (s *Server) mcpSessionFileURL(ctx context.Context, _ *mcp.CallToolRequest, in mcpSessionFileInput) (*mcp.CallToolResult, mcpSessionFileURLOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpSessionFileURLOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, false)
	if err != nil {
		return nil, mcpSessionFileURLOutput{}, err
	}
	layout, err := paths.Session(s.Config, view.Session.ID)
	if err != nil {
		return nil, mcpSessionFileURLOutput{}, mcpToolError("internal", err)
	}
	_, normalized, err := sessionfiles.Resolve(layout, in.RelativePath)
	if err != nil {
		return nil, mcpSessionFileURLOutput{}, mcpToolError("file_not_found", err)
	}
	ttl := s.Config.SignedFileURLTTL
	if in.TTLSeconds > 0 {
		maxSeconds := s.Config.SignedFileURLMaxTTL / time.Second
		if int64(in.TTLSeconds) > int64(maxSeconds) {
			return nil, mcpSessionFileURLOutput{}, mcpToolError("invalid_arguments", errors.New("ttl exceeds configured maximum"))
		}
		ttl = time.Duration(in.TTLSeconds) * time.Second
	}
	if ttl <= 0 || ttl > s.Config.SignedFileURLMaxTTL {
		return nil, mcpSessionFileURLOutput{}, mcpToolError("invalid_arguments", errors.New("ttl exceeds configured maximum"))
	}
	expiresAt := time.Now().UTC().Add(ttl)
	token, err := sessionfiles.IssueToken(s.jobToken, view.Session.ID, normalized, expiresAt)
	if err != nil {
		return nil, mcpSessionFileURLOutput{}, mcpToolError("internal", err)
	}
	base := strings.TrimRight(s.Config.ExternalBaseURL, "/")
	if base == "" {
		return nil, mcpSessionFileURLOutput{}, mcpToolError("internal", errors.New("external base url is required"))
	}
	parts := strings.Split(normalized, "/")
	escaped := make([]string, len(parts))
	for i, part := range parts {
		escaped[i] = url.PathEscape(part)
	}
	return nil, mcpSessionFileURLOutput{URL: base + "/sessions/" + url.PathEscape(view.Session.ID) + "/files/" + strings.Join(escaped, "/") + "?token=" + url.QueryEscape(token), ExpiresAt: expiresAt}, nil
}

func (s *Server) mcpBoundSessionFileURL(ctx context.Context, req *mcp.CallToolRequest, in mcpBoundSessionFileInput) (*mcp.CallToolResult, mcpSessionFileURLOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpSessionFileURLOutput{}, err
	}
	return s.mcpSessionFileURL(ctx, req, mcpSessionFileInput{TenantID: a.tenantID, SessionID: a.sessionID, RelativePath: in.RelativePath, TTLSeconds: in.TTLSeconds})
}
