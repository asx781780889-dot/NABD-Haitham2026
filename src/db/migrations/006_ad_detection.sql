-- NABD advertiser detection: durable sender behavior, lexicon and operator learning.
CREATE TABLE IF NOT EXISTS sender_profiles (
  tg_user_id bigint PRIMARY KEY,
  username text, display_name text,
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','suspect','advertiser','trusted')),
  status_source text NOT NULL DEFAULT 'auto' CHECK (status_source IN ('auto','operator')),
  ad_score numeric(5,2) NOT NULL DEFAULT 0,
  ad_messages int NOT NULL DEFAULT 0, total_messages int NOT NULL DEFAULT 0,
  groups_count int NOT NULL DEFAULT 0, repeat_count int NOT NULL DEFAULT 0,
  ad_events timestamptz[] NOT NULL DEFAULT '{}',
  signals jsonb NOT NULL DEFAULT '{}',
  bio text, bio_score numeric(5,2), bio_checked_at timestamptz, bio_error text,
  profile_flags jsonb NOT NULL DEFAULT '{}',
  first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_ad_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sender_profiles_status_idx ON sender_profiles (status, ad_score DESC);
CREATE INDEX IF NOT EXISTS sender_profiles_last_ad_idx ON sender_profiles (last_ad_at DESC);
CREATE TABLE IF NOT EXISTS ad_lexicon (
  id bigserial PRIMARY KEY, phrase text NOT NULL, norm_phrase text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('offer','cta','price','seeker')),
  weight int NOT NULL CHECK (weight BETWEEN -50 AND 50), enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ad_examples (
  id bigserial PRIMARY KEY, text text NOT NULL,
  label text NOT NULL CHECK (label IN ('ad','not_ad')),
  match_id bigint REFERENCES message_matches(id) ON DELETE SET NULL, tg_user_id bigint,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ad_examples_label_idx ON ad_examples (label, created_at DESC);
ALTER TABLE message_matches ADD COLUMN IF NOT EXISTS ad_score numeric(5,2);
ALTER TABLE message_matches ADD COLUMN IF NOT EXISTS ad_label text CHECK (ad_label IN ('clean','suspect','ad'));
ALTER TABLE message_matches ADD COLUMN IF NOT EXISTS ad_signals jsonb NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS matches_ad_label_idx ON message_matches (ad_label) WHERE deleted_at IS NULL;
INSERT INTO ad_lexicon (phrase, norm_phrase, kind, weight) VALUES
 ('نقدم','نقدم','offer',20),('نوفر','نوفر','offer',20),('خدماتنا','خدماتنا','offer',20),('لدينا','لدينا','offer',15),('ضمان','ضمان','offer',15),
 ('للتواصل','للتواصل','cta',20),('راسلنا','راسلنا','cta',20),('واتساب','واتساب','cta',20),('تواصل معنا','تواصل معنا','cta',20),('اطلب الآن','اطلب الان','cta',20),('اطلب الان','اطلب الان','cta',20),('للطلب','للطلب','cta',15),
 ('أسعار مناسبة','اسعار مناسبه','price',15),('السعر','السعر','price',15),('خصم','خصم','price',15),('عرض','عرض','price',15),('ريال','ريال','price',15),('ر.س','ر س','price',15),('sar','sar','price',15),
 ('احتاج','احتاج','seeker',-25),('محتاج','محتاج','seeker',-25),('ابي','ابي','seeker',-25),('ابغى','ابغي','seeker',-25),('مين يساعدني','مين يساعدني','seeker',-25),('مين يعرف','مين يعرف','seeker',-20),('اريد','اريد','seeker',-20),('help','help','seeker',-20)
ON CONFLICT (norm_phrase) DO NOTHING;
