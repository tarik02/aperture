CREATE TABLE oauth_clients (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('registered', 'metadata_document')),
    client_name TEXT NOT NULL,
    client_uri TEXT,
    logo_uri TEXT,
    redirect_uris_json TEXT NOT NULL,
    token_endpoint_auth_method TEXT NOT NULL
        CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
    client_secret_hash TEXT,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE oauth_authorization_codes (
    id TEXT PRIMARY KEY NOT NULL,
    code_hash TEXT NOT NULL,
    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    resource TEXT,
    consent_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    grant_id TEXT
);

CREATE TABLE oauth_grants (
    id TEXT PRIMARY KEY NOT NULL,
    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    authority_type TEXT NOT NULL CHECK (authority_type IN ('system_admin', 'tenant')),
    scopes_json TEXT NOT NULL,
    resource_mode TEXT NOT NULL CHECK (resource_mode IN ('all', 'allowlist')),
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
);

CREATE INDEX oauth_grants_user_idx ON oauth_grants (user_id, created_at, id);

CREATE TABLE oauth_grant_tenants (
    grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    PRIMARY KEY (grant_id, tenant_id)
);

CREATE TABLE oauth_grant_resource_grants (
    grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('session', 'snapshot')),
    resource_id TEXT NOT NULL,
    PRIMARY KEY (grant_id, resource_type, resource_id)
);

CREATE TABLE oauth_tokens (
    id TEXT PRIMARY KEY NOT NULL,
    grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
);

CREATE INDEX oauth_tokens_grant_idx ON oauth_tokens (grant_id, kind);
