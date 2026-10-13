-- A personal tenant belongs to one user. The index skips deleted rows so a
-- user whose personal tenant was deleted can get a fresh one.
ALTER TABLE tenants ADD COLUMN owner_user_id TEXT REFERENCES users(id);
CREATE UNIQUE INDEX tenants_owner_user_idx ON tenants (owner_user_id)
    WHERE owner_user_id IS NOT NULL AND deleted_at IS NULL;
