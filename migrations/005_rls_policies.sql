-- Row Level Security policies. Public-read everywhere; writes go through
-- API routes that use the service-role key (so RLS is bypassed for those).
-- The "coaches write …" policies are kept for future direct-from-client
-- writes after Google sign-in, but currently no client code uses them.

-- Enable RLS on every table.
ALTER TABLE public.settings                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roster                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workout_rows             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workout_history          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.strava_activities        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.athlete_strava_tokens    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.athlete_bios             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.athlete_bio_audit        ENABLE ROW LEVEL SECURITY;

-- Helper: drop-then-create so this migration is re-runnable.
DROP POLICY IF EXISTS "public read settings" ON public.settings;
CREATE POLICY "public read settings" ON public.settings FOR SELECT USING (true);

DROP POLICY IF EXISTS "coaches write settings" ON public.settings;
CREATE POLICY "coaches write settings" ON public.settings
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "public read roster" ON public.roster;
CREATE POLICY "public read roster" ON public.roster FOR SELECT USING (true);

DROP POLICY IF EXISTS "coaches write roster" ON public.roster;
CREATE POLICY "coaches write roster" ON public.roster
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "public read workout_rows" ON public.workout_rows;
CREATE POLICY "public read workout_rows" ON public.workout_rows FOR SELECT USING (true);

DROP POLICY IF EXISTS "coaches write workout_rows" ON public.workout_rows;
CREATE POLICY "coaches write workout_rows" ON public.workout_rows
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Public read" ON public.workout_history;
CREATE POLICY "Public read" ON public.workout_history FOR SELECT USING (true);
DROP POLICY IF EXISTS "Auth write" ON public.workout_history;
CREATE POLICY "Auth write" ON public.workout_history FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "Auth update" ON public.workout_history;
CREATE POLICY "Auth update" ON public.workout_history FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Public read" ON public.strava_activities;
CREATE POLICY "Public read" ON public.strava_activities FOR SELECT USING (true);
DROP POLICY IF EXISTS "Auth insert" ON public.strava_activities;
CREATE POLICY "Auth insert" ON public.strava_activities FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "Auth upsert" ON public.strava_activities;
CREATE POLICY "Auth upsert" ON public.strava_activities FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Public read" ON public.athlete_strava_tokens;
CREATE POLICY "Public read" ON public.athlete_strava_tokens FOR SELECT USING (true);
DROP POLICY IF EXISTS "Public write" ON public.athlete_strava_tokens;
CREATE POLICY "Public write" ON public.athlete_strava_tokens FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "Public update" ON public.athlete_strava_tokens;
CREATE POLICY "Public update" ON public.athlete_strava_tokens FOR UPDATE USING (true);

DROP POLICY IF EXISTS "public read" ON public.athlete_bios;
CREATE POLICY "public read" ON public.athlete_bios FOR SELECT USING (true);
DROP POLICY IF EXISTS "public write" ON public.athlete_bios;
CREATE POLICY "public write" ON public.athlete_bios USING (true);

DROP POLICY IF EXISTS "public read" ON public.athlete_bio_audit;
CREATE POLICY "public read" ON public.athlete_bio_audit FOR SELECT USING (true);
DROP POLICY IF EXISTS "public insert" ON public.athlete_bio_audit;
CREATE POLICY "public insert" ON public.athlete_bio_audit FOR INSERT WITH CHECK (true);
