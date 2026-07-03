PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS snapshot_tags;
DROP TABLE IF EXISTS session_tags;
DROP TABLE IF EXISTS session_tokens;
DROP TABLE IF EXISTS api_tokens;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS snapshots;
DROP TABLE IF EXISTS tenants;
DROP TABLE IF EXISTS schema_migrations;

PRAGMA foreign_keys = ON;
