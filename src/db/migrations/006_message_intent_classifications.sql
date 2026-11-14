CREATE TABLE message_intent_classifications (
  id bigserial PRIMARY KEY,
  message_id bigint NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (label IN ('NEED_HELP','ADVERTISEMENT','UNCERTAIN')),
  confidence numeric(5,2) NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  reason text NOT NULL DEFAULT '',
  method text NOT NULL DEFAULT 'rules' CHECK (method IN ('rules','ai','fallback','similarity','backfill')),
  provider text,
  model text,
  latency_ms int,
  reviewed_label text CHECK (reviewed_label IN ('NEED_HELP','ADVERTISEMENT','UNCERTAIN')),
  reviewed_by bigint REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_intent_label_created_idx ON message_intent_classifications (label, created_at DESC);
CREATE INDEX message_intent_review_queue_idx ON message_intent_classifications (created_at DESC) WHERE label = 'UNCERTAIN' AND reviewed_at IS NULL;

-- Preserve the existing live-feed history and route unmatched historical intent to operator review.
INSERT INTO message_intent_classifications (message_id, label, confidence, reason, method, created_at)
SELECT m.id, 'UNCERTAIN', 0, 'بطاقة سابقة لم يسبق تصنيفها؛ أُحيلت إلى المراجعة.', 'backfill', mm.created_at
FROM message_matches mm JOIN messages m ON m.id = mm.message_id
WHERE mm.deleted_at IS NULL AND mm.status <> 'ignored' AND m.deleted_at IS NULL
ON CONFLICT (message_id) DO NOTHING;
