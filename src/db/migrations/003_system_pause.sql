-- The persistent system pause flag is stored through the existing settings table.
-- This migration is intentionally idempotent and documents the feature in schema history.
INSERT INTO settings (key, value, is_secret)
VALUES ('system.paused', 'false'::jsonb, false)
ON CONFLICT (key) DO NOTHING;
