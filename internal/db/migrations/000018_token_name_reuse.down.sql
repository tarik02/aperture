DROP INDEX api_tokens_tenant_name_idx;
DROP INDEX api_tokens_system_admin_name_idx;
CREATE UNIQUE INDEX api_tokens_tenant_name_idx ON api_tokens (tenant_id, name);
CREATE UNIQUE INDEX api_tokens_system_admin_name_idx ON api_tokens (authority_type, name)
    WHERE tenant_id IS NULL;
