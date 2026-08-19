ALTER TABLE api_tokens ADD COLUMN resource_mode TEXT NOT NULL DEFAULT 'all'
    CHECK (resource_mode IN ('all', 'allowlist'));

CREATE TABLE api_token_resource_grants (
    token_id TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('session', 'snapshot')),
    resource_id TEXT NOT NULL,
    PRIMARY KEY (token_id, resource_type, resource_id)
);
