-- Names stay unique among live tokens only. Expiry is time-dependent, so a
-- partial unique index cannot express it; CreateAPIToken checks inside its
-- write transaction instead.
DROP INDEX api_tokens_tenant_name_idx;
DROP INDEX api_tokens_system_admin_name_idx;
CREATE INDEX api_tokens_tenant_name_idx ON api_tokens (tenant_id, name);
CREATE INDEX api_tokens_system_admin_name_idx ON api_tokens (authority_type, name)
    WHERE tenant_id IS NULL;
