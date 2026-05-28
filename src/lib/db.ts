import { supabase } from './supabase.ts'
import type { WorkoutRow, RosterEntry, SheetData, PublishStatus, WorkoutSegment, WorkoutHistoryEntry, DayHistoryGroup, PlanTemplate, PlanDay } from './types.ts'

// ─── Read ────────────────────────────────────────────────────────────────────

export async function fetchSheetData(): Promise<SheetData> {
  const [settingsRes, workoutRowsRes, rosterRes, planTemplatesRes] = await Promise.all([
    supabase.from('settings').select('*').single(),
    supabase.from('workout_rows').select('*').order('sort_order'),
    supabase.from('roster').select('*').order('sort_order'),
    supabase.from('offseason_plan_templates').select('*').order('sort_order'),
  ])

  if (settingsRes.error) throw new Error(settingsRes.error.message)
  if (workoutRowsRes.error) throw new Error(workoutRowsRes.error.message)
  if (rosterRes.error) throw new Error(rosterRes.error.message)
  // planTemplatesRes can error if the table doesn't exist yet — treat as empty
  const planRows = planTemplatesRes.error ? [] : (planTemplatesRes.data ?? [])

  const s = settingsRes.data
  return {
    preRunRoutine: s.pre_run_routine ?? '',
    postRunRoutine: s.post_run_routine ?? '',
    videoLabel: s.video_label ?? '',
    videoUrl: s.video_url ?? '',
    publishStatus: (s.publish_status ?? 'PUBLISH') as PublishStatus,
    stravaConnected: !!s.strava_access_token,
    timezone: s.timezone ?? 'America/Los_Angeles',
    workoutRows: (workoutRowsRes.data ?? []).map(r => ({
      athletesRaw: r.athletes_raw,
      coach: r.coach,
      focus: r.focus,
      warmup: r.warmup ?? '',
      workout: r.workout,
      cooldown: r.cooldown ?? '',
      paceEffort: r.pace_effort,
      notes: r.notes,
      segments: (r.segments ?? []) as WorkoutSegment[],
      id: r.id,
    })),
    roster: (rosterRes.data ?? []).map(r => ({
      id: r.id,
      name: r.name,
      group: r.group,
      target: r.target,
      note: r.note,
      checkout: r.checkout,
      athleticNetId: r.athletic_net_id ?? undefined,
      lastLoginAt: r.last_login_at ?? null,
      lastStravaAt: r.last_strava_pull_at ?? null,
      inactive: r.inactive ?? false,
      bioEdit: r.bio_edit ?? false,
      offseason: r.offseason ?? false,
      manualMileage: r.manual_mileage ?? false,
      email: r.email ?? null,
      vdot: r.vdot != null ? Number(r.vdot) : null,
      planTemplateId: r.plan_template_id ?? null,
    })),
    planTemplates: planRows.map((r: any) => ({
      id: r.id,
      label: r.label ?? '',
      description: r.description ?? '',
      sortOrder: r.sort_order ?? 0,
      weeklyMiles: r.weekly_miles != null ? Number(r.weekly_miles) : null,
      tempoMinutes: r.tempo_minutes != null ? Number(r.tempo_minutes) : null,
      days: normalizeDays(r.days),
    })),
  }
}

// Ensure a template always has 7 days, with safe defaults.
function normalizeDays(raw: unknown): PlanDay[] {
  const arr = Array.isArray(raw) ? (raw as any[]) : []
  const out: PlanDay[] = []
  for (let i = 0; i < 7; i++) {
    const d = arr[i] ?? {}
    out.push({
      miles: d.miles == null ? null : Number(d.miles),
      isRest: !!d.isRest,
      notes: String(d.notes ?? ''),
      segments: Array.isArray(d.segments) ? d.segments as WorkoutSegment[] : [],
      extra: String(d.extra ?? ''),
    })
  }
  return out
}

// ─── Write ───────────────────────────────────────────────────────────────────

export async function saveSettings(settings: {
  preRunRoutine: string
  postRunRoutine: string
  videoLabel: string
  videoUrl: string
  publishStatus: PublishStatus
  timezone: string
}) {
  const { error } = await supabase.from('settings').update({
    pre_run_routine: settings.preRunRoutine,
    post_run_routine: settings.postRunRoutine,
    video_label: settings.videoLabel,
    video_url: settings.videoUrl,
    publish_status: settings.publishStatus,
    timezone: settings.timezone,
    updated_at: new Date().toISOString(),
  }).eq('id', 1)
  if (error) throw new Error(error.message)
}

export async function saveWorkoutRows(rows: (WorkoutRow & { id?: string })[]) {
  // Delete all existing rows then re-insert with new sort order
  const { error: delErr } = await supabase.from('workout_rows').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  if (delErr) throw new Error(delErr.message)

  if (rows.length === 0) return

  const { error: insErr } = await supabase.from('workout_rows').insert(
    rows.map((r, i) => ({
      athletes_raw: r.athletesRaw,
      coach: r.coach,
      focus: r.focus,
      warmup: r.warmup,
      workout: r.workout,
      cooldown: r.cooldown,
      pace_effort: r.paceEffort,
      notes: r.notes,
      segments: r.segments ?? [],
      sort_order: i,
    }))
  )
  if (insErr) throw new Error(insErr.message)
}

export async function saveRoster(entries: (RosterEntry & { id?: string })[]) {
  // Preserve fields written server-side (login/strava timestamps) and the
  // email column (auto-bound when an athlete signs in — without this, a stale
  // dashboard saving without email would clobber the bound value back to null).
  const { data: existing } = await supabase
    .from('roster')
    .select('name, last_login_at, last_strava_pull_at, email, vdot')
  const tsMap: Record<string, { login: string | null; strava: string | null; email: string | null; vdot: number | null }> = {}
  for (const r of existing ?? []) {
    tsMap[r.name] = {
      login: r.last_login_at ?? null,
      strava: r.last_strava_pull_at ?? null,
      email: r.email ?? null,
      vdot: r.vdot != null ? Number(r.vdot) : null,
    }
  }

  const { error: delErr } = await supabase.from('roster').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  if (delErr) throw new Error(delErr.message)

  if (entries.length === 0) return

  const { error: insErr } = await supabase.from('roster').insert(
    entries.map((r, i) => ({
      name: r.name,
      group: r.group,
      target: r.target,
      note: r.note,
      checkout: r.checkout,
      athletic_net_id: r.athleticNetId ?? null,
      sort_order: i,
      last_login_at: tsMap[r.name]?.login ?? null,
      last_strava_pull_at: tsMap[r.name]?.strava ?? null,
      inactive: r.inactive ?? false,
      bio_edit: r.bioEdit ?? false,
      offseason: r.offseason ?? false,
      manual_mileage: r.manualMileage ?? false,
      // Coach's explicit edit (r.email !== undefined in the form) wins.
      // Otherwise preserve whatever the DB has (so auto-bind isn't clobbered).
      email: r.email !== undefined ? r.email : (tsMap[r.name]?.email ?? null),
      vdot: r.vdot !== undefined ? r.vdot : (tsMap[r.name]?.vdot ?? null),
      plan_template_id: r.planTemplateId ?? null,
    }))
  )
  if (insErr) throw new Error(insErr.message)
}

export async function saveWorkoutHistory(workoutRows: WorkoutRow[], roster: RosterEntry[]) {
  const today = new Date().toISOString().split('T')[0]

  const records = roster
    .map(entry => {
      const row = workoutRows.find(r =>
        r.athletesRaw.split('\n').map(n => n.trim()).includes(entry.name.trim())
      )
      if (!row) return null
      return {
        date: today,
        athlete_name: entry.name,
        focus: row.focus,
        warmup: row.warmup,
        workout: row.workout,
        cooldown: row.cooldown,
        pace_effort: row.paceEffort,
        notes: row.notes,
        segments: row.segments ?? [],
        coach: row.coach,
      }
    })
    .filter(Boolean)

  if (records.length === 0) return

  const { error } = await supabase.from('workout_history').upsert(records, {
    onConflict: 'date,athlete_name',
  })
  if (error) throw new Error(error.message)
}

export async function fetchHistoryDates(): Promise<string[]> {
  const { data, error } = await supabase
    .from('workout_history')
    .select('date')
    .order('date', { ascending: false })
  if (error) throw new Error(error.message)
  return [...new Set((data ?? []).map((r: any) => r.date as string))]
}

export async function fetchDayHistory(date: string): Promise<DayHistoryGroup[]> {
  const { data, error } = await supabase
    .from('workout_history')
    .select('athlete_name, focus, coach, warmup, workout, cooldown, pace_effort, notes, segments')
    .eq('date', date)
  if (error) throw new Error(error.message)

  const groupMap: Record<string, DayHistoryGroup> = {}
  for (const r of data ?? []) {
    if (!groupMap[r.focus]) {
      groupMap[r.focus] = {
        focus: r.focus ?? '',
        coach: r.coach ?? '',
        warmup: r.warmup ?? '',
        workout: r.workout ?? '',
        cooldown: r.cooldown ?? '',
        paceEffort: r.pace_effort ?? '',
        notes: r.notes ?? '',
        segments: (r.segments ?? []) as WorkoutSegment[],
        athletes: [],
      }
    }
    groupMap[r.focus].athletes.push(r.athlete_name)
  }
  return Object.values(groupMap).sort((a, b) => a.focus.localeCompare(b.focus))
}

export async function saveDayHistory(date: string, groups: DayHistoryGroup[]) {
  const { error: delErr } = await supabase.from('workout_history').delete().eq('date', date)
  if (delErr) throw new Error(delErr.message)

  const records = groups.flatMap(g =>
    g.athletes.map(athleteName => ({
      date,
      athlete_name: athleteName,
      focus: g.focus,
      coach: g.coach,
      warmup: g.warmup,
      workout: g.workout,
      cooldown: g.cooldown,
      pace_effort: g.paceEffort,
      notes: g.notes,
      segments: g.segments,
    }))
  )

  if (records.length === 0) return

  const { error: insErr } = await supabase.from('workout_history').insert(records)
  if (insErr) throw new Error(insErr.message)
}

export async function fetchAthleteHistory(athleteName: string): Promise<WorkoutHistoryEntry[]> {
  const { data, error } = await supabase
    .from('workout_history')
    .select('date, focus, warmup, workout, cooldown, pace_effort, notes, segments, coach')
    .eq('athlete_name', athleteName)
    .order('date', { ascending: false })
    .limit(30)

  if (error) throw new Error(error.message)
  return (data ?? []).map(r => ({
    date: r.date,
    focus: r.focus ?? '',
    warmup: r.warmup ?? '',
    workout: r.workout ?? '',
    cooldown: r.cooldown ?? '',
    paceEffort: r.pace_effort ?? '',
    notes: r.notes ?? '',
    segments: (r.segments ?? []) as WorkoutSegment[],
    coach: r.coach ?? '',
  }))
}


// Save the offseason plan templates (full replace, mirrors saveRoster pattern).
// IDs are preserved when present so roster.plan_template_id references stay valid.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export async function savePlanTemplates(templates: PlanTemplate[]) {
  // Delete missing IDs explicitly (so we can preserve IDs of survivors). Only
  // consider real UUIDs — non-UUID client IDs aren't in the DB yet, so they
  // can't be "missing".
  const { data: existing, error: existErr } = await supabase
    .from('offseason_plan_templates')
    .select('id')
  if (existErr) throw new Error(existErr.message)
  const keepIds = new Set(templates.map(t => t.id).filter(id => id && UUID_RE.test(id)))
  const toDelete = (existing ?? []).map(r => r.id).filter(id => !keepIds.has(id))
  if (toDelete.length > 0) {
    const { error: delErr } = await supabase.from('offseason_plan_templates').delete().in('id', toDelete)
    if (delErr) throw new Error(delErr.message)
  }

  if (templates.length === 0) return

  // Upsert each. Strip non-UUID client IDs so Postgres can assign one — a
  // legacy uid() (base-36 Math.random) would otherwise raise "invalid input
  // syntax for type uuid".
  const rows = templates.map((t, i) => ({
    ...(t.id && UUID_RE.test(t.id) ? { id: t.id } : {}),
    label: t.label,
    description: t.description,
    sort_order: i,
    weekly_miles: t.weeklyMiles,
    tempo_minutes: t.tempoMinutes,
    days: t.days,
  }))
  const { error: upErr } = await supabase.from('offseason_plan_templates').upsert(rows)
  if (upErr) throw new Error(upErr.message)
}
