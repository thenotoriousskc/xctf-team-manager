import { supabase } from './supabase.ts'
import type { WorkoutRow, RosterEntry, SheetData, PublishStatus, WorkoutSegment, WorkoutHistoryEntry, DayHistoryGroup, PlanTemplate, PlanDay, Course, CourseAssignment, XcResult } from './types.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
    coaches: Array.isArray(s.coaches) ? (s.coaches as string[]) : [],
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
  coaches: string[]
}) {
  const { error } = await supabase.from('settings').update({
    pre_run_routine: settings.preRunRoutine,
    post_run_routine: settings.postRunRoutine,
    video_label: settings.videoLabel,
    video_url: settings.videoUrl,
    publish_status: settings.publishStatus,
    timezone: settings.timezone,
    coaches: settings.coaches,
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

type EditableRosterEntry = RosterEntry & { id?: string }

// The persisted, coach-editable fields that decide whether a row "changed".
// Excludes server-managed columns (login/strava timestamps) which are
// preserved from the DB, not diffed.
function rosterRowKey(e: EditableRosterEntry): string {
  return JSON.stringify({
    name: e.name,
    group: e.group,
    target: e.target,
    note: e.note,
    checkout: e.checkout,
    athleticNetId: e.athleticNetId ?? null,
    inactive: !!e.inactive,
    bioEdit: !!e.bioEdit,
    offseason: !!e.offseason,
    manualMileage: !!e.manualMileage,
    email: e.email ?? null,
    vdot: e.vdot ?? null,
    planTemplateId: e.planTemplateId ?? null,
  })
}

// Row-level save. Diffs the current roster against `original` (the roster as
// loaded/last-saved) and only writes rows that were added, removed, reordered,
// or edited. This replaces the old delete-all-then-insert, which rewrote every
// row from this tab's in-memory state on every save — clobbering plan
// assignments (and other fields) for athletes changed elsewhere that this tab
// didn't know about. Untouched rows are now left alone.
//
// `original` omitted → upsert every current row, delete nothing (safe fallback;
// loses removed-athlete deletion but never wipes data).
export async function saveRoster(entries: EditableRosterEntry[], original?: EditableRosterEntry[]) {
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

  // Delete rows the coach removed (present in the load baseline, gone now).
  const curIds = new Set(entries.map(e => e.id))
  const deletedIds = (original ?? [])
    .map(e => e.id)
    .filter((id): id is string => !!id && UUID_RE.test(id) && !curIds.has(id))
  if (deletedIds.length > 0) {
    const { error: delErr } = await supabase.from('roster').delete().in('id', deletedIds)
    if (delErr) throw new Error(delErr.message)
  }

  // A row is dirty if it's new, its content changed, or its position (→
  // sort_order) changed.
  const origById = new Map((original ?? []).map((e, i) => [e.id, { entry: e, index: i }]))
  const dirty = entries
    .map((r, i) => ({ r, i }))
    .filter(({ r, i }) => {
      const o = origById.get(r.id)
      return !o || o.index !== i || rosterRowKey(o.entry) !== rosterRowKey(r)
    })

  if (dirty.length === 0) return

  const baseCols = ({ r, i }: { r: EditableRosterEntry; i: number }) => ({
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
  })

  // Split by request so each payload has a uniform column set: existing rows
  // upsert by their DB UUID; new rows (client uid()) insert and let Postgres
  // assign a real UUID.
  const existing2 = dirty.filter(({ r }) => r.id && UUID_RE.test(r.id))
  const fresh = dirty.filter(({ r }) => !(r.id && UUID_RE.test(r.id)))

  if (existing2.length > 0) {
    const { error } = await supabase.from('roster').upsert(
      existing2.map(d => ({ id: d.r.id, ...baseCols(d) }))
    )
    if (error) throw new Error(error.message)
  }
  if (fresh.length > 0) {
    const { error } = await supabase.from('roster').insert(fresh.map(baseCols))
    if (error) throw new Error(error.message)
  }
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
//
// RLS denies anon writes to offseason_plan_templates, so writes go through the
// /api/plan-templates serverless function (service role), gated by the coach's
// Supabase session. The dedupe/UUID logic lives server-side in api/plan-templates.ts.
export async function savePlanTemplates(templates: PlanTemplate[]) {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('Not signed in — cannot save plan templates')

  const res = await fetch('/api/coach-write', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ resource: 'plan-templates', templates }),
  })
  if (!res.ok) {
    const msg = await res.text().catch(() => '')
    throw new Error(`Plan template save failed (${res.status}): ${msg}`)
  }
}

// ─── Courses / XC results ──────────────────────────────────────────────────

// Pull every XC result, paginating past PostgREST's 1000-row cap.
export async function fetchXcResults(): Promise<XcResult[]> {
  const out: XcResult[] = []
  const BATCH = 1000
  for (let from = 0; ; from += BATCH) {
    const { data, error } = await supabase
      .from('xc_results')
      .select('athlete_id, athlete_name, gender, event, mark, mark_seconds, season, grade, place, race_date, meet, is_pb')
      .order('mark_seconds', { ascending: true })
      .range(from, from + BATCH - 1)
    if (error) throw new Error(error.message)
    const rows = data ?? []
    out.push(...rows.map(r => ({
      athleteId: r.athlete_id,
      athleteName: r.athlete_name ?? '',
      gender: r.gender ?? null,
      event: r.event ?? '',
      mark: r.mark ?? '',
      markSeconds: r.mark_seconds != null ? Number(r.mark_seconds) : null,
      season: r.season ?? '',
      grade: r.grade != null ? Number(r.grade) : null,
      place: r.place != null ? Number(r.place) : null,
      raceDate: r.race_date ?? null,
      meet: r.meet ?? '',
      isPb: !!r.is_pb,
    })))
    if (rows.length < BATCH) break
  }
  return out
}

export async function fetchCourses(): Promise<Course[]> {
  const { data, error } = await supabase
    .from('courses')
    .select('id, name, location, distance_label, notes')
    .order('name')
  if (error) throw new Error(error.message)
  return (data ?? []).map(r => ({
    id: r.id,
    name: r.name ?? '',
    location: r.location ?? '',
    distanceLabel: r.distance_label ?? '',
    notes: r.notes ?? '',
  }))
}

export async function fetchCourseAssignments(): Promise<CourseAssignment[]> {
  const { data, error } = await supabase
    .from('course_assignments')
    .select('race_key, meet, season, event, course_id')
  if (error) throw new Error(error.message)
  return (data ?? []).map(r => ({
    raceKey: r.race_key,
    meet: r.meet ?? '',
    season: r.season ?? '',
    event: r.event ?? '',
    courseId: r.course_id ?? null,
  }))
}

// Athletes excluded from leaderboards (bad athletic.net data). Their rows stay
// in xc_results but are filtered out of leaderboards.
export async function fetchExcludedAthletes(): Promise<{ athleteId: string; name: string }[]> {
  // Optional table — if it hasn't been created yet, treat as no exclusions
  // rather than breaking the whole Stats view.
  const { data, error } = await supabase.from('xc_excluded_athletes').select('athlete_id, name')
  if (error) return []
  return (data ?? []).map(r => ({ athleteId: r.athlete_id, name: r.name ?? '' }))
}

export async function saveExcludedAthletes(list: { athleteId: string; name: string }[]) {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('Not signed in — cannot save exclusions')
  const res = await fetch('/api/coach-write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ resource: 'excluded', excluded: list }),
  })
  if (!res.ok) {
    const msg = await res.text().catch(() => '')
    throw new Error(`Exclusion save failed (${res.status}): ${msg}`)
  }
}

// Coach-gated write (RLS denies anon writes to courses/course_assignments).
// Full-replace of both sets — courses are coach-only/single-editor, so the
// concurrent-clobber concern that bit the roster doesn't apply here.
export async function saveCourses(courses: Course[], assignments: CourseAssignment[]) {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('Not signed in — cannot save courses')

  const res = await fetch('/api/coach-write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ resource: 'courses', courses, assignments }),
  })
  if (!res.ok) {
    const msg = await res.text().catch(() => '')
    throw new Error(`Course save failed (${res.status}): ${msg}`)
  }
}
