-- Initial aperture orchestration schema.

PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    applied_at TEXT NOT NULL
);

CREATE TABLE tenants (
    id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE TABLE snapshots (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    parent_snapshot_id TEXT REFERENCES snapshots(id),
    promoted_from_session_id TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    expires_at TEXT,
    gc_completed_at TEXT,
    UNIQUE (tenant_id, name)
);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    base_snapshot_id TEXT REFERENCES snapshots(id),
    status TEXT NOT NULL CHECK (status IN ('creating', 'running', 'deleted', 'expired', 'failed')),
    overlay_path TEXT NOT NULL,
    upper_path TEXT NOT NULL,
    work_path TEXT NOT NULL,
    merged_path TEXT NOT NULL,
    downloads_path TEXT NOT NULL,
    cache_path TEXT NOT NULL,
    artifacts_path TEXT NOT NULL,
    runtime_env_path TEXT,
    current_cdp_port INTEGER,
    browser_channel TEXT NOT NULL,
    browser_args_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    stopped_at TEXT,
    deleted_at TEXT,
    expires_at TEXT NOT NULL,
    expired_at TEXT
);

CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY NOT NULL,
    authority_type TEXT NOT NULL CHECK (authority_type IN ('system_admin', 'tenant')),
    tenant_id TEXT REFERENCES tenants(id),
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    CHECK (
        (authority_type = 'system_admin' AND tenant_id IS NULL) OR
        (authority_type = 'tenant' AND tenant_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX api_tokens_tenant_name_idx ON api_tokens (tenant_id, name);
CREATE UNIQUE INDEX api_tokens_system_admin_name_idx ON api_tokens (authority_type, name)
    WHERE tenant_id IS NULL;

CREATE TABLE session_tokens (
    session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id),
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
);

CREATE TABLE session_tags (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (session_id, key)
);

CREATE TABLE snapshot_tags (
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, key)
);

CREATE TABLE events (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
