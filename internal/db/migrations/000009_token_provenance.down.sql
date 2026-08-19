DROP INDEX IF EXISTS api_tokens_parent_idx;
ALTER TABLE api_tokens DROP COLUMN parent_token_id;
ALTER TABLE api_tokens DROP COLUMN created_by_id;
ALTER TABLE api_tokens DROP COLUMN created_by_type;
