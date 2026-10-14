-- A personal tenant belongs to its owner alone: nobody else is a member, and
-- the only tenant tokens it keeps are the ones the owner minted, directly or
-- through a token the owner minted.
DELETE FROM tenant_memberships
WHERE EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = tenant_memberships.tenant_id
        AND tenants.owner_user_id IS NOT NULL
        AND tenants.owner_user_id <> tenant_memberships.user_id
);

WITH RECURSIVE owner_tokens(id) AS (
    SELECT api_tokens.id FROM api_tokens
    JOIN tenants ON tenants.id = api_tokens.tenant_id
    WHERE tenants.owner_user_id IS NOT NULL
        AND api_tokens.created_by_type = 'user'
        AND api_tokens.created_by_id = tenants.owner_user_id
    UNION
    SELECT child.id FROM api_tokens AS child
    JOIN owner_tokens ON child.parent_token_id = owner_tokens.id
)
UPDATE api_tokens
SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE revoked_at IS NULL
    AND tenant_id IN (SELECT id FROM tenants WHERE owner_user_id IS NOT NULL)
    AND id NOT IN (SELECT id FROM owner_tokens);

CREATE TRIGGER tenants_owner_user_immutable
BEFORE UPDATE OF owner_user_id ON tenants
WHEN OLD.owner_user_id IS NOT NEW.owner_user_id
BEGIN
    SELECT RAISE(ABORT, 'personal tenant owner is immutable');
END;

CREATE TRIGGER tenant_memberships_personal_owner_insert
BEFORE INSERT ON tenant_memberships
WHEN EXISTS (
    SELECT 1 FROM tenants
    WHERE id = NEW.tenant_id AND owner_user_id IS NOT NULL AND owner_user_id <> NEW.user_id
)
BEGIN
    SELECT RAISE(ABORT, 'personal tenant membership is owner-only');
END;

CREATE TRIGGER tenant_memberships_personal_owner_update
BEFORE UPDATE OF tenant_id, user_id ON tenant_memberships
WHEN EXISTS (
    SELECT 1 FROM tenants
    WHERE id = NEW.tenant_id AND owner_user_id IS NOT NULL AND owner_user_id <> NEW.user_id
)
BEGIN
    SELECT RAISE(ABORT, 'personal tenant membership is owner-only');
END;
