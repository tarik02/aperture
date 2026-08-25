CREATE TABLE session_collaboration_capabilities (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    token_hash TEXT NOT NULL,
    raw_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    PRIMARY KEY (session_id, role)
);
