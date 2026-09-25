ALTER TABLE sessions ADD COLUMN proxy_config TEXT;

UPDATE sessions
SET proxy_config = json_object(
  'rules', json_array(json_object('match', '*', 'via', proxy_url))
)
WHERE proxy_upstream = 'proxy' AND proxy_url IS NOT NULL;

UPDATE sessions
SET proxy_config = json_object(
  'upstreams', json_object('tunnel', json_object('url', proxy_tunnel_url, 'auth', proxy_tunnel_auth)),
  'rules', json_array(json_object('match', '*', 'via', 'tunnel'))
)
WHERE proxy_upstream = 'tunnel' AND proxy_tunnel_url IS NOT NULL AND proxy_tunnel_auth IS NOT NULL;

ALTER TABLE sessions DROP COLUMN proxy_bypass;
ALTER TABLE sessions DROP COLUMN proxy_tunnel_auth;
ALTER TABLE sessions DROP COLUMN proxy_tunnel_url;
ALTER TABLE sessions DROP COLUMN proxy_url;
ALTER TABLE sessions DROP COLUMN proxy_upstream;
