-- Athlete bio pages: photo, nickname, likes/dislikes, fun facts, cheer.
-- Has an audit log of every field-level change.

-- ─── athlete_bios ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.athlete_bios (
  athlete_name  text PRIMARY KEY,
  nickname      text,
  likes         text,
  dislikes      text,
  fun_facts     text,
  photo_url     text,
  cheer         text,
  updated_at    timestamptz DEFAULT now()
);

-- ─── athlete_bio_audit (immutable change log) ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.athlete_bio_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_name  text NOT NULL,
  changed_by    text NOT NULL,
  field_name    text NOT NULL,
  old_value     text,
  new_value     text,
  changed_at    timestamptz DEFAULT now()
);
