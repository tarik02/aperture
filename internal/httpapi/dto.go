package httpapi

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
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
	Name      string   `json:"name"`
	Scopes    []string `json:"scopes"`
	ExpiresAt *string  `json:"expiresAt"`
}

func (r createTenantLocalTokenRequest) Validate() error {
	if strings.TrimSpace(r.Name) == "" {
		return validationError("name is required")
	}
	if len(r.Scopes) == 0 {
		return validationError("scopes is required")
	}
	if r.ExpiresAt != nil && strings.TrimSpace(*r.ExpiresAt) != "" {
		if _, err := time.Parse(time.RFC3339Nano, *r.ExpiresAt); err != nil {
			return validationError("expiresAt must be RFC3339Nano")
		}
	}
	return nil
}

type createTokenRequest struct {
	Name          string   `json:"name"`
	AuthorityType string   `json:"authorityType"`
	TenantID      *string  `json:"tenantId"`
	Scopes        []string `json:"scopes"`
	ExpiresAt     *string  `json:"expiresAt"`
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
	if r.ExpiresAt != nil && strings.TrimSpace(*r.ExpiresAt) != "" {
		if _, err := time.Parse(time.RFC3339Nano, *r.ExpiresAt); err != nil {
			return validationError("expiresAt must be RFC3339Nano")
		}
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
	TokenID       string   `json:"tokenId"`
	Name          string   `json:"name"`
	AuthorityType string   `json:"authorityType"`
	TenantID      *string  `json:"tenantId"`
	Scopes        []string `json:"scopes"`
}

type authMeResponse struct {
	Principal      principalResponse `json:"principal"`
	SelectedTenant *tenantResponse   `json:"selectedTenant"`
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
	ID            string   `json:"id"`
	AuthorityType string   `json:"authorityType"`
	TenantID      *string  `json:"tenantId"`
	Name          string   `json:"name"`
	Scopes        []string `json:"scopes"`
	CreatedAt     string   `json:"createdAt"`
	ExpiresAt     *string  `json:"expiresAt"`
	RevokedAt     *string  `json:"revokedAt"`
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
	Tags             map[string]string    `json:"tags"`
}

func (r createSessionRequest) Validate() error {
	return r.Browser.Validate()
}

type sessionResponse struct {
	ID               string            `json:"id"`
	TenantID         string            `json:"tenantId"`
	BaseSnapshotName *string           `json:"baseSnapshotName,omitempty"`
	Label            *string           `json:"label,omitempty"`
	Status           string            `json:"status"`
	BrowserChannel   string            `json:"browserChannel,omitempty"`
	Media            sessionMedia      `json:"media"`
	CreatedAt        string            `json:"createdAt"`
	StartedAt        *string           `json:"startedAt,omitempty"`
	StoppedAt        *string           `json:"stoppedAt,omitempty"`
	DeletedAt        *string           `json:"deletedAt"`
	ExpiresAt        string            `json:"expiresAt"`
	LastConnectedAt  *string           `json:"lastConnectedAt,omitempty"`
	SuspendedAt      *string           `json:"suspendedAt,omitempty"`
	Tags             map[string]string `json:"tags,omitempty"`
	CDPURL           string            `json:"cdpUrl,omitempty"`
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

type createSessionResponse struct {
	Session  sessionResponse `json:"session"`
	CDPURL   string          `json:"cdpUrl"`
	CDPToken string          `json:"cdpToken"`
}

type sessionMutationResponse struct {
	Session  sessionResponse `json:"session"`
	CDPURL   string          `json:"cdpUrl,omitempty"`
	CDPToken string          `json:"cdpToken,omitempty"`
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
