package db

import (
	"github.com/uptrace/bun"
)

// SchemaMigration tracks applied SQL migrations.
type SchemaMigration struct {
	bun.BaseModel `bun:"table:schema_migrations"`

	Version   int    `bun:"version,pk"`
	AppliedAt string `bun:"applied_at,notnull"`
}

// Tenant maps the tenants table.
type Tenant struct {
	bun.BaseModel `bun:"table:tenants"`

	ID          string  `bun:"id,pk"`
	DisplayName string  `bun:"display_name,notnull"`
	CreatedAt   string  `bun:"created_at,notnull"`
	DeletedAt   *string `bun:"deleted_at"`
}

// APIToken maps the api_tokens table.
type APIToken struct {
	bun.BaseModel `bun:"table:api_tokens"`

	ID             string                  `bun:"id,pk"`
	AuthorityType  string                  `bun:"authority_type,notnull"`
	TenantID       *string                 `bun:"tenant_id"`
	Name           string                  `bun:"name,notnull"`
	TokenHash      string                  `bun:"token_hash,notnull"`
	ScopesJSON     string                  `bun:"scopes_json,notnull"`
	CreatedAt      string                  `bun:"created_at,notnull"`
	CreatedByType  string                  `bun:"created_by_type,notnull"`
	CreatedByID    *string                 `bun:"created_by_id"`
	ParentTokenID  *string                 `bun:"parent_token_id"`
	ResourceMode   string                  `bun:"resource_mode,notnull"`
	ExpiresAt      *string                 `bun:"expires_at"`
	RevokedAt      *string                 `bun:"revoked_at"`
	ResourceGrants []APITokenResourceGrant `bun:"-"`
}

// APITokenResourceGrant restricts a token to one session or snapshot.
type APITokenResourceGrant struct {
	bun.BaseModel `bun:"table:api_token_resource_grants"`

	TokenID      string `bun:"token_id,pk"`
	ResourceType string `bun:"resource_type,pk"`
	ResourceID   string `bun:"resource_id,pk"`
}

// ResourceIDFilter limits a query to an explicit set of resource ids.
type ResourceIDFilter struct {
	Restricted bool
	IDs        []string
}

// ResourceReference identifies a resource for polymorphic event filtering.
type ResourceReference struct {
	ResourceType string
	ResourceID   string
}

// User maps the users table.
type User struct {
	bun.BaseModel `bun:"table:users"`

	ID            string  `bun:"id,pk"`
	Email         *string `bun:"email"`
	DisplayName   string  `bun:"display_name,notnull"`
	IsSystemAdmin bool    `bun:"is_system_admin,notnull"`
	CreatedAt     string  `bun:"created_at,notnull"`
	UpdatedAt     string  `bun:"updated_at,notnull"`
	DisabledAt    *string `bun:"disabled_at"`
}

// TenantMembership maps a user's tenant scopes.
type TenantMembership struct {
	bun.BaseModel `bun:"table:tenant_memberships"`

	TenantID   string `bun:"tenant_id,pk"`
	UserID     string `bun:"user_id,pk"`
	ScopesJSON string `bun:"scopes_json,notnull"`
	CreatedAt  string `bun:"created_at,notnull"`
	UpdatedAt  string `bun:"updated_at,notnull"`
}

// AuditEvent maps security and administration audit entries.
type AuditEvent struct {
	bun.BaseModel `bun:"table:audit_events"`

	ID           string  `bun:"id,pk"`
	ActorType    string  `bun:"actor_type,notnull"`
	ActorID      *string `bun:"actor_id"`
	TenantID     *string `bun:"tenant_id"`
	Action       string  `bun:"action,notnull"`
	ResourceType string  `bun:"resource_type,notnull"`
	ResourceID   *string `bun:"resource_id"`
	DataJSON     string  `bun:"data_json,notnull"`
	CreatedAt    string  `bun:"created_at,notnull"`
}

// OIDCIdentity maps an OIDC provider subject to a user.
type OIDCIdentity struct {
	bun.BaseModel `bun:"table:oidc_identities"`

	ProviderID  string  `bun:"provider_id,pk"`
	Subject     string  `bun:"subject,pk"`
	UserID      string  `bun:"user_id,notnull"`
	Email       *string `bun:"email"`
	CreatedAt   string  `bun:"created_at,notnull"`
	LastLoginAt string  `bun:"last_login_at,notnull"`
}

// Snapshot maps the snapshots table.
type Snapshot struct {
	bun.BaseModel `bun:"table:snapshots"`

	ID                    string  `bun:"id,pk"`
	TenantID              string  `bun:"tenant_id,notnull"`
	Name                  string  `bun:"name,notnull"`
	Description           *string `bun:"description"`
	Path                  string  `bun:"path,notnull"`
	ParentSnapshotID      *string `bun:"parent_snapshot_id"`
	PromotedFromSessionID *string `bun:"promoted_from_session_id"`
	CreatedAt             string  `bun:"created_at,notnull"`
	DeletedAt             *string `bun:"deleted_at"`
	ExpiresAt             *string `bun:"expires_at"`
	GCCompletedAt         *string `bun:"gc_completed_at"`
}

// Session maps the sessions table.
type Session struct {
	bun.BaseModel `bun:"table:sessions"`

	ID              string  `bun:"id,pk"`
	TenantID        string  `bun:"tenant_id,notnull"`
	BaseSnapshotID  *string `bun:"base_snapshot_id"`
	Label           *string `bun:"label"`
	Status          string  `bun:"status,notnull"`
	OverlayPath     string  `bun:"overlay_path,notnull"`
	UpperPath       string  `bun:"upper_path,notnull"`
	WorkPath        string  `bun:"work_path,notnull"`
	MergedPath      string  `bun:"merged_path,notnull"`
	DownloadsPath   string  `bun:"downloads_path,notnull"`
	CachePath       string  `bun:"cache_path,notnull"`
	ArtifactsPath   string  `bun:"artifacts_path,notnull"`
	RuntimeEnvPath  *string `bun:"runtime_env_path"`
	CurrentCDPPort  *int    `bun:"current_cdp_port"`
	BrowserChannel  string  `bun:"browser_channel,notnull"`
	BrowserArgsJSON string  `bun:"browser_args_json,notnull"`
	CreatedAt       string  `bun:"created_at,notnull"`
	StartedAt       *string `bun:"started_at"`
	StoppedAt       *string `bun:"stopped_at"`
	DeletedAt       *string `bun:"deleted_at"`
	ExpiresAt       string  `bun:"expires_at,notnull"`
	ExpiredAt       *string `bun:"expired_at"`
	LastConnectedAt *string `bun:"last_connected_at"`
	SuspendedAt     *string `bun:"suspended_at"`
}

// SessionToken maps the session_tokens table.
type SessionToken struct {
	bun.BaseModel `bun:"table:session_tokens"`

	SessionID string  `bun:"session_id,pk"`
	TenantID  string  `bun:"tenant_id,notnull"`
	TokenHash string  `bun:"token_hash,notnull"`
	RawToken  *string `bun:"raw_token"`
	CreatedAt string  `bun:"created_at,notnull"`
	RevokedAt *string `bun:"revoked_at"`
}

// SessionTag maps the session_tags table.
type SessionTag struct {
	bun.BaseModel `bun:"table:session_tags"`

	SessionID string `bun:"session_id,pk"`
	Key       string `bun:"key,pk"`
	Value     string `bun:"value,notnull"`
}

// SnapshotTag maps the snapshot_tags table.
type SnapshotTag struct {
	bun.BaseModel `bun:"table:snapshot_tags"`

	SnapshotID string `bun:"snapshot_id,pk"`
	Key        string `bun:"key,pk"`
	Value      string `bun:"value,notnull"`
}

// Event maps the events table.
type Event struct {
	bun.BaseModel `bun:"table:events"`

	ID           string `bun:"id,pk"`
	TenantID     string `bun:"tenant_id,notnull"`
	ResourceType string `bun:"resource_type,notnull"`
	ResourceID   string `bun:"resource_id,notnull"`
	Type         string `bun:"type,notnull"`
	Message      string `bun:"message,notnull"`
	DataJSON     string `bun:"data_json,notnull"`
	CreatedAt    string `bun:"created_at,notnull"`
}

// RegisterModels registers Bun models on db.
func RegisterModels(db *bun.DB) {
	db.RegisterModel(
		(*SchemaMigration)(nil),
		(*Tenant)(nil),
		(*APIToken)(nil),
		(*User)(nil),
		(*TenantMembership)(nil),
		(*AuditEvent)(nil),
		(*OIDCIdentity)(nil),
		(*Snapshot)(nil),
		(*Session)(nil),
		(*SessionToken)(nil),
		(*SessionTag)(nil),
		(*SnapshotTag)(nil),
		(*Event)(nil),
	)
}
