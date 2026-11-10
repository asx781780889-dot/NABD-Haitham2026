-- NABD AI schema v1. Foreign keys, unique constraints, indexes, soft delete, append-only audit log.
-- Arabic-aware normalisation for search (alef/ya/ta-marbuta variants, diacritics, tatweel); IMMUTABLE so it can back an index.
CREATE OR REPLACE FUNCTION nabd_norm(t text) RETURNS text AS $$
  SELECT btrim(regexp_replace(translate(lower(regexp_replace(COALESCE(t, ''), '[\u064B-\u065F\u0670\u0640]', '', 'g')), 'أإآٱىةؤئ', 'اااايهوي'), '\s+', ' ', 'g'))
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

CREATE TABLE users (
  id bigserial PRIMARY KEY,
  username text NOT NULL,
  email text,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','operator','viewer')),
  display_name text,
  language text NOT NULL DEFAULT 'ar',
  theme text NOT NULL DEFAULT 'dark',
  is_active boolean NOT NULL DEFAULT true,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX users_username_uq ON users (lower(username)) WHERE deleted_at IS NULL;

CREATE TABLE user_sessions (
  id bigserial PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  ip text, user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);
CREATE INDEX user_sessions_exp_idx ON user_sessions (expires_at);

CREATE TABLE telegram_accounts (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  description text,
  tags text[] NOT NULL DEFAULT '{}',
  phone_enc text NOT NULL,
  phone_masked text NOT NULL,
  phone_hash text NOT NULL,
  api_id_enc text NOT NULL,
  api_hash_enc text NOT NULL,
  tg_user_id bigint, tg_username text, tg_first_name text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','connecting','connected','disconnected','error','auth_required','disabled')),
  enabled boolean NOT NULL DEFAULT true,
  last_connected_at timestamptz, last_error text, last_error_at timestamptz,
  reconnect_attempts int NOT NULL DEFAULT 0,
  cooldown_until timestamptz,
  groups_count int NOT NULL DEFAULT 0, channels_count int NOT NULL DEFAULT 0, chats_count int NOT NULL DEFAULT 0,
  messages_processed bigint NOT NULL DEFAULT 0, matches_count bigint NOT NULL DEFAULT 0, errors_count bigint NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX telegram_accounts_phone_uq ON telegram_accounts (phone_hash) WHERE deleted_at IS NULL;

CREATE TABLE telegram_sessions (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES telegram_accounts(id) ON DELETE CASCADE,
  session_enc text NOT NULL,
  dc_id int,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX telegram_sessions_active_uq ON telegram_sessions (account_id) WHERE is_active;

CREATE TABLE telegram_sources (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES telegram_accounts(id) ON DELETE CASCADE,
  tg_chat_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('group','supergroup','channel','private','saved')),
  title text, username text, members_count int,
  monitoring_enabled boolean NOT NULL DEFAULT false,
  priority_weight int NOT NULL DEFAULT 0 CHECK (priority_weight BETWEEN -30 AND 30),
  ai_rule_ids bigint[] NOT NULL DEFAULT '{}',
  keyword_ids bigint[] NOT NULL DEFAULT '{}',
  settings jsonb NOT NULL DEFAULT '{}',
  last_tg_message_id bigint, last_message_at timestamptz,
  messages_count bigint NOT NULL DEFAULT 0, matches_count bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (account_id, tg_chat_id)
);
CREATE INDEX telegram_sources_monitor_idx ON telegram_sources (account_id) WHERE monitoring_enabled AND deleted_at IS NULL;
CREATE VIEW telegram_groups AS SELECT * FROM telegram_sources WHERE kind IN ('group','supergroup') AND deleted_at IS NULL;
CREATE VIEW telegram_channels AS SELECT * FROM telegram_sources WHERE kind = 'channel' AND deleted_at IS NULL;

CREATE TABLE messages (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES telegram_accounts(id) ON DELETE CASCADE,
  source_id bigint NOT NULL REFERENCES telegram_sources(id) ON DELETE CASCADE,
  tg_chat_id bigint NOT NULL,
  tg_message_id bigint NOT NULL,
  sender_id bigint, sender_username text, sender_name text,
  text text, lang text, has_media boolean NOT NULL DEFAULT false, reply_to_id bigint,
  sent_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','done','failed','skipped')),
  skip_reason text,
  attempts int NOT NULL DEFAULT 0,
  error text,
  claimed_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (account_id, tg_chat_id, tg_message_id)
);
CREATE INDEX messages_state_idx ON messages (created_at) WHERE state IN ('pending','processing');
CREATE INDEX messages_unmatched_cleanup_idx ON messages (created_at) WHERE deleted_at IS NULL;
CREATE INDEX messages_sent_idx ON messages (sent_at DESC);
CREATE INDEX messages_source_idx ON messages (source_id, sent_at DESC);
CREATE INDEX messages_sender_idx ON messages (sender_id);
CREATE INDEX messages_created_idx ON messages (created_at);
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS messages_text_trgm ON messages USING gin (nabd_norm(text) gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_trgm unavailable, search falls back to ILIKE scans: %', SQLERRM;
END $$;

CREATE TABLE ai_rules (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  intent text NOT NULL,
  intent_description text,
  signals text[] NOT NULL DEFAULT '{}',
  negative_signals text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  min_score int NOT NULL DEFAULT 70 CHECK (min_score BETWEEN 0 AND 100),
  ai_mode text NOT NULL DEFAULT 'uncertain' CHECK (ai_mode IN ('off','uncertain','always')),
  context_mode text NOT NULL DEFAULT 'none' CHECK (context_mode IN ('none','before','after','both')),
  priority_hint text CHECK (priority_hint IN ('low','medium','high','critical')),
  hits bigint NOT NULL DEFAULT 0, confirmed bigint NOT NULL DEFAULT 0, rejected bigint NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE keywords (
  id bigserial PRIMARY KEY,
  ai_rule_id bigint REFERENCES ai_rules(id) ON DELETE SET NULL,
  phrase text NOT NULL,
  norm_phrase text NOT NULL,
  match_modes text[] NOT NULL DEFAULT '{exact,partial,fuzzy}',
  fuzzy_threshold int NOT NULL DEFAULT 82 CHECK (fuzzy_threshold BETWEEN 50 AND 100),
  context_mode text NOT NULL DEFAULT 'none' CHECK (context_mode IN ('none','before','after','both')),
  context_strict boolean NOT NULL DEFAULT false,
  min_score int NOT NULL DEFAULT 60 CHECK (min_score BETWEEN 0 AND 100),
  weight int NOT NULL DEFAULT 100 CHECK (weight BETWEEN 1 AND 100),
  is_sensitive boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  notes text,
  hits bigint NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX keywords_rule_idx ON keywords (ai_rule_id);
CREATE INDEX keywords_enabled_idx ON keywords (enabled) WHERE deleted_at IS NULL;

CREATE TABLE keyword_variants (
  id bigserial PRIMARY KEY,
  keyword_id bigint NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  phrase text NOT NULL,
  norm_phrase text NOT NULL,
  kind text NOT NULL DEFAULT 'manual' CHECK (kind IN ('synonym','dialect','typo','abbr','ai','manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (keyword_id, norm_phrase)
);

CREATE TABLE ai_results (
  id bigserial PRIMARY KEY,
  message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ai_rule_id bigint NOT NULL REFERENCES ai_rules(id) ON DELETE CASCADE,
  provider text, model text,
  is_match boolean NOT NULL,
  confidence numeric(5,2) NOT NULL,
  intent text, category text, priority text,
  entities jsonb NOT NULL DEFAULT '[]',
  reason text,
  suggested_keywords text[] NOT NULL DEFAULT '{}',
  latency_ms int, tokens_in int, tokens_out int,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, ai_rule_id)
);

CREATE TABLE rules (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  description text,
  enabled boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 100,
  stop_on_match boolean NOT NULL DEFAULT false,
  conditions jsonb NOT NULL,
  actions jsonb NOT NULL,
  hits bigint NOT NULL DEFAULT 0, last_hit_at timestamptz,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE message_matches (
  id bigserial PRIMARY KEY,
  message_id bigint NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  account_id bigint REFERENCES telegram_accounts(id) ON DELETE SET NULL,
  source_id bigint REFERENCES telegram_sources(id) ON DELETE SET NULL,
  ai_rule_id bigint REFERENCES ai_rules(id) ON DELETE SET NULL,
  keyword_id bigint REFERENCES keywords(id) ON DELETE SET NULL,
  rule_id bigint REFERENCES rules(id) ON DELETE SET NULL,
  match_type text NOT NULL CHECK (match_type IN ('exact','partial','fuzzy','synonym','semantic','ai','rule')),
  score numeric(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  bucket smallint GENERATED ALWAYS AS (LEAST(100, GREATEST(10, (CEIL(score / 10.0) * 10)::int))) STORED,
  priority text NOT NULL CHECK (priority IN ('low','medium','high','critical')),
  intent text, ai_confidence numeric(5,2), ai_reason text,
  keyword_text text, context_ok boolean,
  extra jsonb NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','seen','ignored')),
  pinned boolean NOT NULL DEFAULT false,
  feedback text CHECK (feedback IN ('correct','incorrect')),
  exact_hash text, norm_hash text, simhash bigint,
  sh0 int, sh1 int, sh2 int, sh3 int,
  sender_id bigint, chat_id bigint,
  occurrences int NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX matches_created_idx ON message_matches (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX matches_priority_idx ON message_matches (priority, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX matches_bucket_idx ON message_matches (bucket);
CREATE INDEX matches_normhash_idx ON message_matches (norm_hash);
CREATE INDEX matches_sh0_idx ON message_matches (sh0); CREATE INDEX matches_sh1_idx ON message_matches (sh1);
CREATE INDEX matches_sh2_idx ON message_matches (sh2); CREATE INDEX matches_sh3_idx ON message_matches (sh3);
CREATE INDEX matches_sender_idx ON message_matches (sender_id);
CREATE INDEX matches_rule_idx ON message_matches (ai_rule_id);
CREATE INDEX matches_source_idx ON message_matches (source_id);

CREATE TABLE match_occurrences (
  id bigserial PRIMARY KEY,
  match_id bigint NOT NULL REFERENCES message_matches(id) ON DELETE CASCADE,
  message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  account_id bigint REFERENCES telegram_accounts(id) ON DELETE SET NULL,
  source_id bigint REFERENCES telegram_sources(id) ON DELETE SET NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, message_id)
);

CREATE TABLE saved_results (
  id bigserial PRIMARY KEY,
  match_id bigint REFERENCES message_matches(id) ON DELETE SET NULL,
  user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  source_title text, account_name text,
  sender_id bigint, sender_username text,
  message_text text, message_link text, message_at timestamptz,
  rule_name text, intent text, score numeric(5,2), priority text,
  ai_classification jsonb NOT NULL DEFAULT '{}',
  notes text, tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX saved_match_uq ON saved_results (match_id) WHERE deleted_at IS NULL AND match_id IS NOT NULL;

CREATE TABLE blocked_users (
  id bigserial PRIMARY KEY,
  tg_user_id bigint NOT NULL UNIQUE,
  username text, reason text,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE blocked_sources (
  id bigserial PRIMARY KEY,
  tg_chat_id bigint NOT NULL UNIQUE,
  kind text NOT NULL DEFAULT 'group' CHECK (kind IN ('group','supergroup','channel','private','saved')),
  title text, reason text,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE blocked_keywords (
  id bigserial PRIMARY KEY,
  phrase text NOT NULL,
  norm_phrase text NOT NULL UNIQUE,
  reason text,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE automations (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  description text,
  enabled boolean NOT NULL DEFAULT true,
  trigger text NOT NULL,
  conditions jsonb NOT NULL DEFAULT '{}',
  actions jsonb NOT NULL DEFAULT '[]',
  run_count bigint NOT NULL DEFAULT 0, last_run_at timestamptz,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE automation_runs (
  id bigserial PRIMARY KEY,
  automation_id bigint NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL,
  trigger_ref jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','failed','skipped')),
  result jsonb, error text,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE (automation_id, dedupe_key)
);

CREATE TABLE notifications (
  id bigserial PRIMARY KEY,
  kind text NOT NULL DEFAULT 'match',
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','low','medium','high','critical','warning','error')),
  channel text NOT NULL DEFAULT 'dashboard',
  title text NOT NULL, body text,
  match_id bigint REFERENCES message_matches(id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','read')),
  attempts int NOT NULL DEFAULT 0, error text,
  dedupe_key text,
  read_at timestamptz, sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dedupe_key, channel)
);
CREATE INDEX notifications_created_idx ON notifications (created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (channel, status) WHERE status <> 'read';

CREATE TABLE system_logs (
  id bigserial PRIMARY KEY,
  level text NOT NULL, source text NOT NULL, message text NOT NULL,
  context jsonb, request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX system_logs_created_idx ON system_logs (created_at DESC);
CREATE INDEX system_logs_level_idx ON system_logs (level, created_at DESC);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  user_id bigint, username text,
  action text NOT NULL, entity text, entity_id text,
  result text NOT NULL DEFAULT 'success',
  ip text, user_agent text, request_id text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

CREATE TABLE api_usage (
  id bigserial PRIMARY KEY,
  provider text NOT NULL, model text, purpose text,
  status text NOT NULL, http_status int,
  latency_ms int, tokens_in int, tokens_out int, error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_usage_created_idx ON api_usage (created_at DESC);

CREATE TABLE workers (
  name text NOT NULL, instance_id text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','stopped','paused','error')),
  pid int, host text,
  started_at timestamptz NOT NULL DEFAULT now(), last_heartbeat timestamptz NOT NULL DEFAULT now(),
  processed bigint NOT NULL DEFAULT 0, failed bigint NOT NULL DEFAULT 0,
  last_error text, meta jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (name, instance_id)
);

CREATE TABLE jobs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  queue text NOT NULL, name text NOT NULL, title text,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','paused','completed','failed','cancelled')),
  progress int NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}', result jsonb, checkpoint jsonb, error text,
  attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 3,
  run_after timestamptz NOT NULL DEFAULT now(),
  cancel_requested boolean NOT NULL DEFAULT false, pause_requested boolean NOT NULL DEFAULT false,
  dedupe_key text, locked_by text, heartbeat_at timestamptz,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz, finished_at timestamptz, duration_ms int
);
CREATE INDEX jobs_claim_idx ON jobs (queue, run_after) WHERE state = 'queued';
CREATE INDEX jobs_created_idx ON jobs (created_at DESC);
CREATE UNIQUE INDEX jobs_dedupe_uq ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('queued','running','paused');

CREATE TABLE settings (
  key text PRIMARY KEY, value jsonb NOT NULL, is_secret boolean NOT NULL DEFAULT false,
  updated_by bigint REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_providers (
  id text PRIMARY KEY CHECK (id IN ('gemini','openai','anthropic','local','custom')),
  enabled boolean NOT NULL DEFAULT false,
  api_key_enc text, base_url text, model text,
  temperature real NOT NULL DEFAULT 0.1, max_tokens int NOT NULL DEFAULT 700,
  timeout_ms int NOT NULL DEFAULT 20000, retry_count int NOT NULL DEFAULT 2,
  headers_enc text,
  status text NOT NULL DEFAULT 'unconfigured',
  last_test_at timestamptz, last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai_providers (id, model, base_url) VALUES
  ('gemini','gemini-3.8-flash',NULL),('openai','gpt-4o-mini','https://api.openai.com/v1'),
  ('anthropic','claude-haiku-4-5-20251001','https://api.anthropic.com'),
  ('local','llama3.1','http://127.0.0.1:11434/v1'),('custom',NULL,NULL);

CREATE TABLE stats_hourly (
  bucket timestamptz NOT NULL,
  account_id bigint NOT NULL DEFAULT 0, source_id bigint NOT NULL DEFAULT 0,
  messages int NOT NULL DEFAULT 0, matches int NOT NULL DEFAULT 0, high int NOT NULL DEFAULT 0,
  duplicates int NOT NULL DEFAULT 0, ai_calls int NOT NULL DEFAULT 0, errors int NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, account_id, source_id)
);

CREATE TABLE keyword_suggestions (
  id bigserial PRIMARY KEY,
  ai_rule_id bigint NOT NULL REFERENCES ai_rules(id) ON DELETE CASCADE,
  phrase text NOT NULL, norm_phrase text NOT NULL,
  hits int NOT NULL DEFAULT 1, example text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','added','ignored')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ai_rule_id, norm_phrase)
);

CREATE TABLE feedback_examples (
  id bigserial PRIMARY KEY,
  ai_rule_id bigint NOT NULL REFERENCES ai_rules(id) ON DELETE CASCADE,
  match_id bigint REFERENCES message_matches(id) ON DELETE SET NULL,
  text text NOT NULL,
  label text NOT NULL CHECK (label IN ('positive','negative')),
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_rule_idx ON feedback_examples (ai_rule_id, created_at DESC);

CREATE TABLE reports (
  id bigserial PRIMARY KEY, name text NOT NULL, params jsonb NOT NULL DEFAULT '{}',
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE backups (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('database','config','rules')),
  file_name text NOT NULL, size_bytes bigint, sha256 text,
  encrypted boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'ok', error text,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['users','telegram_accounts','telegram_sources','ai_rules','keywords','rules','automations','message_matches','saved_results','ai_providers','keyword_suggestions']
  LOOP EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', 'touch_' || t, t); END LOOP;
END $$;
