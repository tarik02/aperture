DROP INDEX IF EXISTS audit_events_actor_created_idx;
DROP INDEX IF EXISTS audit_events_tenant_created_idx;
DROP INDEX IF EXISTS audit_events_created_idx;
DROP TABLE IF EXISTS audit_events;
DROP INDEX IF EXISTS tenant_memberships_user_idx;
DROP TABLE IF EXISTS tenant_memberships;
DROP INDEX IF EXISTS users_email_idx;
DROP TABLE IF EXISTS users;
