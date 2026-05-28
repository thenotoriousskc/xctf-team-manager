-- Core team-management tables. Run this first.
--
-- Idempotent: safe to re-run. All public-read; the app uses the
-- service-role key for writes (server-side in /api routes).

-- ─── settings (singleton) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.settings (
  id                       integer PRIMARY KEY DEFAULT 1,
  pre_run_routine          text NOT NULL DEFAULT '',
  post_run_routine         text NOT NULL DEFAULT '',
  video_label              text NOT NULL DEFAULT '',
  video_url                text NOT NULL DEFAULT '',
  publish_status           text NOT NULL DEFAULT 'PUBLISH',
  updated_at               timestamptz NOT NULL DEFAULT now(),
  strava_access_token      text,
  strava_refresh_token     text,
  strava_token_expires_at  bigint,
  strava_athlete_id        text,
  timezone                 text NOT NULL DEFAULT 'America/Los_Angeles',
  CONSTRAINT settings_id_check CHECK (id = 1),
  CONSTRAINT settings_publish_status_check CHECK (publish_status IN ('PUBLISH', 'UPDATING'))
);

-- Insert the singleton row if it doesn't exist
INSERT INTO public.settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ─── roster ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.roster (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  "group"              text NOT NULL DEFAULT '',
  target               text NOT NULL DEFAULT '',
  note                 text NOT NULL DEFAULT '',
  checkout             text NOT NULL DEFAULT '',
  athletic_net_id      text,
  sort_order           integer NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  last_login_at        timestamptz,
  last_strava_pull_at  timestamptz,
  inactive             boolean DEFAULT false,
  bio_edit             boolean DEFAULT false,
  offseason            boolean NOT NULL DEFAULT false,
  manual_mileage       boolean NOT NULL DEFAULT false,
  email                text,
  vdot                 numeric,
  plan_template_id     uuid
);

-- ─── workout_rows (today's per-group workouts) ────────────────────────────
CREATE TABLE IF NOT EXISTS public.workout_rows (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athletes_raw  text NOT NULL DEFAULT '',
  coach         text NOT NULL DEFAULT '',
  focus         text NOT NULL DEFAULT '',
  workout       text NOT NULL DEFAULT '',
  pace_effort   text NOT NULL DEFAULT '',
  notes         text NOT NULL DEFAULT '',
  sort_order    integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  warmup        text DEFAULT '',
  cooldown      text DEFAULT '',
  segments      jsonb DEFAULT '[]'::jsonb
);

-- ─── workout_history (per-athlete daily snapshots) ────────────────────────
CREATE TABLE IF NOT EXISTS public.workout_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date          date NOT NULL,
  athlete_name  text NOT NULL,
  focus         text DEFAULT '',
  warmup        text DEFAULT '',
  workout       text DEFAULT '',
  cooldown      text DEFAULT '',
  pace_effort   text DEFAULT '',
  notes         text DEFAULT '',
  segments      jsonb DEFAULT '[]'::jsonb,
  coach         text DEFAULT '',
  created_at    timestamptz DEFAULT now(),
  CONSTRAINT workout_history_date_athlete_name_key UNIQUE (date, athlete_name)
);
