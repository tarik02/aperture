CREATE TABLE users (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT COLLATE NOCASE,
    display_name TEXT NOT NULL,
    is_system_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_system_admin IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    disabled_at TEXT
);

CREATE UNIQUE INDEX users_email_idx ON users (email) WHERE email IS NOT NULL;

CREATE TABLE tenant_memberships (
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    scopes_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX tenant_memberships_user_idx ON tenant_memberships (user_id, tenant_id);

CREATE TABLE audit_events (
    id TEXT PRIMARY KEY NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('api_token', 'user', 'system')),
    actor_id TEXT,
    tenant_id TEXT REFERENCES tenants(id),
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX audit_events_created_idx ON audit_events (created_at DESC, id DESC);
CREATE INDEX audit_events_tenant_created_idx ON audit_events (tenant_id, created_at DESC, id DESC);
CREATE INDEX audit_events_actor_created_idx ON audit_events (actor_type, actor_id, created_at DESC, id DESC);
