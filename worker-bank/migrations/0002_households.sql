-- v1 (device pairing) -> v2 (household accounts). Run once on the existing database:
--   1. this file's ALTER statements (they fail harmlessly if the column already exists),
--   2. then schema.sql, which creates the new tables.
-- The old devices and inbox tables are left in place, unused, so nothing is lost. Drop them later if you like.
ALTER TABLE items ADD COLUMN household_id TEXT;
ALTER TABLE items ADD COLUMN added_by TEXT;
