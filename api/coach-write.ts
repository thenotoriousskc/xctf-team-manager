import type { VercelRequest, VercelResponse } from '@vercel/node'

// Single coach-gated write endpoint for resources whose tables are anon-read /
// service-role-write under RLS. Consolidated from api/plan-templates.ts and
// api/courses.ts to stay under the Hobby plan's 12-function limit. The caller
// must present a valid Supabase session whose email is an authorized coach
// (mirrors src/lib/coaches.ts). Dispatch on body.resource.

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function sbFetch(path: string, opts: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
  })
}

async function authorizedCoachEmail(token: string | undefined): Promise<string | null> {
  if (!token) return null
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  })
  if (!userRes.ok) return null
  const user = await userRes.json() as { email?: string }
  const email = (user.email ?? '').trim().toLowerCase()
  if (!email) return null

  const env = (process.env.VITE_AUTHORIZED_COACHES ?? '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  let db: string[] = []
  const sRes = await sbFetch('settings?select=coaches&id=eq.1')
  if (sRes.ok) {
    const rows = await sRes.json() as Array<{ coaches?: string[] }>
    db = Array.isArray(rows[0]?.coaches) ? rows[0]!.coaches!.map(e => e.trim().toLowerCase()) : []
  }
  const list = [...new Set([...env, ...db])]
  if (list.length === 0) return email
  return list.includes(email) ? email : null
}

// ── plan templates ──────────────────────────────────────────────────────────
type PlanTemplate = { id?: string; label: string; description: string; weeklyMiles: number | null; tempoMinutes: number | null; days: unknown }

async function writePlanTemplates(templates: PlanTemplate[], res: VercelResponse) {
  const existRes = await sbFetch('offseason_plan_templates?select=id')
  if (!existRes.ok) return res.status(500).json({ error: await existRes.text() })
  const existing = await existRes.json() as Array<{ id: string }>
  const keepIds = new Set(templates.map(t => t.id).filter(id => id && UUID_RE.test(id)))
  const toDelete = existing.map(r => r.id).filter(id => !keepIds.has(id))
  if (toDelete.length > 0) {
    const params = new URLSearchParams({ id: `in.(${toDelete.join(',')})` })
    const delRes = await sbFetch(`offseason_plan_templates?${params}`, { method: 'DELETE' })
    if (!delRes.ok) return res.status(500).json({ error: await delRes.text() })
  }
  if (templates.length === 0) return res.json({ ok: true })

  const rows = templates.map((t, i) => ({
    ...(t.id && UUID_RE.test(t.id) ? { id: t.id } : {}),
    label: t.label,
    description: t.description,
    sort_order: i,
    weekly_miles: t.weeklyMiles,
    tempo_minutes: t.tempoMinutes,
    days: t.days,
  }))
  const upRes = await sbFetch('offseason_plan_templates', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(rows),
  })
  if (!upRes.ok) return res.status(500).json({ error: await upRes.text() })
  return res.json({ ok: true })
}

// ── courses + assignments ─────────────────────────────────────────────────────
type Course = { id?: string; name: string; location?: string; distanceLabel?: string; notes?: string }
type Assignment = { raceKey: string; meet: string; season: string; event: string; courseId: string | null }

async function writeCourses(courses: Course[], assignments: Assignment[], res: VercelResponse) {
  const courseRows = courses
    .filter(c => c.id && UUID_RE.test(c.id))
    .map(c => ({ id: c.id, name: c.name, location: c.location ?? null, distance_label: c.distanceLabel ?? null, notes: c.notes ?? null }))
  if (courseRows.length > 0) {
    const r = await sbFetch('courses', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(courseRows) })
    if (!r.ok) return res.status(500).json({ error: await r.text() })
  }

  const keepCourseIds = new Set(courseRows.map(c => c.id))
  const existCourses = await sbFetch('courses?select=id')
  if (existCourses.ok) {
    const ids = (await existCourses.json() as Array<{ id: string }>).map(r => r.id)
    const toDelete = ids.filter(id => !keepCourseIds.has(id))
    if (toDelete.length > 0) {
      const params = new URLSearchParams({ id: `in.(${toDelete.join(',')})` })
      const d = await sbFetch(`courses?${params}`, { method: 'DELETE' })
      if (!d.ok) return res.status(500).json({ error: await d.text() })
    }
  }

  const assignRows = assignments
    .filter(a => a.raceKey && a.courseId)
    .map(a => ({ race_key: a.raceKey, meet: a.meet, season: a.season, event: a.event, course_id: a.courseId }))
  if (assignRows.length > 0) {
    const r = await sbFetch('course_assignments', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(assignRows) })
    if (!r.ok) return res.status(500).json({ error: await r.text() })
  }

  const keepKeys = new Set(assignRows.map(a => a.race_key))
  const existAssign = await sbFetch('course_assignments?select=race_key')
  if (existAssign.ok) {
    const keys = (await existAssign.json() as Array<{ race_key: string }>).map(r => r.race_key)
    const toDelete = keys.filter(k => !keepKeys.has(k))
    if (toDelete.length > 0) {
      const params = new URLSearchParams({ race_key: `in.(${toDelete.map(k => `"${k}"`).join(',')})` })
      const d = await sbFetch(`course_assignments?${params}`, { method: 'DELETE' })
      if (!d.ok) return res.status(500).json({ error: await d.text() })
    }
  }
  return res.json({ ok: true })
}

// ── excluded athletes (bad athletic.net data) ─────────────────────────────────
type Excluded = { athleteId: string; name?: string; reason?: string }

async function writeExcluded(list: Excluded[], res: VercelResponse) {
  const del = await sbFetch('xc_excluded_athletes?athlete_id=not.is.null', { method: 'DELETE' })
  if (!del.ok) return res.status(500).json({ error: await del.text() })
  const rows = list.filter(e => e.athleteId).map(e => ({ athlete_id: e.athleteId, name: e.name ?? null, reason: e.reason ?? null }))
  if (rows.length === 0) return res.json({ ok: true })
  const ins = await sbFetch('xc_excluded_athletes', { method: 'POST', body: JSON.stringify(rows) })
  if (!ins.ok) return res.status(500).json({ error: await ins.text() })
  return res.json({ ok: true })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!(await authorizedCoachEmail(token))) return res.status(403).json({ error: 'Not authorized' })

  const body = req.body as { resource?: string; templates?: PlanTemplate[]; courses?: Course[]; assignments?: Assignment[]; excluded?: Excluded[] }
  switch (body.resource) {
    case 'plan-templates':
      if (!Array.isArray(body.templates)) return res.status(400).json({ error: 'Missing templates' })
      return writePlanTemplates(body.templates, res)
    case 'courses':
      if (!Array.isArray(body.courses) || !Array.isArray(body.assignments)) return res.status(400).json({ error: 'Missing courses/assignments' })
      return writeCourses(body.courses, body.assignments, res)
    case 'excluded':
      if (!Array.isArray(body.excluded)) return res.status(400).json({ error: 'Missing excluded' })
      return writeExcluded(body.excluded, res)
    default:
      return res.status(400).json({ error: 'Unknown resource' })
  }
}
