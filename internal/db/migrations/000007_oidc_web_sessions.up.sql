CREATE TABLE oidc_identities (
    provider_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    email TEXT COLLATE NOCASE,
    created_at TEXT NOT NULL,
    last_login_at TEXT NOT NULL,
    PRIMARY KEY (provider_id, subject)
);

CREATE INDEX oidc_identities_user_idx ON oidc_identities (user_id, provider_id);

CREATE TABLE web_sessions (
    token_hash TEXT PRIMARY KEY NOT NULL,
    data BLOB NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX web_sessions_expiry_idx ON web_sessions (expires_at);
