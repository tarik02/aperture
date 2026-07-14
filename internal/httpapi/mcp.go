package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/agentbrowser"
	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/event"
	"github.com/aperture/aperture/internal/session"
	"github.com/aperture/aperture/internal/snapshot"
	"github.com/gin-gonic/gin"
	mcpauth "github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpAuth struct {
	profiles    []string
	principal   *auth.Principal
	sessionID   string
	tenantID    string
	expiration  time.Time
	pathBound   bool
	sessionOnly bool
}

type mcpContextKey struct{}

func withMCPAuth(ctx context.Context, value mcpAuth) context.Context {
	return context.WithValue(ctx, mcpContextKey{}, value)
}

func mcpAuthFromContext(ctx context.Context) (mcpAuth, error) {
	value, ok := ctx.Value(mcpContextKey{}).(mcpAuth)
	if !ok {
		return mcpAuth{}, errors.New("unauthorized")
	}
	return value, nil
}

func (s *Server) initMCPHandler() {
	if !s.Config.MCPEnabled || s.mcpHandler != nil {
		return
	}
	s.agentBrowser = agentbrowser.NewManager(s.Config.AgentBrowserIdleTimeout, s.Logger)
	if s.Sessions != nil {
		s.Sessions.SetMediaSessionCleaner(s.agentBrowser)
	}
	if s.GC != nil {
		s.GC.SetMediaSessionCleaner(s.agentBrowser)
	}
	streamable := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		authn, ok := r.Context().Value(mcpContextKey{}).(mcpAuth)
		if !ok {
			return nil
		}
		return s.newMCPServer(authn)
	}, &mcp.StreamableHTTPOptions{JSONResponse: true})
	s.mcpHandler = mcpauth.RequireBearerToken(func(ctx context.Context, _ string, r *http.Request) (*mcpauth.TokenInfo, error) {
		authn, err := s.authenticateMCP(r)
		if err != nil {
			return nil, fmt.Errorf("invalid bearer token: %w", err)
		}
		return &mcpauth.TokenInfo{UserID: mcpIdentity(authn), Expiration: authn.expiration}, nil
	}, nil)(streamable)
}

func (s *Server) mcp(c *gin.Context) {
	if !s.Config.MCPEnabled {
		c.Status(http.StatusNotFound)
		return
	}
	if err := s.validateMCPProfile(c.Request); err != nil {
		mcpHTTPError(c, http.StatusBadRequest, err)
		return
	}
	authn, err := s.authenticateMCP(c.Request)
	if err != nil {
		mcpHTTPError(c, http.StatusUnauthorized, err)
		return
	}
	profileValue := strings.TrimSpace(c.Request.URL.Query().Get("agentBrowserTools"))
	if profileValue == "" {
		profileValue = s.Config.AgentBrowserToolsDefault
	}
	profiles, err := agentbrowser.ParseProfiles(profileValue)
	if err != nil {
		mcpHTTPError(c, http.StatusBadRequest, fmt.Errorf("invalid_profile: %w", err))
		return
	}
	authn.profiles = profiles
	request := c.Request.WithContext(withMCPAuth(c.Request.Context(), authn))
	if s.Config.ToolOutputMaxBytes > 0 {
		request.Body = http.MaxBytesReader(c.Writer, request.Body, s.Config.ToolOutputMaxBytes)
	}
	s.mcpHandler.ServeHTTP(&mcpCapResponseWriter{ResponseWriter: c.Writer, maxBytes: s.Config.ToolOutputMaxBytes}, request)
}

var mcpNonExpiringExpiration = time.Date(9999, time.December, 31, 23, 59, 59, 0, time.UTC)

func mcpCredentialExpiration(raw *string) time.Time {
	if raw == nil {
		return mcpNonExpiringExpiration
	}
	expiration, err := time.Parse(time.RFC3339Nano, *raw)
	if err != nil {
		return time.Time{}
	}
	return expiration
}

func mcpIdentity(value mcpAuth) string {
	if value.principal != nil {
		return "api-token:" + value.principal.TokenID
	}
	return "session-token:" + value.sessionID
}

func (s *Server) validateMCPProfile(r *http.Request) error {
	profile := strings.TrimSpace(r.URL.Query().Get("agentBrowserTools"))
	if profile == "" {
		return nil
	}
	if _, err := agentbrowser.ParseProfiles(profile); err != nil {
		return fmt.Errorf("invalid_profile: %w", err)
	}
	return nil
}

func (s *Server) authenticateMCP(r *http.Request) (mcpAuth, error) {
	raw, ok := rawTokenFromAuthorization(r.Header.Get("Authorization"))
	if !ok {
		return mcpAuth{}, errors.New("unauthorized")
	}
	pathSessionID := ""
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) == 3 && parts[0] == "sessions" && parts[2] == "mcp" {
		pathSessionID = parts[1]
	}
	if pathSessionID == "" {
		principal, err := s.Auth.Authenticate(r.Context(), raw)
		if err != nil {
			return mcpAuth{}, errors.New("unauthorized")
		}
		return mcpAuth{principal: &principal, expiration: mcpCredentialExpiration(principal.ExpiresAt)}, nil
	}

	principal, apiErr := s.Auth.Authenticate(r.Context(), raw)
	if apiErr == nil {
		if s.Repository == nil {
			return mcpAuth{}, errors.New("session_unavailable")
		}
		row, err := s.Repository.GetSessionByID(r.Context(), pathSessionID)
		if err != nil {
			return mcpAuth{}, errors.New("internal")
		}
		if row == nil {
			return mcpAuth{}, errors.New("session_not_found")
		}
		tenantID, err := auth.ResolveTenantID(principal, row.TenantID)
		if err != nil {
			return mcpAuth{}, errors.New("forbidden")
		}
		return mcpAuth{principal: &principal, sessionID: pathSessionID, tenantID: tenantID, expiration: mcpCredentialExpiration(principal.ExpiresAt), pathBound: true}, nil
	}

	if s.Sessions == nil {
		return mcpAuth{}, errors.New("session_unavailable")
	}
	sessionAuth, err := s.Sessions.AuthenticateSessionToken(r.Context(), pathSessionID, "Bearer "+raw)
	if err != nil {
		if errors.Is(err, session.ErrNotFound) {
			return mcpAuth{}, errors.New("session_not_found")
		}
		return mcpAuth{}, errors.New("unauthorized")
	}
	return mcpAuth{sessionID: pathSessionID, tenantID: sessionAuth.TenantID, expiration: mcpCredentialExpiration(&sessionAuth.Session.ExpiresAt), pathBound: true, sessionOnly: true}, nil
}

type mcpCapResponseWriter struct {
	http.ResponseWriter
	maxBytes int64
	written  int64
}

func (w *mcpCapResponseWriter) Write(data []byte) (int, error) {
	if w.maxBytes > 0 && w.written+int64(len(data)) > w.maxBytes {
		if w.written == 0 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusRequestEntityTooLarge)
		}
		return 0, errors.New("mcp output exceeds configured limit")
	}
	n, err := w.ResponseWriter.Write(data)
	w.written += int64(n)
	return n, err
}

func (w *mcpCapResponseWriter) Flush() {
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func mcpHTTPError(c *gin.Context, status int, err error) {
	c.Header("Content-Type", "application/json")
	c.JSON(status, map[string]string{"code": err.Error()})
}

func mcpToolError(code string, err error) error {
	if err == nil {
		return errors.New(code)
	}
	return fmt.Errorf("%s: %w", code, err)
}

func mcpPageParams(cursor string, limit int) db.PageParams {
	return db.PageParams{Cursor: cursor, Limit: limit}
}

type mcpSnapshot struct {
	ID                    string            `json:"id"`
	Name                  string            `json:"name"`
	Description           *string           `json:"description,omitempty"`
	TenantID              string            `json:"tenantId"`
	ParentSnapshotID      *string           `json:"parentSnapshotId,omitempty"`
	PromotedFromSessionID *string           `json:"promotedFromSessionId,omitempty"`
	CreatedAt             string            `json:"createdAt"`
	DeletedAt             *string           `json:"deletedAt,omitempty"`
	ExpiresAt             *string           `json:"expiresAt,omitempty"`
	Tags                  map[string]string `json:"tags,omitempty"`
}

type mcpSession struct {
	ID               string            `json:"sessionId"`
	TenantID         string            `json:"tenantId"`
	Status           string            `json:"status"`
	BaseSnapshotName *string           `json:"baseSnapshotName,omitempty"`
	Label            *string           `json:"label,omitempty"`
	BrowserChannel   string            `json:"browserChannel"`
	CDPURL           string            `json:"cdpUrl,omitempty"`
	SessionToken     string            `json:"sessionToken,omitempty"`
	CreatedAt        string            `json:"createdAt"`
	StartedAt        *string           `json:"startedAt,omitempty"`
	StoppedAt        *string           `json:"stoppedAt,omitempty"`
	DeletedAt        *string           `json:"deletedAt,omitempty"`
	ExpiresAt        string            `json:"expiresAt"`
	LastConnectedAt  *string           `json:"lastConnectedAt,omitempty"`
	SuspendedAt      *string           `json:"suspendedAt,omitempty"`
	Tags             map[string]string `json:"tags,omitempty"`
	Media            sessionMedia      `json:"media"`
}

func mcpSessionView(view *session.SessionView) mcpSession {
	return mcpSession{ID: view.Session.ID, TenantID: view.Session.TenantID, Status: view.Session.Status, BaseSnapshotName: view.BaseSnapshotName, Label: view.Session.Label, BrowserChannel: view.Session.BrowserChannel, CDPURL: view.CDPURL, SessionToken: view.SessionToken, CreatedAt: view.Session.CreatedAt, StartedAt: view.Session.StartedAt, StoppedAt: view.Session.StoppedAt, DeletedAt: view.Session.DeletedAt, ExpiresAt: view.Session.ExpiresAt, LastConnectedAt: view.Session.LastConnectedAt, SuspendedAt: view.Session.SuspendedAt, Tags: view.Tags, Media: sessionMedia{Mode: view.Media.Mode, WebRTCProducer: view.Media.WebRTCProducer, ICEServers: toICEServerResponses(view.Media.ICEServers)}}
}

func mcpSnapshotView(view *snapshot.SnapshotView) mcpSnapshot {
	return mcpSnapshot{ID: view.Snapshot.ID, Name: view.Snapshot.Name, Description: view.Snapshot.Description, TenantID: view.Snapshot.TenantID, ParentSnapshotID: view.Snapshot.ParentSnapshotID, PromotedFromSessionID: view.Snapshot.PromotedFromSessionID, CreatedAt: view.Snapshot.CreatedAt, DeletedAt: view.Snapshot.DeletedAt, ExpiresAt: view.Snapshot.ExpiresAt, Tags: view.Tags}
}

type mcpListSnapshotsInput struct {
	TenantID       string `json:"tenantId"`
	Cursor         string `json:"cursor,omitempty"`
	Limit          int    `json:"limit,omitempty"`
	IncludeDeleted bool   `json:"includeDeleted,omitempty"`
}
type mcpListSnapshotsOutput struct {
	Data []mcpSnapshot `json:"data"`
	Meta db.PageMeta   `json:"meta"`
}
type mcpGetSnapshotInput struct {
	TenantID string `json:"tenantId"`
	Name     string `json:"name"`
}
type mcpCreateSessionInput struct {
	TenantID         string            `json:"tenantId"`
	BaseSnapshotName *string           `json:"baseSnapshotName,omitempty"`
	Label            *string           `json:"label,omitempty"`
	BrowserChannel   string            `json:"browserChannel"`
	BrowserArgs      []string          `json:"browserArgs,omitempty"`
	Tags             map[string]string `json:"tags,omitempty"`
}
type mcpCreateFromSnapshotInput struct {
	TenantID       string            `json:"tenantId"`
	SnapshotName   string            `json:"snapshotName"`
	Label          *string           `json:"label,omitempty"`
	BrowserChannel string            `json:"browserChannel"`
	BrowserArgs    []string          `json:"browserArgs,omitempty"`
	Tags           map[string]string `json:"tags,omitempty"`
}
type mcpCreateSessionOutput struct {
	Session      mcpSession `json:"session"`
	SessionID    string     `json:"sessionId"`
	Status       string     `json:"status"`
	CDPURL       string     `json:"cdpUrl"`
	SessionToken string     `json:"sessionToken"`
}
type mcpGetSessionInput struct {
	TenantID  string `json:"tenantId"`
	SessionID string `json:"sessionId"`
}
type mcpListSessionsInput struct {
	TenantID       string `json:"tenantId"`
	Cursor         string `json:"cursor,omitempty"`
	Limit          int    `json:"limit,omitempty"`
	IncludeDeleted bool   `json:"includeDeleted,omitempty"`
}
type mcpListSessionsOutput struct {
	Data []mcpSession `json:"data"`
	Meta db.PageMeta  `json:"meta"`
}
type mcpBulkSessionsInput struct {
	TenantID   string   `json:"tenantId"`
	SessionIDs []string `json:"sessionIds"`
}
type mcpBulkSessionsOutput struct {
	Sessions []mcpSession `json:"sessions"`
}
type mcpSessionOnlyInput struct{}
type mcpSessionIDInput struct {
	TenantID  string `json:"tenantId,omitempty"`
	SessionID string `json:"sessionId"`
}
type mcpPromoteInput struct {
	TenantID    string            `json:"tenantId,omitempty"`
	SessionID   string            `json:"sessionId,omitempty"`
	Name        string            `json:"name"`
	Description *string           `json:"description,omitempty"`
	Force       bool              `json:"force,omitempty"`
	Tags        map[string]string `json:"tags,omitempty"`
}
type mcpBoundPromoteInput struct {
	Name        string            `json:"name"`
	Description *string           `json:"description,omitempty"`
	Force       bool              `json:"force,omitempty"`
	Tags        map[string]string `json:"tags,omitempty"`
}
type mcpPromoteOutput struct {
	Snapshot mcpSnapshot `json:"snapshot"`
}
type mcpListEventsInput struct {
	TenantID     string  `json:"tenantId"`
	ResourceType *string `json:"resourceType,omitempty"`
	ResourceID   *string `json:"resourceId,omitempty"`
	Cursor       string  `json:"cursor,omitempty"`
	Limit        int     `json:"limit,omitempty"`
}
type mcpListEventsOutput struct {
	Data []db.Event  `json:"data"`
	Meta db.PageMeta `json:"meta"`
}
type mcpListTenantsInput struct {
	Cursor         string `json:"cursor,omitempty"`
	Limit          int    `json:"limit,omitempty"`
	IncludeDeleted bool   `json:"includeDeleted,omitempty"`
}
type mcpListTenantsOutput struct {
	Data []db.Tenant `json:"data"`
	Meta db.PageMeta `json:"meta"`
}
type mcpCreateTenantInput struct {
	DisplayName string `json:"displayName"`
}
type mcpCreateTenantOutput struct {
	Tenant db.Tenant `json:"tenant"`
}
type mcpCreateTokenInput struct {
	AuthorityType string   `json:"authorityType"`
	TenantID      *string  `json:"tenantId,omitempty"`
	Name          string   `json:"name"`
	Scopes        []string `json:"scopes"`
	ExpiresAt     *string  `json:"expiresAt,omitempty"`
}
type mcpCreateTokenOutput struct {
	Token    mcpToken `json:"token"`
	RawToken string   `json:"rawToken"`
}
type mcpRevokeTokenInput struct {
	TokenID  string  `json:"tokenId"`
	TenantID *string `json:"tenantId,omitempty"`
}
type mcpRevokeTokenOutput struct {
	Revoked bool `json:"revoked"`
}

type mcpListTokensInput struct {
	TenantID *string `json:"tenantId,omitempty"`
	Cursor   string  `json:"cursor,omitempty"`
	Limit    int     `json:"limit,omitempty"`
}
type mcpToken struct {
	ID            string   `json:"id"`
	AuthorityType string   `json:"authorityType"`
	TenantID      *string  `json:"tenantId,omitempty"`
	Name          string   `json:"name"`
	Scopes        []string `json:"scopes"`
	CreatedAt     string   `json:"createdAt"`
	ExpiresAt     *string  `json:"expiresAt,omitempty"`
	RevokedAt     *string  `json:"revokedAt,omitempty"`
}
type mcpListTokensOutput struct {
	Data []mcpToken  `json:"data"`
	Meta db.PageMeta `json:"meta"`
}

type mcpSessionFilesInput struct {
	TenantID  string `json:"tenantId,omitempty"`
	SessionID string `json:"sessionId"`
}
type mcpSessionFileInput struct {
	TenantID     string `json:"tenantId,omitempty"`
	SessionID    string `json:"sessionId"`
	RelativePath string `json:"relativePath"`
	TTLSeconds   int    `json:"ttlSeconds,omitempty"`
}
type mcpBoundSessionFileInput struct {
	RelativePath string `json:"relativePath"`
	TTLSeconds   int    `json:"ttlSeconds,omitempty"`
}
type mcpSessionFile struct {
	Name         string    `json:"name"`
	RelativePath string    `json:"relativePath"`
	Size         int64     `json:"size"`
	ModifiedAt   time.Time `json:"modifiedAt"`
	MIMEType     string    `json:"mimeType"`
}
type mcpSessionFilesOutput struct {
	Files []mcpSessionFile `json:"files"`
}
type mcpSessionFileURLOutput struct {
	URL       string    `json:"url"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type mcpStatusOutput struct {
	Session mcpSession `json:"session"`
}
type mcpConnectionOutput struct {
	SessionID    string       `json:"sessionId"`
	Status       string       `json:"status"`
	CDPURL       string       `json:"cdpUrl"`
	SessionToken string       `json:"sessionToken,omitempty"`
	Media        sessionMedia `json:"media"`
}

func (s *Server) newMCPServer(a mcpAuth) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "aperture", Version: s.DeployVersion}, nil)
	if a.pathBound {
		mcp.AddTool(server, &mcp.Tool{Name: "session_files.list", Description: "List safe metadata for files in this session."}, s.mcpBoundSessionFilesList)
		mcp.AddTool(server, &mcp.Tool{Name: "session_files.create_download_url", Description: "Create a signed URL for one file in this session."}, s.mcpBoundSessionFileURL)
		mcp.AddTool(server, &mcp.Tool{Name: "sessions.status", Description: "Get status for this session without waking it."}, s.mcpBoundStatus)
		mcp.AddTool(server, &mcp.Tool{Name: "sessions.connection", Description: "Get live connection data for this session without waking it."}, s.mcpBoundConnection)
		mcp.AddTool(server, &mcp.Tool{Name: "sessions.suspend", Description: "Suspend this running session."}, s.mcpBoundSuspend)
		if !a.sessionOnly && auth.HasScope(a.principal.Scopes, auth.ScopeSessionsWrite) && auth.HasScope(a.principal.Scopes, auth.ScopeSnapshotsWrite) {
			mcp.AddTool(server, &mcp.Tool{Name: "sessions.promote", Description: "Promote this stopped retained session into a snapshot."}, s.mcpBoundPromote)
		}
	} else {
		mcp.AddTool(server, &mcp.Tool{Name: "snapshots.list", Description: "List snapshots before creating a browser session."}, s.mcpSnapshotsList)
		mcp.AddTool(server, &mcp.Tool{Name: "snapshots.get", Description: "Get a snapshot by tenant and name."}, s.mcpSnapshotsGet)
		mcp.AddTool(server, &mcp.Tool{Name: "sessions.create", Description: "Create a browser session and return its session token and connection data for later browser tools."}, s.mcpSessionsCreate)
		mcp.AddTool(server, &mcp.Tool{Name: "sessions.create_from_snapshot", Description: "Create a browser session from the required snapshotName and return immediate connection data."}, s.mcpSessionsCreateFromSnapshot)
		mcp.AddTool(server, &mcp.Tool{Name: "sessions.list", Description: "List sessions without waking or promoting suspended sessions."}, s.mcpSessionsList)
		mcp.AddTool(server, &mcp.Tool{Name: "sessions.get", Description: "Get one session by tenant and session ID."}, s.mcpSessionsGet)
		mcp.AddTool(server, &mcp.Tool{Name: "sessions.bulk_get", Description: "Get several tenant-owned sessions without waking them."}, s.mcpSessionsBulkGet)
		mcp.AddTool(server, &mcp.Tool{Name: "sessions.status", Description: "Get current status for a session."}, s.mcpSessionStatus)
		mcp.AddTool(server, &mcp.Tool{Name: "sessions.connection", Description: "Get current connection data for a session."}, s.mcpSessionConnection)
		mcp.AddTool(server, &mcp.Tool{Name: "sessions.suspend", Description: "Suspend a running session."}, s.mcpSessionSuspend)
		mcp.AddTool(server, &mcp.Tool{Name: "sessions.delete", Description: "Delete a tenant-owned session."}, s.mcpSessionDelete)
		mcp.AddTool(server, &mcp.Tool{Name: "sessions.promote", Description: "Promote a stopped retained session into a snapshot."}, s.mcpSessionsPromote)
		mcp.AddTool(server, &mcp.Tool{Name: "sessions.session_token_rotate", Description: "Rotate the live session token for later browser access."}, s.mcpSessionTokenRotate)
		mcp.AddTool(server, &mcp.Tool{Name: "session_files.list", Description: "List safe metadata for files in a session."}, s.mcpSessionFilesList)
		mcp.AddTool(server, &mcp.Tool{Name: "session_files.create_download_url", Description: "Create a signed URL for one file in a session."}, s.mcpSessionFileURL)
		mcp.AddTool(server, &mcp.Tool{Name: "events.list", Description: "List tenant-scoped session and snapshot events."}, s.mcpEventsList)
		mcp.AddTool(server, &mcp.Tool{Name: "tenants.list", Description: "List tenants for system administration."}, s.mcpTenantsList)
		mcp.AddTool(server, &mcp.Tool{Name: "tokens.list", Description: "List API tokens for system or tenant administration."}, s.mcpTokensList)
		mcp.AddTool(server, &mcp.Tool{Name: "tenants.create", Description: "Create a tenant for subsequent session and snapshot workflows."}, s.mcpTenantsCreate)
		mcp.AddTool(server, &mcp.Tool{Name: "tokens.create", Description: "Create an API bearer token for authorized Aperture access."}, s.mcpTokensCreate)
		mcp.AddTool(server, &mcp.Tool{Name: "tokens.revoke", Description: "Revoke an API bearer token."}, s.mcpTokensRevoke)
	}
	canProxy := a.sessionOnly || (a.principal != nil && auth.HasScope(a.principal.Scopes, auth.ScopeSessionsWrite))
	tools, err := agentbrowser.ToolsForProfilesMetadata(a.profiles)
	if canProxy && err == nil {
		for name, definition := range tools {
			if name == "sessions.status" || name == "sessions.connection" {
				continue
			}
			tool := adaptAgentBrowserTool(definition, a.pathBound)
			server.AddTool(tool, s.agentBrowserToolHandler(a, name, a.pathBound))
		}
	}
	return server
}

func adaptAgentBrowserTool(definition agentbrowser.Tool, pathBound bool) *mcp.Tool {
	schema := make(map[string]any)
	encoded, _ := json.Marshal(definition.InputSchema)
	_ = json.Unmarshal(encoded, &schema)
	properties, _ := schema["properties"].(map[string]any)
	delete(properties, "session")
	delete(properties, "sessionId")
	required, _ := schema["required"].([]any)
	filteredRequired := required[:0]
	for _, item := range required {
		if item != "session" && item != "sessionId" {
			filteredRequired = append(filteredRequired, item)
		}
	}
	if pathBound {
		if len(filteredRequired) == 0 {
			delete(schema, "required")
		} else {
			schema["required"] = filteredRequired
		}
	} else {
		if properties == nil {
			properties = map[string]any{}
			schema["properties"] = properties
		}
		properties["sessionId"] = map[string]any{"type": "string", "description": "Aperture session ID."}
		filteredRequired = append(filteredRequired, "sessionId")
		schema["required"] = filteredRequired
	}
	tool := &mcp.Tool{Name: definition.Name, Title: definition.Title, Description: definition.Description, InputSchema: schema, OutputSchema: definition.OutputSchema}
	if definition.Annotations != nil {
		b, _ := json.Marshal(definition.Annotations)
		_ = json.Unmarshal(b, &tool.Annotations)
	}
	if definition.Meta != nil {
		b, _ := json.Marshal(definition.Meta)
		_ = json.Unmarshal(b, &tool.Meta)
	}
	if definition.Icons != nil {
		b, _ := json.Marshal(definition.Icons)
		_ = json.Unmarshal(b, &tool.Icons)
	}
	return tool
}

func (s *Server) agentBrowserToolHandler(a mcpAuth, name string, pathBound bool) mcp.ToolHandler {
	return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		arguments := map[string]any{}
		if len(req.Params.Arguments) > 0 {
			if err := json.Unmarshal(req.Params.Arguments, &arguments); err != nil {
				return nil, mcpToolError("invalid_arguments", err)
			}
		}
		if _, ok := arguments["session"]; ok {
			return nil, mcpToolError("invalid_arguments", errors.New("agent-browser session cannot be overridden"))
		}
		sessionID := a.sessionID
		if !pathBound {
			value, ok := arguments["sessionId"].(string)
			if !ok || value == "" {
				return nil, mcpToolError("invalid_arguments", errors.New("sessionId is required"))
			}
			sessionID = value
			delete(arguments, "sessionId")
		}
		view, err := s.resolveProxySession(ctx, a, sessionID)
		if err != nil {
			return nil, err
		}
		port, release, err := s.Sessions.AcquireCDPPort(ctx, view.Session.TenantID, sessionID)
		if err != nil {
			return nil, mcpToolError("session_unavailable", err)
		}
		defer release()
		result, err := s.agentBrowser.Call(ctx, sessionID, fmt.Sprintf("http://127.0.0.1:%d", port), name, arguments)
		if err != nil {
			return nil, mcpToolError("agent_browser_error", err)
		}
		return result, nil
	}
}

func (s *Server) resolveProxySession(ctx context.Context, a mcpAuth, sessionID string) (*session.SessionView, error) {
	if a.sessionID != "" && sessionID != a.sessionID {
		return nil, mcpToolError("forbidden", nil)
	}
	if a.sessionOnly {
		return s.Sessions.Get(ctx, a.tenantID, sessionID)
	}
	row, err := s.Repository.GetSessionByID(ctx, sessionID)
	if err != nil || row == nil {
		return nil, mcpToolError("session_not_found", err)
	}
	if a.principal == nil || !auth.HasScope(a.principal.Scopes, auth.ScopeSessionsWrite) {
		return nil, mcpToolError("forbidden", nil)
	}
	if _, err := auth.ResolveTenantID(*a.principal, row.TenantID); err != nil {
		return nil, mcpToolError("forbidden", nil)
	}
	return s.Sessions.Get(ctx, row.TenantID, sessionID)
}

func (s *Server) mcpTenant(a mcpAuth, requested string, scope string) (string, error) {
	if a.principal == nil {
		return "", mcpToolError("unauthorized", nil)
	}
	if !auth.HasScope(a.principal.Scopes, scope) {
		return "", mcpToolError("forbidden", nil)
	}
	tenantID, err := auth.ResolveTenantID(*a.principal, requested)
	if err != nil {
		return "", mcpToolError("tenant_not_found", err)
	}
	return tenantID, nil
}

func (s *Server) mcpSnapshotsList(ctx context.Context, _ *mcp.CallToolRequest, in mcpListSnapshotsInput) (*mcp.CallToolResult, mcpListSnapshotsOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpListSnapshotsOutput{}, err
	}
	tenantID, err := s.mcpTenant(a, in.TenantID, auth.ScopeSnapshotsRead)
	if err != nil {
		return nil, mcpListSnapshotsOutput{}, err
	}
	page, err := s.Snapshots.List(ctx, tenantID, snapshot.ListFilter{IncludeDeleted: in.IncludeDeleted}, mcpPageParams(in.Cursor, in.Limit))
	if err != nil {
		return nil, mcpListSnapshotsOutput{}, mcpToolError("internal", err)
	}
	out := mcpListSnapshotsOutput{Meta: page.Meta}
	for _, item := range page.Items {
		out.Data = append(out.Data, mcpSnapshotView(&item))
	}
	return nil, out, nil
}

func (s *Server) mcpSnapshotsGet(ctx context.Context, _ *mcp.CallToolRequest, in mcpGetSnapshotInput) (*mcp.CallToolResult, mcpSnapshot, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpSnapshot{}, err
	}
	tenantID, err := s.mcpTenant(a, in.TenantID, auth.ScopeSnapshotsRead)
	if err != nil {
		return nil, mcpSnapshot{}, err
	}
	view, err := s.Snapshots.Get(ctx, tenantID, in.Name)
	if err != nil {
		return nil, mcpSnapshot{}, mcpToolError("snapshot_not_found", err)
	}
	return nil, mcpSnapshotView(view), nil
}

func (s *Server) mcpSessionsCreate(ctx context.Context, _ *mcp.CallToolRequest, in mcpCreateSessionInput) (*mcp.CallToolResult, mcpCreateSessionOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpCreateSessionOutput{}, err
	}
	tenantID, err := s.mcpTenant(a, in.TenantID, auth.ScopeSessionsWrite)
	if err != nil {
		return nil, mcpCreateSessionOutput{}, err
	}
	if in.BaseSnapshotName != nil && !auth.HasScope(a.principal.Scopes, auth.ScopeSnapshotsRead) {
		return nil, mcpCreateSessionOutput{}, mcpToolError("forbidden", nil)
	}
	view, err := s.Sessions.Create(ctx, session.CreateInput{TenantID: tenantID, BaseSnapshotName: in.BaseSnapshotName, Label: in.Label, BrowserChannel: in.BrowserChannel, BrowserArgs: in.BrowserArgs, Tags: in.Tags})
	if err != nil {
		return nil, mcpCreateSessionOutput{}, mcpToolError("session_unavailable", err)
	}
	result := mcpCreateSessionOutput{Session: mcpSessionView(view), SessionID: view.Session.ID, Status: view.Session.Status, CDPURL: view.CDPURL, SessionToken: view.SessionToken}
	return nil, result, nil
}

func (s *Server) mcpSessionsCreateFromSnapshot(ctx context.Context, _ *mcp.CallToolRequest, in mcpCreateFromSnapshotInput) (*mcp.CallToolResult, mcpCreateSessionOutput, error) {
	if in.SnapshotName == "" {
		return nil, mcpCreateSessionOutput{}, mcpToolError("invalid_arguments", errors.New("snapshotName is required"))
	}
	baseSnapshotName := in.SnapshotName
	return s.mcpSessionsCreate(ctx, nil, mcpCreateSessionInput{TenantID: in.TenantID, BaseSnapshotName: &baseSnapshotName, Label: in.Label, BrowserChannel: in.BrowserChannel, BrowserArgs: in.BrowserArgs, Tags: in.Tags})
}

func (s *Server) mcpSessionsList(ctx context.Context, _ *mcp.CallToolRequest, in mcpListSessionsInput) (*mcp.CallToolResult, mcpListSessionsOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpListSessionsOutput{}, err
	}
	tenantID, err := s.mcpTenant(a, in.TenantID, auth.ScopeSessionsRead)
	if err != nil {
		return nil, mcpListSessionsOutput{}, err
	}
	page, err := s.Sessions.List(ctx, tenantID, session.ListFilter{IncludeDeleted: in.IncludeDeleted}, mcpPageParams(in.Cursor, in.Limit))
	if err != nil {
		return nil, mcpListSessionsOutput{}, mcpToolError("internal", err)
	}
	out := mcpListSessionsOutput{Meta: page.Meta}
	for _, item := range page.Items {
		out.Data = append(out.Data, mcpSessionView(&item))
	}
	return nil, out, nil
}
func (s *Server) mcpSessionsGet(ctx context.Context, _ *mcp.CallToolRequest, in mcpGetSessionInput) (*mcp.CallToolResult, mcpSession, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpSession{}, err
	}
	tenantID, err := s.mcpTenant(a, in.TenantID, auth.ScopeSessionsRead)
	if err != nil {
		return nil, mcpSession{}, err
	}
	view, err := s.Sessions.Get(ctx, tenantID, in.SessionID)
	if err != nil {
		return nil, mcpSession{}, mcpToolError("session_not_found", err)
	}
	return nil, mcpSessionView(view), nil
}
func (s *Server) mcpSessionsBulkGet(ctx context.Context, _ *mcp.CallToolRequest, in mcpBulkSessionsInput) (*mcp.CallToolResult, mcpBulkSessionsOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpBulkSessionsOutput{}, err
	}
	tenantID, err := s.mcpTenant(a, in.TenantID, auth.ScopeSessionsRead)
	if err != nil {
		return nil, mcpBulkSessionsOutput{}, err
	}
	views, err := s.Sessions.GetByIDs(ctx, tenantID, in.SessionIDs)
	if err != nil {
		return nil, mcpBulkSessionsOutput{}, mcpToolError("session_not_found", err)
	}
	out := mcpBulkSessionsOutput{}
	for i := range views {
		out.Sessions = append(out.Sessions, mcpSessionView(&views[i]))
	}
	return nil, out, nil
}

func (s *Server) sessionForMCP(ctx context.Context, a mcpAuth, requested, requestedTenant string, write bool) (*session.SessionView, error) {
	if a.sessionID != "" && requested != "" && requested != a.sessionID {
		return nil, mcpToolError("forbidden", nil)
	}
	id := requested
	if id == "" {
		id = a.sessionID
	}
	if id == "" {
		return nil, mcpToolError("invalid_arguments", nil)
	}
	scope := auth.ScopeSessionsRead
	if write {
		scope = auth.ScopeSessionsWrite
	}
	tenantID := a.tenantID
	if tenantID == "" {
		var err error
		tenantID, err = s.mcpTenant(a, requestedTenant, scope)
		if err != nil {
			return nil, err
		}
	} else if a.principal != nil && !auth.HasScope(a.principal.Scopes, scope) && !a.sessionOnly {
		return nil, mcpToolError("forbidden", nil)
	}
	view, err := s.Sessions.Get(ctx, tenantID, id)
	if err != nil {
		return nil, mcpToolError("session_not_found", err)
	}
	return view, nil
}
func (s *Server) mcpSessionStatus(ctx context.Context, _ *mcp.CallToolRequest, in mcpSessionIDInput) (*mcp.CallToolResult, mcpStatusOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpStatusOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, false)
	if err != nil {
		return nil, mcpStatusOutput{}, err
	}
	return nil, mcpStatusOutput{Session: mcpSessionView(view)}, nil
}
func (s *Server) mcpSessionConnection(ctx context.Context, _ *mcp.CallToolRequest, in mcpSessionIDInput) (*mcp.CallToolResult, mcpConnectionOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpConnectionOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, false)
	if err != nil {
		return nil, mcpConnectionOutput{}, err
	}
	return nil, mcpConnectionOutput{SessionID: view.Session.ID, Status: view.Session.Status, CDPURL: view.CDPURL, SessionToken: view.SessionToken, Media: sessionMedia{Mode: view.Media.Mode, WebRTCProducer: view.Media.WebRTCProducer, ICEServers: toICEServerResponses(view.Media.ICEServers)}}, nil
}
func (s *Server) mcpSessionSuspend(ctx context.Context, _ *mcp.CallToolRequest, in mcpSessionIDInput) (*mcp.CallToolResult, mcpStatusOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpStatusOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, mcpStatusOutput{}, err
	}
	updated, err := s.Sessions.Suspend(ctx, view.Session.TenantID, view.Session.ID)
	if err != nil {
		return nil, mcpStatusOutput{}, mcpToolError("session_unavailable", err)
	}
	return nil, mcpStatusOutput{Session: mcpSessionView(updated)}, nil
}
func (s *Server) mcpSessionDelete(ctx context.Context, _ *mcp.CallToolRequest, in mcpSessionIDInput) (*mcp.CallToolResult, mcpStatusOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpStatusOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, mcpStatusOutput{}, err
	}
	updated, err := s.Sessions.Delete(ctx, view.Session.TenantID, view.Session.ID)
	if err != nil {
		return nil, mcpStatusOutput{}, mcpToolError("session_unavailable", err)
	}
	return nil, mcpStatusOutput{Session: mcpSessionView(updated)}, nil
}
func (s *Server) mcpSessionTokenRotate(ctx context.Context, _ *mcp.CallToolRequest, in mcpSessionIDInput) (*mcp.CallToolResult, mcpStatusOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpStatusOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, mcpStatusOutput{}, err
	}
	updated, err := s.Sessions.RotateSessionToken(ctx, view.Session.TenantID, view.Session.ID)
	if err != nil {
		return nil, mcpStatusOutput{}, mcpToolError("session_unavailable", err)
	}
	return nil, mcpStatusOutput{Session: mcpSessionView(updated)}, nil
}
func (s *Server) mcpSessionsPromote(ctx context.Context, _ *mcp.CallToolRequest, in mcpPromoteInput) (*mcp.CallToolResult, mcpPromoteOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpPromoteOutput{}, err
	}
	tenantID, err := s.mcpTenant(a, in.TenantID, auth.ScopeSessionsWrite)
	if err != nil {
		return nil, mcpPromoteOutput{}, err
	}
	if !auth.HasScope(a.principal.Scopes, auth.ScopeSnapshotsWrite) {
		return nil, mcpPromoteOutput{}, mcpToolError("forbidden", nil)
	}
	view, err := s.Promotion.Promote(ctx, snapshot.PromoteInput{TenantID: tenantID, SessionID: in.SessionID, Name: in.Name, Description: in.Description, Force: in.Force, Tags: in.Tags})
	if err != nil {
		return nil, mcpPromoteOutput{}, mcpToolError("session_unavailable", err)
	}
	return nil, mcpPromoteOutput{Snapshot: mcpSnapshotView(view)}, nil
}
func (s *Server) mcpEventsList(ctx context.Context, _ *mcp.CallToolRequest, in mcpListEventsInput) (*mcp.CallToolResult, mcpListEventsOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpListEventsOutput{}, err
	}
	tenantID, err := s.mcpTenant(a, in.TenantID, auth.ScopeSessionsRead)
	if err != nil {
		return nil, mcpListEventsOutput{}, err
	}
	page, err := s.Events.List(ctx, tenantID, event.ListFilter{ResourceType: in.ResourceType, ResourceID: in.ResourceID}, mcpPageParams(in.Cursor, in.Limit))
	if err != nil {
		return nil, mcpListEventsOutput{}, mcpToolError("internal", err)
	}
	return nil, mcpListEventsOutput{Data: page.Items, Meta: page.Meta}, nil
}
func (s *Server) mcpTenantsCreate(ctx context.Context, _ *mcp.CallToolRequest, in mcpCreateTenantInput) (*mcp.CallToolResult, mcpCreateTenantOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpCreateTenantOutput{}, err
	}
	if a.principal == nil || !auth.HasScope(a.principal.Scopes, auth.ScopeTenantsWrite) {
		return nil, mcpCreateTenantOutput{}, mcpToolError("forbidden", nil)
	}
	tenant, err := s.Auth.CreateTenant(ctx, auth.CreateTenantInput{DisplayName: in.DisplayName})
	if err != nil {
		return nil, mcpCreateTenantOutput{}, mcpToolError("invalid_arguments", err)
	}
	return nil, mcpCreateTenantOutput{Tenant: *tenant}, nil
}

func (s *Server) mcpTokensCreate(ctx context.Context, _ *mcp.CallToolRequest, in mcpCreateTokenInput) (*mcp.CallToolResult, mcpCreateTokenOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpCreateTokenOutput{}, err
	}
	if a.principal == nil {
		return nil, mcpCreateTokenOutput{}, mcpToolError("unauthorized", nil)
	}
	if a.principal.AuthorityType == auth.AuthoritySystemAdmin {
		if !auth.HasScope(a.principal.Scopes, auth.ScopeSystemAdmin) {
			return nil, mcpCreateTokenOutput{}, mcpToolError("forbidden", nil)
		}
	} else {
		if !auth.HasScope(a.principal.Scopes, auth.ScopeTenantWrite) || in.AuthorityType != auth.AuthorityTenant || a.principal.TenantID == nil || in.TenantID == nil || *in.TenantID != *a.principal.TenantID {
			return nil, mcpCreateTokenOutput{}, mcpToolError("forbidden", nil)
		}
	}
	var expiresAt *time.Time
	if in.ExpiresAt != nil {
		parsed, parseErr := time.Parse(time.RFC3339Nano, *in.ExpiresAt)
		if parseErr != nil {
			return nil, mcpCreateTokenOutput{}, mcpToolError("invalid_arguments", parseErr)
		}
		expiresAt = &parsed
	}
	created, err := s.Auth.CreateToken(ctx, auth.CreateTokenInput{AuthorityType: in.AuthorityType, TenantID: in.TenantID, Name: in.Name, Scopes: in.Scopes, ExpiresAt: expiresAt})
	if err != nil {
		return nil, mcpCreateTokenOutput{}, mcpToolError("invalid_arguments", err)
	}
	scopes, err := auth.ParseScopesJSON(created.Token.ScopesJSON)
	if err != nil {
		return nil, mcpCreateTokenOutput{}, mcpToolError("internal", err)
	}
	return nil, mcpCreateTokenOutput{Token: mcpToken{ID: created.Token.ID, AuthorityType: created.Token.AuthorityType, TenantID: created.Token.TenantID, Name: created.Token.Name, Scopes: scopes, CreatedAt: created.Token.CreatedAt, ExpiresAt: created.Token.ExpiresAt}, RawToken: created.Raw}, nil
}

func (s *Server) mcpTokensRevoke(ctx context.Context, _ *mcp.CallToolRequest, in mcpRevokeTokenInput) (*mcp.CallToolResult, mcpRevokeTokenOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRevokeTokenOutput{}, err
	}
	if a.principal == nil {
		return nil, mcpRevokeTokenOutput{}, mcpToolError("unauthorized", nil)
	}
	tenantID := in.TenantID
	if a.principal.AuthorityType == auth.AuthorityTenant {
		if !auth.HasScope(a.principal.Scopes, auth.ScopeTenantWrite) || a.principal.TenantID == nil {
			return nil, mcpRevokeTokenOutput{}, mcpToolError("forbidden", nil)
		}
		tenantID = a.principal.TenantID
	} else if !auth.HasScope(a.principal.Scopes, auth.ScopeSystemAdmin) {
		return nil, mcpRevokeTokenOutput{}, mcpToolError("forbidden", nil)
	}
	if err := s.Auth.RevokeToken(ctx, in.TokenID, tenantID); err != nil {
		return nil, mcpRevokeTokenOutput{}, mcpToolError("internal", err)
	}
	return nil, mcpRevokeTokenOutput{Revoked: true}, nil
}

func (s *Server) mcpTenantsList(ctx context.Context, _ *mcp.CallToolRequest, in mcpListTenantsInput) (*mcp.CallToolResult, mcpListTenantsOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpListTenantsOutput{}, err
	}
	if a.principal == nil || !auth.HasScope(a.principal.Scopes, auth.ScopeTenantsWrite) {
		return nil, mcpListTenantsOutput{}, mcpToolError("forbidden", nil)
	}
	page, err := s.Auth.ListTenantsPage(ctx, db.TenantFilter{IncludeDeleted: in.IncludeDeleted}, mcpPageParams(in.Cursor, in.Limit))
	if err != nil {
		return nil, mcpListTenantsOutput{}, mcpToolError("internal", err)
	}
	return nil, mcpListTenantsOutput{Data: page.Items, Meta: page.Meta}, nil
}
func (s *Server) mcpTokensList(ctx context.Context, _ *mcp.CallToolRequest, in mcpListTokensInput) (*mcp.CallToolResult, mcpListTokensOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpListTokensOutput{}, err
	}
	if a.principal == nil {
		return nil, mcpListTokensOutput{}, mcpToolError("unauthorized", nil)
	}
	tenantID := in.TenantID
	if a.principal.AuthorityType == auth.AuthorityTenant {
		tenantID = a.principal.TenantID
	}
	if a.principal.AuthorityType != auth.AuthoritySystemAdmin && !auth.HasScope(a.principal.Scopes, auth.ScopeTenantWrite) {
		return nil, mcpListTokensOutput{}, mcpToolError("forbidden", nil)
	}
	page, err := s.Auth.ListTokensPage(ctx, db.APITokenFilter{TenantID: tenantID}, mcpPageParams(in.Cursor, in.Limit))
	if err != nil {
		return nil, mcpListTokensOutput{}, mcpToolError("internal", err)
	}
	out := mcpListTokensOutput{Meta: page.Meta}
	for _, item := range page.Items {
		scopes, err := auth.ParseScopesJSON(item.ScopesJSON)
		if err != nil {
			return nil, mcpListTokensOutput{}, mcpToolError("internal", err)
		}
		out.Data = append(out.Data, mcpToken{ID: item.ID, AuthorityType: item.AuthorityType, TenantID: item.TenantID, Name: item.Name, Scopes: scopes, CreatedAt: item.CreatedAt, ExpiresAt: item.ExpiresAt, RevokedAt: item.RevokedAt})
	}
	return nil, out, nil
}

func (s *Server) mcpBoundStatus(ctx context.Context, req *mcp.CallToolRequest, _ mcpSessionOnlyInput) (*mcp.CallToolResult, mcpStatusOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpStatusOutput{}, err
	}
	return s.mcpSessionStatus(ctx, req, mcpSessionIDInput{TenantID: a.tenantID, SessionID: a.sessionID})
}
func (s *Server) mcpBoundConnection(ctx context.Context, req *mcp.CallToolRequest, _ mcpSessionOnlyInput) (*mcp.CallToolResult, mcpConnectionOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpConnectionOutput{}, err
	}
	return s.mcpSessionConnection(ctx, req, mcpSessionIDInput{TenantID: a.tenantID, SessionID: a.sessionID})
}
func (s *Server) mcpBoundPromote(ctx context.Context, req *mcp.CallToolRequest, in mcpBoundPromoteInput) (*mcp.CallToolResult, mcpPromoteOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpPromoteOutput{}, err
	}
	return s.mcpSessionsPromote(ctx, req, mcpPromoteInput{TenantID: a.tenantID, SessionID: a.sessionID, Name: in.Name, Description: in.Description, Force: in.Force, Tags: in.Tags})
}

func (s *Server) mcpBoundSuspend(ctx context.Context, req *mcp.CallToolRequest, _ mcpSessionOnlyInput) (*mcp.CallToolResult, mcpStatusOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpStatusOutput{}, err
	}
	return s.mcpSessionSuspend(ctx, req, mcpSessionIDInput{TenantID: a.tenantID, SessionID: a.sessionID})
}
