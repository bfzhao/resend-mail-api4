-- 010 · Setup wizard foundation: application config + admin account
--
-- Background: to wrap the project into a wizard of "enter domain → complete authentication → log in to webmail", two things are needed:
--   1) a key/value table holding the wizard's output (domain / sender address / session secret …), stored in the user's own D1;
--   2) an admin account table, letting the wizard set a password self-service in the app (no longer relying solely on env Basic Auth at deploy time).
--
-- Kept byte-for-byte identical to the corresponding section in schema.sql (both the full database creation and incremental upgrade paths).

CREATE TABLE IF NOT EXISTS app_config (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
