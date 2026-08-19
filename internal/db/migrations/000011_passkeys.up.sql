CREATE TABLE webauthn_user_handles (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rp_id TEXT NOT NULL,
    handle BLOB NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, rp_id),
    UNIQUE (rp_id, handle)
);

CREATE TABLE passkeys (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rp_id TEXT NOT NULL,
    name TEXT NOT NULL,
    credential_id BLOB NOT NULL,
    credential_json BLOB NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    UNIQUE (rp_id, credential_id)
);

CREATE INDEX passkeys_user_rp_idx ON passkeys (user_id, rp_id, created_at, id);
