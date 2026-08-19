ALTER TABLE sessions
    ADD COLUMN browser_mode TEXT NOT NULL DEFAULT 'headed'
    CHECK (browser_mode IN ('headed', 'headless'));
