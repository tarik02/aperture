-- Index tenant-scoped pagination and the lifecycle queries used by the
-- session, snapshot, event, and garbage-collection services.

CREATE INDEX sessions_tenant_created_id_idx
    ON sessions (tenant_id, created_at DESC, id DESC);

CREATE INDEX sessions_tenant_status_created_id_idx
    ON sessions (tenant_id, status, created_at DESC, id DESC);

CREATE INDEX sessions_status_created_id_idx
    ON sessions (status, created_at ASC, id ASC);

CREATE INDEX sessions_active_tenant_created_id_idx
    ON sessions (tenant_id, created_at DESC, id DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX sessions_idle_status_at_idx
    ON sessions (status, COALESCE(last_connected_at, started_at, created_at), id);

CREATE INDEX sessions_base_snapshot_status_idx
    ON sessions (base_snapshot_id, status);

CREATE INDEX sessions_expiry_created_id_idx
    ON sessions (expires_at, created_at ASC, id ASC);

CREATE INDEX sessions_expired_artifacts_created_id_idx
    ON sessions (expired_at, created_at ASC, id ASC)
    WHERE expired_at IS NOT NULL;

CREATE INDEX snapshots_tenant_created_id_idx
    ON snapshots (tenant_id, created_at DESC, id DESC);

CREATE INDEX snapshots_active_tenant_created_id_idx
    ON snapshots (tenant_id, created_at DESC, id DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX snapshots_gc_created_id_idx
    ON snapshots (created_at ASC, id ASC)
    WHERE deleted_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND gc_completed_at IS NULL;

CREATE INDEX events_tenant_created_id_idx
    ON events (tenant_id, created_at DESC, id DESC);

CREATE INDEX events_tenant_resource_created_id_idx
    ON events (tenant_id, resource_type, resource_id, created_at DESC, id DESC);

CREATE INDEX events_resource_created_id_idx
    ON events (resource_type, resource_id, created_at ASC, id ASC);

CREATE INDEX events_resource_type_id_type_created_id_idx
    ON events (resource_type, resource_id, type, created_at ASC, id ASC);
