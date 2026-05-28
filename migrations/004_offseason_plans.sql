-- Offseason weekly training plan templates.
-- Each template is a 7-day grid; each day has miles + optional structured
-- workout segments. Athletes get one assigned via roster.plan_template_id
-- (see migration 001 which already includes that column).

CREATE TABLE IF NOT EXISTS public.offseason_plan_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label           text NOT NULL,
  description     text,
  sort_order      integer NOT NULL DEFAULT 0,
  weekly_miles    numeric,
  tempo_minutes   numeric,
  days            jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
