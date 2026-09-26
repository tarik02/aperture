CREATE TABLE install_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  install_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO install_identity (id, install_id, created_at)
VALUES (1, lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
