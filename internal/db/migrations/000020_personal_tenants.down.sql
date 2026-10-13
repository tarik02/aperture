DROP INDEX IF EXISTS tenants_owner_user_idx;
ALTER TABLE tenants DROP COLUMN owner_user_id;
