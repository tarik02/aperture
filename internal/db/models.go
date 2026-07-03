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

	ID            string  `bun:"id,pk"`
	AuthorityType string  `bun:"authority_type,notnull"`
	TenantID      *string `bun:"tenant_id"`
	Name          string  `bun:"name,notnull"`
	TokenHash     string  `bun:"token_hash,notnull"`
	ScopesJSON    string  `bun:"scopes_json,notnull"`
	CreatedAt     string  `bun:"created_at,notnull"`
	ExpiresAt     *string `bun:"expires_at"`
	RevokedAt     *string `bun:"revoked_at"`
}

// Snapshot maps the snapshots table.
type Snapshot struct {
	bun.BaseModel `bun:"table:snapshots"`

	ID                    string  `bun:"id,pk"`
	TenantID              string  `bun:"tenant_id,notnull"`
	Name                  string  `bun:"name,notnull"`
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
}

// SessionToken maps the session_tokens table.
type SessionToken struct {
	bun.BaseModel `bun:"table:session_tokens"`

	SessionID string  `bun:"session_id,pk"`
	TenantID  string  `bun:"tenant_id,notnull"`
	TokenHash string  `bun:"token_hash,notnull"`
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
		(*Snapshot)(nil),
		(*Session)(nil),
		(*SessionToken)(nil),
		(*SessionTag)(nil),
		(*SnapshotTag)(nil),
		(*Event)(nil),
	)
}
