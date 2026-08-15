CREATE INDEX snapshots_gc_created_id_idx
    ON snapshots (created_at ASC, id ASC)
    WHERE deleted_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND gc_completed_at IS NULL;

CREATE INDEX events_resource_created_id_idx
    ON events (resource_type, resource_id, created_at ASC, id ASC);

CREATE INDEX events_resource_type_id_type_created_id_idx
    ON events (resource_type, resource_id, type, created_at ASC, id ASC);
