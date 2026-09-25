ALTER TABLE sessions ADD COLUMN proxy_upstream TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE sessions ADD COLUMN proxy_url TEXT;
ALTER TABLE sessions ADD COLUMN proxy_tunnel_url TEXT;
ALTER TABLE sessions ADD COLUMN proxy_tunnel_auth TEXT;
ALTER TABLE sessions ADD COLUMN proxy_bypass TEXT;
ALTER TABLE sessions DROP COLUMN proxy_config;
