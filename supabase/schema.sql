-- ─────────────────────────────────────────────────────────────────────────────
-- Breakers XC/TF — full schema bundle
--
-- Idempotent: safe to run repeatedly. Two uses:
--   1. Spin up a NEW Supabase instance — run once to create every table.
--   2. Catch up an EXISTING instance after pulling app changes — re-run; new
--      tables/columns/policies are added, existing ones left untouched.
-- Run the whole file in the Supabase SQL editor. Maintain it going forward:
-- when a migration is applied by hand, add the idempotent form here too.
--
-- Access model:
--   • Coach-editable day-to-day tables (settings, roster, workout_rows,
--     workout_history, athlete_bios, strava_activities, athlete_strava_tokens,
--     athlete_bio_audit) are written by the browser with the anon key, so they
--     are left WITHOUT RLS (open via the anon key — matches the live app).
--   • Read-mostly / scraped tables (offseason_plan_templates, xc_results,
--     courses, course_assignments, xc_excluded_athletes) have RLS + a public
--     SELECT policy; writes go through coach-gated serverless functions using
--     the service-role key (which bypasses RLS).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── settings (singleton, id = 1) ─────────────────────────────────────────────
create table if not exists settings (
  id                       integer primary key,
  pre_run_routine          text not null default '',
  post_run_routine         text not null default '',
  video_label              text not null default '',
  video_url                text not null default '',
  publish_status           text not null default 'PUBLISH',
  timezone                 text not null default 'America/Los_Angeles',
  coaches                  text[] not null default '{}'::text[],
  strava_access_token      text,
  strava_refresh_token     text,
  strava_token_expires_at  bigint,
  strava_athlete_id        text,
  updated_at               timestamptz not null default now()
);
alter table settings add column if not exists coaches text[] not null default '{}'::text[];
insert into settings (id) values (1) on conflict (id) do nothing;

-- ── roster ───────────────────────────────────────────────────────────────────
create table if not exists roster (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null default '',
  "group"              text not null default '',
  target               text not null default '',
  note                 text not null default '',
  checkout             text not null default '',
  athletic_net_id      text,
  sort_order           integer not null default 0,
  last_login_at        timestamptz,
  last_strava_pull_at  timestamptz,
  inactive             boolean default false,
  bio_edit             boolean default false,
  offseason            boolean not null default false,
  manual_mileage       boolean not null default false,
  email                text,
  vdot                 numeric,
  plan_template_id     uuid,
  updated_at           timestamptz not null default now()
);

-- ── workout_rows (today's groups) ────────────────────────────────────────────
create table if not exists workout_rows (
  id            uuid primary key default gen_random_uuid(),
  athletes_raw  text not null default '',
  coach         text not null default '',
  focus         text not null default '',
  warmup        text,
  workout       text not null default '',
  cooldown      text,
  pace_effort   text not null default '',
  notes         text not null default '',
  segments      jsonb default '[]'::jsonb,
  sort_order    integer not null default 0,
  updated_at    timestamptz not null default now()
);

-- ── workout_history (dated per-athlete records; upsert on date+athlete) ───────
create table if not exists workout_history (
  id            uuid primary key default gen_random_uuid(),
  date          date not null,
  athlete_name  text not null,
  focus         text,
  warmup        text,
  workout       text,
  cooldown      text,
  pace_effort   text,
  notes         text,
  segments      jsonb,
  coach         text,
  created_at    timestamptz default now(),
  constraint workout_history_date_athlete_uniq unique (date, athlete_name)
);

-- ── strava_activities (all run data; strava_id is text to allow manual ids) ──
create table if not exists strava_activities (
  strava_id          text primary key,
  athlete_strava_id  text,
  athlete_firstname  text,
  athlete_lastname   text,
  name               text,
  sport_type         text,
  start_date         timestamptz,
  start_date_local   timestamptz,
  distance_meters    double precision,
  moving_time        integer,
  elapsed_time       integer,
  elevation_gain     real,
  average_speed      real,
  max_speed          real,
  average_heartrate  real,
  max_heartrate      real,
  average_cadence    real,
  suffer_score       real,
  pr_count           integer,
  created_at         timestamptz default now()
);
create index if not exists strava_activities_name_idx on strava_activities (athlete_firstname, athlete_lastname);
create index if not exists strava_activities_date_idx on strava_activities (start_date_local);

-- ── athlete_strava_tokens (per-athlete OAuth) ────────────────────────────────
create table if not exists athlete_strava_tokens (
  athlete_name      text primary key,
  access_token      text,
  refresh_token     text,
  token_expires_at  bigint,
  strava_athlete_id text,
  updated_at        timestamptz default now()
);

-- ── athlete_bios + audit ─────────────────────────────────────────────────────
create table if not exists athlete_bios (
  athlete_name text primary key,
  nickname     text,
  likes        text,
  dislikes     text,
  fun_facts    text,
  photo_url    text,
  cheer        text,
  updated_at   timestamptz default now()
);
create table if not exists athlete_bio_audit (
  id           uuid primary key default gen_random_uuid(),
  athlete_name text not null,
  changed_by   text not null,
  field_name   text not null,
  old_value    text,
  new_value    text,
  changed_at   timestamptz default now()
);

-- ── offseason_plan_templates (anon read; service-role write) ─────────────────
create table if not exists offseason_plan_templates (
  id            uuid primary key default gen_random_uuid(),
  label         text not null default '',
  description   text,
  sort_order    integer not null default 0,
  weekly_miles  numeric,
  tempo_minutes numeric,
  days          jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table offseason_plan_templates enable row level security;
drop policy if exists "anon read plan templates" on offseason_plan_templates;
create policy "anon read plan templates" on offseason_plan_templates for select to public using (true);

-- ── xc_results (scraped history → leaderboards; anon read) ───────────────────
create table if not exists xc_results (
  result_key   text primary key,
  athlete_id   text not null,
  athlete_name text,
  gender       text,
  event        text,
  mark         text,
  mark_seconds numeric,
  season       text,
  grade        integer,
  place        integer,
  date         text,
  race_date    date,
  meet         text,
  heat         text,
  school       text,
  is_pb        boolean default false,
  updated_at   timestamptz default now()
);
-- Columns added incrementally — catch up older xc_results tables:
alter table xc_results add column if not exists gender text;
alter table xc_results add column if not exists grade integer;
alter table xc_results add column if not exists place integer;
alter table xc_results add column if not exists date text;
alter table xc_results add column if not exists race_date date;
alter table xc_results add column if not exists heat text;
alter table xc_results add column if not exists school text;
create index if not exists xc_results_event_secs_idx on xc_results (event, mark_seconds);
create index if not exists xc_results_season_idx     on xc_results (season);
create index if not exists xc_results_athlete_idx    on xc_results (athlete_id);
alter table xc_results enable row level security;
drop policy if exists "anon read xc_results" on xc_results;
create policy "anon read xc_results" on xc_results for select to public using (true);

-- ── courses + race→course assignments (anon read; service-role write) ────────
create table if not exists courses (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  location        text,
  distance_label  text,
  distance_meters numeric,
  notes           text,
  created_at      timestamptz default now()
);
alter table courses enable row level security;
drop policy if exists "anon read courses" on courses;
create policy "anon read courses" on courses for select to public using (true);

create table if not exists course_assignments (
  race_key   text primary key,
  meet       text not null,
  season     text not null,
  event      text not null,
  course_id  uuid references courses(id) on delete set null,
  updated_at timestamptz default now()
);
create index if not exists course_assignments_course_idx on course_assignments (course_id);
alter table course_assignments enable row level security;
drop policy if exists "anon read course_assignments" on course_assignments;
create policy "anon read course_assignments" on course_assignments for select to public using (true);

-- ── excluded athletes (bad athletic.net data; anon read) ─────────────────────
create table if not exists xc_excluded_athletes (
  athlete_id text primary key,
  name       text,
  reason     text,
  created_at timestamptz default now()
);
alter table xc_excluded_athletes enable row level security;
drop policy if exists "anon read xc_excluded" on xc_excluded_athletes;
create policy "anon read xc_excluded" on xc_excluded_athletes for select to public using (true);
