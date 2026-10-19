-- Usage statistics cache (frontend shows D1 / R2 usage percentage so you know ahead of time when to upgrade).
-- Values are **estimates**: D1 = sum of UTF-8 bytes of text/binary columns across tables; R2 = sum of listed objects. See getStorageUsage in src/repo.ts.
-- Computing it live is expensive (D1 full-table scan / R2 listing billed as Class A), so it is cached here with a TTL.
CREATE TABLE IF NOT EXISTS app_stats (
    key        TEXT PRIMARY KEY,                    -- e.g. 'd1_bytes' / 'r2_bytes' / 'r2_objects'
    value      INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
