-- Strava integration: per-athlete OAuth tokens and synced activities.
-- Optional — the app works without these if no athletes use Strava.

-- ─── athlete_strava_tokens (per-athlete OAuth tokens) ─────────────────────
CREATE TABLE IF NOT EXISTS public.athlete_strava_tokens (
  athlete_name        text PRIMARY KEY,
  access_token        text,
  refresh_token       text,
  token_expires_at    bigint,
  strava_athlete_id   text,
  updated_at          timestamptz DEFAULT now()
);

-- ─── strava_activities (synced runs + manual entries) ─────────────────────
-- strava_id is text (not bigint) to support synthetic IDs for manual entries
-- (format: manual_<name>_<date>).
CREATE TABLE IF NOT EXISTS public.strava_activities (
  strava_id           text PRIMARY KEY,
  athlete_strava_id   text,
  athlete_firstname   text,
  athlete_lastname    text,
  name                text,
  sport_type          text,
  start_date          timestamptz,
  start_date_local    timestamptz,
  distance_meters     double precision,
  moving_time         integer,
  elapsed_time        integer,
  elevation_gain      real,
  average_speed       real,
  max_speed           real,
  average_heartrate   real,
  max_heartrate       real,
  average_cadence     real,
  suffer_score        real,
  pr_count            integer,
  created_at          timestamptz DEFAULT now()
);
