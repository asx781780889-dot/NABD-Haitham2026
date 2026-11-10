-- Enable monitoring for every Telegram group already known to the application.
-- Soft-deleted sources remain untouched.
UPDATE telegram_sources
SET monitoring_enabled = true
WHERE kind IN ('group', 'supergroup')
  AND deleted_at IS NULL
  AND monitoring_enabled = false;
