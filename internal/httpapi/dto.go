package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/ids"
	"github.com/aperture/aperture/internal/proxy"
	"github.com/aperture/aperture/internal/sessionfiles"
)

var (
	errRequestDecode = errors.New("request decode error")
	errValidation    = errors.New("validation error")
)

func validationError(message string) error {
	return errors.Join(errValidation, errors.New(message))
}

type createTenantRequest struct {
	DisplayName string `json:"displayName"`
}

func (r createTenantRequest) Validate() error {
	if strings.TrimSpace(r.DisplayName) == "" {
		return validationError("displayName is required")
	}
	return nil
}

type updateTenantRequest struct {
	DisplayName string `json:"displayName"`
}

func (r updateTenantRequest) Validate() error {
	if strings.TrimSpace(r.DisplayName) == "" {
		return validationError("displayName is required")
	}
	return nil
}

type createTenantLocalTokenRequest struct {
	Name           string                 `json:"name"`
	Scopes         []string               `json:"scopes"`
	ResourceMode   string                 `json:"resourceMode"`
	ResourceGrants []resourceGrantRequest `json:"resourceGrants"`
	ExpiresAt      *string                `json:"expiresAt"`
}

func (r createTenantLocalTokenRequest) Validate() error {
	if strings.TrimSpace(r.Name) == "" {
		return validationError("name is required")
	}
	if len(r.Scopes) == 0 {
		return validationError("scopes is required")
	}
	if err := validateTokenResourceScope(r.ResourceMode, r.ResourceGrants, authAuthorityTenant); err != nil {
		return err
	}
	if r.ExpiresAt != nil && strings.TrimSpace(*r.ExpiresAt) != "" {
		if _, err := time.Parse(time.RFC3339Nano, *r.ExpiresAt); err != nil {
			return validationError("expiresAt must be RFC3339Nano")
		}
	}
	return nil
}

type createTokenRequest struct {
	Name           string                 `json:"name"`
	AuthorityType  string                 `json:"authorityType"`
	TenantID       *string                `json:"tenantId"`
	Scopes         []string               `json:"scopes"`
	ResourceMode   string                 `json:"resourceMode"`
	ResourceGrants []resourceGrantRequest `json:"resourceGrants"`
	ExpiresAt      *string                `json:"expiresAt"`
}

func (r createTokenRequest) Validate() error {
	if strings.TrimSpace(r.Name) == "" {
		return validationError("name is required")
	}
	if strings.TrimSpace(r.AuthorityType) == "" {
		return validationError("authorityType is required")
	}
	if len(r.Scopes) == 0 {
		return validationError("scopes is required")
	}
	if r.AuthorityType == authAuthorityTenant && (r.TenantID == nil || strings.TrimSpace(*r.TenantID) == "") {
		return validationError("tenantId is required for tenant tokens")
	}
	if err := validateTokenResourceScope(r.ResourceMode, r.ResourceGrants, r.AuthorityType); err != nil {
		return err
	}
	if r.ExpiresAt != nil && strings.TrimSpace(*r.ExpiresAt) != "" {
		if _, err := time.Parse(time.RFC3339Nano, *r.ExpiresAt); err != nil {
			return validationError("expiresAt must be RFC3339Nano")
		}
	}
	return nil
}

type resourceGrantRequest struct {
	ResourceType string `json:"resourceType"`
	ResourceID   string `json:"resourceId"`
}

func validateTokenResourceScope(mode string, grants []resourceGrantRequest, authorityType string) error {
	if mode == "" || mode == "all" {
		if len(grants) != 0 {
			return validationError("resourceGrants requires allowlist resourceMode")
		}
		return nil
	}
	if mode != "allowlist" || authorityType != authAuthorityTenant {
		return validationError("invalid resourceMode")
	}
	seen := make(map[string]struct{}, len(grants))
	for _, grant := range grants {
		if grant.ResourceType != "session" && grant.ResourceType != "snapshot" {
			return validationError("resourceType must be session or snapshot")
		}
		if err := ids.ValidateUUIDv7(grant.ResourceID); err != nil {
			return validationError("resourceId must be UUIDv7")
		}
		key := grant.ResourceType + "\x00" + grant.ResourceID
		if _, ok := seen[key]; ok {
			return validationError("resource grants must be unique")
		}
		seen[key] = struct{}{}
	}
	return nil
}

type tenantResponse struct {
	ID          string  `json:"id"`
	DisplayName string  `json:"displayName"`
	CreatedAt   string  `json:"createdAt"`
	DeletedAt   *string `json:"deletedAt"`
}

type principalResponse struct {
	Type           string                  `json:"type"`
	ID             string                  `json:"id"`
	AuthMethod     string                  `json:"authMethod"`
	TokenID        *string                 `json:"tokenId"`
	UserID         *string                 `json:"userId,omitempty"`
	Name           string                  `json:"name"`
	AuthorityType  string                  `json:"authorityType"`
	TenantID       *string                 `json:"tenantId"`
	Scopes         []string                `json:"scopes"`
	ResourceMode   string                  `json:"resourceMode"`
	ResourceGrants []resourceGrantResponse `json:"resourceGrants"`
}

type authMeResponse struct {
	Principal        principalResponse `json:"principal"`
	SelectedTenant   *tenantResponse   `json:"selectedTenant"`
	AvailableTenants []tenantResponse  `json:"availableTenants"`
}

type loginMethodResponse struct {
	Type     string `json:"type"`
	ID       string `json:"id,omitempty"`
	Name     string `json:"name,omitempty"`
	LoginURL string `json:"loginUrl,omitempty"`
}

type loginMethodsResponse struct {
	Methods []loginMethodResponse `json:"methods"`
}

type createUserRequest struct {
	Email         *string `json:"email"`
	DisplayName   string  `json:"displayName"`
	IsSystemAdmin *bool   `json:"isSystemAdmin"`
}

type userInvitationResponse struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
}

func (r createUserRequest) Validate() error {
	if strings.TrimSpace(r.DisplayName) == "" {
		return validationError("displayName is required")
	}
	if r.Email != nil && strings.TrimSpace(*r.Email) != "" {
		parsed, err := mail.ParseAddress(strings.TrimSpace(*r.Email))
		if err != nil || parsed.Address != strings.TrimSpace(*r.Email) {
			return validationError("email is invalid")
		}
	}
	if r.IsSystemAdmin == nil {
		return validationError("isSystemAdmin is required")
	}
	return nil
}

type updateUserRequest = createUserRequest

type userResponse struct {
	ID                  string  `json:"id"`
	Email               *string `json:"email"`
	DisplayName         string  `json:"displayName"`
	IsSystemAdmin       bool    `json:"isSystemAdmin"`
	CreatedAt           string  `json:"createdAt"`
	UpdatedAt           string  `json:"updatedAt"`
	DisabledAt          *string `json:"disabledAt"`
	PasswordSetupStatus *string `json:"passwordSetupStatus,omitempty"`
}

type upsertTenantMembershipRequest struct {
	Scopes []string `json:"scopes"`
}

func (r upsertTenantMembershipRequest) Validate() error {
	if len(r.Scopes) == 0 {
		return validationError("scopes is required")
	}
	return nil
}

type tenantMembershipResponse struct {
	TenantID  string   `json:"tenantId"`
	UserID    string   `json:"userId"`
	Scopes    []string `json:"scopes"`
	CreatedAt string   `json:"createdAt"`
	UpdatedAt string   `json:"updatedAt"`
}

type auditEventResponse struct {
	ID           string          `json:"id"`
	ActorType    string          `json:"actorType"`
	ActorID      *string         `json:"actorId"`
	TenantID     *string         `json:"tenantId"`
	Action       string          `json:"action"`
	ResourceType string          `json:"resourceType"`
	ResourceID   *string         `json:"resourceId"`
	Data         json.RawMessage `json:"data"`
	CreatedAt    string          `json:"createdAt"`
}

type healthResponse struct {
	Status      string `json:"status"`
	Color       string `json:"color"`
	Role        string `json:"role"`
	Version     string `json:"version"`
	ActiveColor string `json:"activeColor"`
}

type browserChannelResponse struct {
	Name string `json:"name"`
}

type browserChannelsResponse struct {
	Channels []browserChannelResponse `json:"channels"`
}

type tokenResponse struct {
	ID             string                  `json:"id"`
	AuthorityType  string                  `json:"authorityType"`
	TenantID       *string                 `json:"tenantId"`
	Name           string                  `json:"name"`
	Scopes         []string                `json:"scopes"`
	CreatedAt      string                  `json:"createdAt"`
	CreatedByType  string                  `json:"createdByType"`
	CreatedByID    *string                 `json:"createdById"`
	ParentTokenID  *string                 `json:"parentTokenId"`
	ResourceMode   string                  `json:"resourceMode"`
	ResourceGrants []resourceGrantResponse `json:"resourceGrants"`
	ExpiresAt      *string                 `json:"expiresAt"`
	RevokedAt      *string                 `json:"revokedAt"`
}

type resourceGrantResponse struct {
	ResourceType string `json:"resourceType"`
	ResourceID   string `json:"resourceId"`
}

type createTokenResponse struct {
	Token    tokenResponse `json:"token"`
	RawToken string        `json:"rawToken"`
}

const (
	authAuthoritySystemAdmin = "system_admin"
	authAuthorityTenant      = "tenant"
)

type sessionBrowserConfig struct {
	Channel string   `json:"channel"`
	Args    []string `json:"args"`
}

func (r sessionBrowserConfig) Validate() error {
	if strings.TrimSpace(r.Channel) == "" {
		return validationError("browser.channel is required")
	}
	return nil
}

type createSessionRequest struct {
	BaseSnapshotName *string              `json:"baseSnapshotName"`
	Label            *string              `json:"label"`
	Browser          sessionBrowserConfig `json:"browser"`
	InitialTargets   json.RawMessage      `json:"initialTargets"`
	StorageState     json.RawMessage      `json:"storageState"`
	Tags             map[string]string    `json:"tags"`
	Proxy            proxyConfigRequest   `json:"proxy"`
}

func (r createSessionRequest) Validate() error {
	if err := r.Browser.Validate(); err != nil {
		return err
	}
	return r.Proxy.Validate()
}

func (r createSessionRequest) initialization() browser.SessionInitialization {
	return browser.SessionInitialization{Targets: r.InitialTargets, StorageState: r.StorageState}
}

type proxyUpstreamRequest struct {
	URL  string `json:"url"`
	Auth string `json:"auth"`
}

type proxyRuleRequest struct {
	Match string `json:"match"`
	Via   string `json:"via"`
}

type proxyConfigRequest struct {
	Upstreams map[string]proxyUpstreamRequest `json:"upstreams"`
	Rules     []proxyRuleRequest              `json:"rules"`

	// The single-upstream shape from before rules. Clients built against it
	// are still deployed, so it is accepted and translated into rules.
	Upstream *string               `json:"upstream"`
	URL      *string               `json:"url"`
	Tunnel   *proxyUpstreamRequest `json:"tunnel"`
	Bypass   *string               `json:"bypass"`
}

func (r proxyConfigRequest) config() (proxy.Config, error) {
	if r.Upstream != nil || r.URL != nil || r.Tunnel != nil || r.Bypass != nil {
		if r.Upstreams != nil || r.Rules != nil {
			return proxy.Config{}, validationError("proxy upstream, url, tunnel and bypass cannot be combined with upstreams and rules")
		}
		return r.legacyConfig()
	}

	config := proxy.Config{}
	if len(r.Upstreams) > 0 {
		config.Upstreams = make(map[string]proxy.UpstreamConfig, len(r.Upstreams))
		for name, upstream := range r.Upstreams {
			config.Upstreams[name] = proxy.UpstreamConfig{URL: strings.TrimSpace(upstream.URL), Auth: upstream.Auth}
		}
	}
	for _, rule := range r.Rules {
		config.Rules = append(config.Rules, proxy.Rule{Match: strings.TrimSpace(rule.Match), Via: strings.TrimSpace(rule.Via)})
	}
	return config, nil
}

// legacyConfig translates the single-upstream shape into rules. The final "*"
// rule never matches localhost, as Chromium used to bypass loopback.
func (r proxyConfigRequest) legacyConfig() (proxy.Config, error) {
	upstream := ""
	if r.Upstream != nil {
		upstream = strings.TrimSpace(*r.Upstream)
	}
	proxyURL := ""
	if r.URL != nil {
		proxyURL = strings.TrimSpace(*r.URL)
	}
	tunnel := proxyUpstreamRequest{}
	if r.Tunnel != nil {
		tunnel = proxyUpstreamRequest{URL: strings.TrimSpace(r.Tunnel.URL), Auth: r.Tunnel.Auth}
	}
	hasTunnel := tunnel.URL != "" || strings.TrimSpace(tunnel.Auth) != ""

	config := proxy.Config{}
	via := ""
	switch upstream {
	case "", proxy.LegacyUpstreamDirect:
		if proxyURL != "" {
			return proxy.Config{}, validationError("proxy url is only valid with upstream=proxy")
		}
		if hasTunnel {
			return proxy.Config{}, validationError("tunnel settings are only valid with upstream=tunnel")
		}
		return config, nil
	case proxy.LegacyUpstreamProxy:
		if proxyURL == "" {
			return proxy.Config{}, validationError("proxy url is required with upstream=proxy")
		}
		if hasTunnel {
			return proxy.Config{}, validationError("tunnel settings are only valid with upstream=tunnel")
		}
		via = proxyURL
	case proxy.LegacyUpstreamTunnel:
		if proxyURL != "" {
			return proxy.Config{}, validationError("proxy url is only valid with upstream=proxy")
		}
		if tunnel.URL == "" {
			return proxy.Config{}, validationError("tunnel url is required with upstream=tunnel")
		}
		if strings.TrimSpace(tunnel.Auth) == "" {
			return proxy.Config{}, validationError("tunnel auth is required with upstream=tunnel")
		}
		via = proxy.LegacyUpstreamTunnel
		config.Upstreams = map[string]proxy.UpstreamConfig{via: {URL: tunnel.URL, Auth: tunnel.Auth}}
	default:
		return proxy.Config{}, validationError(fmt.Sprintf("unknown proxy upstream %q", upstream))
	}

	if r.Bypass != nil {
		separators := func(c rune) bool { return c == ';' || c == ',' }
		for _, entry := range strings.FieldsFunc(*r.Bypass, separators) {
			entry = strings.TrimSpace(entry)
			if entry == "" {
				continue
			}
			match := entry
			// Chromium reads a leading dot as any subdomain.
			if strings.HasPrefix(match, ".") {
				match = "*" + match
			}
			if _, err := proxy.ParseHostPattern(match); err != nil {
				return proxy.Config{}, validationError(fmt.Sprintf("unsupported proxy bypass entry %q: use upstreams and rules instead", entry))
			}
			config.Rules = append(config.Rules, proxy.Rule{Match: match, Via: proxy.ViaDirect})
		}
	}
	config.Rules = append(config.Rules, proxy.Rule{Match: "*", Via: via})
	return config, nil
}

func (r proxyConfigRequest) Validate() error {
	config, err := r.config()
	if err != nil {
		return err
	}
	if err := config.Validate(); err != nil {
		return validationError(err.Error())
	}
	return nil
}

type updateProxyRequest struct {
	proxyConfigRequest
	Drain bool `json:"drain"`
}

type sessionProxyUpstreamView struct {
	URL string `json:"url"`
}

type sessionProxyRuleView struct {
	Match string `json:"match"`
	Via   string `json:"via"`
}

type sessionProxyView struct {
	Upstreams map[string]sessionProxyUpstreamView `json:"upstreams"`
	Rules     []sessionProxyRuleView              `json:"rules"`

	// The single-upstream shape, kept for clients that still decode it and
	// require upstream.
	Upstream string                    `json:"upstream"`
	URL      string                    `json:"url,omitempty"`
	Tunnel   *sessionProxyUpstreamView `json:"tunnel,omitempty"`
	Bypass   string                    `json:"bypass,omitempty"`
}

// toSessionProxyView renders the stored configuration without secrets. Tunnel
// auth is write-only and never appears in responses; proxy URLs come back with
// their passwords masked.
func toSessionProxyView(config proxy.Config) *sessionProxyView {
	redacted := config.Redacted()
	legacy, _ := redacted.Legacy()
	view := &sessionProxyView{
		Upstreams: make(map[string]sessionProxyUpstreamView, len(redacted.Upstreams)),
		Rules:     make([]sessionProxyRuleView, 0, len(redacted.Rules)),
		Upstream:  legacy.Upstream,
		URL:       legacy.URL,
		Bypass:    legacy.Bypass,
	}
	if legacy.TunnelURL != "" {
		view.Tunnel = &sessionProxyUpstreamView{URL: legacy.TunnelURL}
	}
	for name, upstream := range redacted.Upstreams {
		view.Upstreams[name] = sessionProxyUpstreamView{URL: upstream.URL}
	}
	for _, rule := range redacted.Rules {
		view.Rules = append(view.Rules, sessionProxyRuleView{Match: rule.Match, Via: rule.Via})
	}
	return view
}

type sessionResponse struct {
	ID               string                            `json:"id"`
	TenantID         string                            `json:"tenantId"`
	BaseSnapshotName *string                           `json:"baseSnapshotName,omitempty"`
	Label            *string                           `json:"label,omitempty"`
	Status           string                            `json:"status"`
	BrowserChannel   string                            `json:"browserChannel,omitempty"`
	Media            sessionMedia                      `json:"media"`
	CreatedAt        string                            `json:"createdAt"`
	StartedAt        *string                           `json:"startedAt,omitempty"`
	StoppedAt        *string                           `json:"stoppedAt,omitempty"`
	DeletedAt        *string                           `json:"deletedAt"`
	ExpiresAt        string                            `json:"expiresAt"`
	LastConnectedAt  *string                           `json:"lastConnectedAt,omitempty"`
	SuspendedAt      *string                           `json:"suspendedAt,omitempty"`
	Tags             map[string]string                 `json:"tags,omitempty"`
	CDPURL           string                            `json:"cdpUrl,omitempty"`
	SessionToken     string                            `json:"sessionToken,omitempty"`
	Collaboration    *sessionCollaborationCapabilities `json:"collaboration,omitempty"`
	Proxy            *sessionProxyView                 `json:"proxy,omitempty"`
}

type sessionCollaborationCapabilities struct {
	EditorToken string `json:"editorToken"`
	ViewerToken string `json:"viewerToken"`
}

type sessionMedia struct {
	Mode           string              `json:"mode"`
	WebRTCProducer bool                `json:"webrtcProducer"`
	ICEServers     []iceServerResponse `json:"iceServers,omitempty"`
}

type iceServerResponse struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type sessionListItemResponse = sessionResponse

type sessionBulkRequest struct {
	IDs []string `json:"ids"`
}

func (r sessionBulkRequest) Validate() error {
	if len(r.IDs) > 100 {
		return validationError("ids must contain at most 100 entries")
	}
	seen := make(map[string]struct{}, len(r.IDs))
	for _, id := range r.IDs {
		if err := ids.ValidateUUIDv7(id); err != nil {
			return validationError("ids must be uuidv7 values")
		}
		if _, ok := seen[id]; ok {
			return validationError("ids must be unique")
		}
		seen[id] = struct{}{}
	}
	return nil
}

type sessionBulkResponse struct {
	Sessions []sessionResponse `json:"sessions"`
}

type createSessionResponse struct {
	Session      sessionResponse `json:"session"`
	CDPURL       string          `json:"cdpUrl"`
	SessionToken string          `json:"sessionToken"`
}

type sessionMutationResponse struct {
	Session      sessionResponse `json:"session"`
	CDPURL       string          `json:"cdpUrl,omitempty"`
	SessionToken string          `json:"sessionToken,omitempty"`
}

type createSessionFileDownloadURLRequest struct {
	RelativePath string                   `json:"relativePath"`
	TTLSeconds   *int                     `json:"ttlSeconds"`
	Disposition  sessionfiles.Disposition `json:"disposition"`
}

func (r createSessionFileDownloadURLRequest) Validate() error {
	if r.RelativePath == "" {
		return validationError("relativePath is required")
	}
	if r.TTLSeconds != nil && *r.TTLSeconds <= 0 {
		return validationError("ttlSeconds must be positive")
	}
	if r.Disposition != "" && r.Disposition != sessionfiles.DispositionAttachment && r.Disposition != sessionfiles.DispositionInline {
		return validationError("disposition must be attachment or inline")
	}
	return nil
}

type sessionFileDownloadURLResponse struct {
	URL       string    `json:"url"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type promoteSessionRequest struct {
	Name        string            `json:"name"`
	Description *string           `json:"description"`
	Force       bool              `json:"force"`
	Tags        map[string]string `json:"tags"`
}

func (r promoteSessionRequest) Validate() error {
	return validateSnapshotName(r.Name)
}

type snapshotResponse struct {
	ID                    string            `json:"id"`
	Name                  string            `json:"name"`
	Description           *string           `json:"description"`
	TenantID              string            `json:"tenantId"`
	ParentSnapshotID      *string           `json:"parentSnapshotId,omitempty"`
	PromotedFromSessionID *string           `json:"promotedFromSessionId,omitempty"`
	CreatedAt             string            `json:"createdAt"`
	DeletedAt             *string           `json:"deletedAt"`
	ExpiresAt             *string           `json:"expiresAt,omitempty"`
	Tags                  map[string]string `json:"tags,omitempty"`
}

type snapshotListItemResponse = snapshotResponse

type eventListItemResponse struct {
	ID           string          `json:"id"`
	TenantID     string          `json:"tenantId"`
	ResourceType string          `json:"resourceType"`
	ResourceID   string          `json:"resourceId"`
	Type         string          `json:"type"`
	Message      string          `json:"message"`
	Data         json.RawMessage `json:"data"`
	CreatedAt    string          `json:"createdAt"`
}

type promoteSessionResponse struct {
	Snapshot snapshotResponse `json:"snapshot"`
}

type snapshotMutationResponse struct {
	Snapshot snapshotResponse `json:"snapshot"`
}

type updateSnapshotRequest struct {
	Description *string `json:"description"`
}

func (r updateSnapshotRequest) Validate() error {
	return nil
}

type replaceTagsRequest struct {
	Tags map[string]string `json:"tags"`
}

func (r replaceTagsRequest) Validate() error {
	if r.Tags == nil {
		return validationError("tags is required")
	}
	for key, value := range r.Tags {
		if strings.TrimSpace(key) == "" {
			return validationError("tag keys must be non-empty")
		}
		if strings.TrimSpace(value) == "" {
			return validationError("tag values must be non-empty")
		}
	}
	return nil
}

type moveSessionFileRequest struct {
	From string `json:"from"`
	To   string `json:"to"`
}

func (r moveSessionFileRequest) Validate() error {
	if r.From == "" {
		return validationError("from is required")
	}
	if r.To == "" {
		return validationError("to is required")
	}
	return nil
}

type createSessionDirectoryRequest struct {
	RelativePath string `json:"relativePath"`
}

func (r createSessionDirectoryRequest) Validate() error {
	if r.RelativePath == "" {
		return validationError("relativePath is required")
	}
	return nil
}
