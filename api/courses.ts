import type { VercelRequest, VercelResponse } from '@vercel/node'

// Writes to courses / course_assignments run through here with the service-role
// key (RLS denies anon writes; anon keeps SELECT for reads). The caller must
// present a valid Supabase session whose email is an authorized coach — mirrors
// the client-side gate in src/lib/coaches.ts and api/plan-templates.ts.

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Course = { id?: string; name: string; location?: string; distanceLabel?: string; notes?: string }
type Assignment = { raceKey: string; meet: string; season: string; event: string; courseId: string | null }

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!(await authorizedCoachEmail(token))) return res.status(403).json({ error: 'Not authorized' })

  const { courses, assignments } = req.body as { courses?: Course[]; assignments?: Assignment[] }
  if (!Array.isArray(courses) || !Array.isArray(assignments)) {
    return res.status(400).json({ error: 'Missing courses/assignments' })
  }

  // 1. Upsert courses. New ones carry a client-generated UUID so assignments can
  //    reference them in the same request.
  const courseRows = courses
    .filter(c => c.id && UUID_RE.test(c.id))
    .map(c => ({
      id: c.id,
      name: c.name,
      location: c.location ?? null,
      distance_label: c.distanceLabel ?? null,
      notes: c.notes ?? null,
    }))
  if (courseRows.length > 0) {
    const r = await sbFetch('courses', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(courseRows),
    })
    if (!r.ok) return res.status(500).json({ error: await r.text() })
  }

  // 2. Delete courses no longer present (FK on course_assignments is ON DELETE
  //    SET NULL, so any stale references just go unassigned).
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

  // 3. Upsert assignments (race_key is the PK).
  const assignRows = assignments
    .filter(a => a.raceKey && a.courseId)
    .map(a => ({
      race_key: a.raceKey,
      meet: a.meet,
      season: a.season,
      event: a.event,
      course_id: a.courseId,
    }))
  if (assignRows.length > 0) {
    const r = await sbFetch('course_assignments', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(assignRows),
    })
    if (!r.ok) return res.status(500).json({ error: await r.text() })
  }

  // 4. Delete assignments no longer present (races the coach unassigned).
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
