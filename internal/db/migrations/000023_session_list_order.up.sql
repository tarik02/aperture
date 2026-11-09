-- Every write path sets last_connected_at now; rows from before that fall back
-- to their last start, so the session list can page by last activity.
UPDATE sessions
SET last_connected_at = COALESCE(started_at, created_at)
WHERE last_connected_at IS NULL;

CREATE INDEX sessions_tenant_created_id_idx
    ON sessions (tenant_id, created_at DESC, id DESC);

CREATE INDEX sessions_tenant_last_connected_id_idx
    ON sessions (tenant_id, last_connected_at DESC, id DESC);
