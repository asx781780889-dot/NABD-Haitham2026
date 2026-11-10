-- Keep only unmatched messages older than 24 hours eligible for the existing cleanup flow.
-- Change the previous default only; preserve any deliberate custom retention setting.
UPDATE settings
SET value = '1'::jsonb,
    updated_at = now()
WHERE key = 'database.retention_unmatched_days'
  AND value = '7'::jsonb;
