-- Durable exact-normalised ad fingerprints. Messages with a matching fingerprint are skipped before matching.
CREATE TABLE IF NOT EXISTS blocked_advertisements (
  id bigserial PRIMARY KEY,
  fingerprint text NOT NULL UNIQUE,
  norm_text text NOT NULL,
  sample_text text NOT NULL,
  reason text NOT NULL DEFAULT 'operator marked as advertisement',
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS blocked_advertisements_created_idx ON blocked_advertisements (created_at DESC);
