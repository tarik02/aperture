ALTER TABLE api_tokens ADD COLUMN created_by_type TEXT NOT NULL DEFAULT 'system'
    CHECK (created_by_type IN ('api_token', 'user', 'system'));
ALTER TABLE api_tokens ADD COLUMN created_by_id TEXT;
ALTER TABLE api_tokens ADD COLUMN parent_token_id TEXT REFERENCES api_tokens(id);

CREATE INDEX api_tokens_parent_idx ON api_tokens (parent_token_id);
