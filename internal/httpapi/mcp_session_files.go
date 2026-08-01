package httpapi

import (
	"context"
	"errors"

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
	result, err := s.sessionFileDownloadURL(view.Session.ID, in.RelativePath, in.TTLSeconds)
	if errors.Is(err, errSessionFileNotFound) {
		return nil, mcpSessionFileURLOutput{}, mcpToolError("file_not_found", err)
	}
	if errors.Is(err, errValidation) {
		return nil, mcpSessionFileURLOutput{}, mcpToolError("invalid_arguments", err)
	}
	if err != nil {
		return nil, mcpSessionFileURLOutput{}, mcpToolError("internal", err)
	}
	return nil, mcpSessionFileURLOutput(result), nil
}

func (s *Server) mcpBoundSessionFileURL(ctx context.Context, req *mcp.CallToolRequest, in mcpBoundSessionFileInput) (*mcp.CallToolResult, mcpSessionFileURLOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpSessionFileURLOutput{}, err
	}
	return s.mcpSessionFileURL(ctx, req, mcpSessionFileInput{TenantID: a.tenantID, SessionID: a.sessionID, RelativePath: in.RelativePath, TTLSeconds: in.TTLSeconds})
}
