ALTER TABLE sessions
    ADD COLUMN browser_mode TEXT NOT NULL DEFAULT 'headed'
    CHECK (browser_mode IN ('headed', 'headless'));

UPDATE sessions
SET browser_args_json = '[]'
WHERE browser_args_json = 'null';
