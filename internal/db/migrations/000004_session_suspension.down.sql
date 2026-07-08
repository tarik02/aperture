PRAGMA foreign_keys = OFF;

CREATE TABLE sessions_old (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    base_snapshot_id TEXT REFERENCES snapshots(id),
    label TEXT,
    status TEXT NOT NULL CHECK (status IN ('creating', 'running', 'deleted', 'expired', 'failed')),
    overlay_path TEXT NOT NULL,
    upper_path TEXT NOT NULL,
    work_path TEXT NOT NULL,
    merged_path TEXT NOT NULL,
    downloads_path TEXT NOT NULL,
    cache_path TEXT NOT NULL,
    artifacts_path TEXT NOT NULL,
    runtime_env_path TEXT,
    current_cdp_port INTEGER,
    browser_channel TEXT NOT NULL,
    browser_args_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    stopped_at TEXT,
    deleted_at TEXT,
    expires_at TEXT NOT NULL,
    expired_at TEXT
);

INSERT INTO sessions_old (
    id,
    tenant_id,
    base_snapshot_id,
    label,
    status,
    overlay_path,
    upper_path,
    work_path,
    merged_path,
    downloads_path,
    cache_path,
    artifacts_path,
    runtime_env_path,
    current_cdp_port,
    browser_channel,
    browser_args_json,
    created_at,
    started_at,
    stopped_at,
    deleted_at,
    expires_at,
    expired_at
)
SELECT
    id,
    tenant_id,
    base_snapshot_id,
    label,
    CASE WHEN status = 'suspended' THEN 'failed' ELSE status END,
    overlay_path,
    upper_path,
    work_path,
    merged_path,
    downloads_path,
    cache_path,
    artifacts_path,
    runtime_env_path,
    current_cdp_port,
    browser_channel,
    browser_args_json,
    created_at,
    started_at,
    stopped_at,
    deleted_at,
    expires_at,
    expired_at
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_old RENAME TO sessions;

PRAGMA foreign_keys = ON;

