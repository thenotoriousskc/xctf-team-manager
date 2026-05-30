import type { VercelRequest, VercelResponse } from '@vercel/node'

// Writes to offseason_plan_templates run through here with the service-role key
// (RLS denies anon writes; anon keeps SELECT for athlete/coach reads). The
// caller must present a valid Supabase session whose email is an authorized
// coach — mirrors the client-side gate in src/lib/coaches.ts.

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type PlanTemplate = {
  id?: string
  label: string
  description: string
  weeklyMiles: number | null
  tempoMinutes: number | null
  days: unknown
}

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

// Resolve the signed-in user's email from their access token, then confirm
// they're an authorized coach (env allowlist ∪ settings.coaches). Empty list
// anywhere → open, matching isAuthorizedCoach() on the client.
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
  if (list.length === 0) return email // no allowlist configured → open
  return list.includes(email) ? email : null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  const email = await authorizedCoachEmail(token)
  if (!email) return res.status(403).json({ error: 'Not authorized' })

  const { templates } = req.body as { templates?: PlanTemplate[] }
  if (!Array.isArray(templates)) return res.status(400).json({ error: 'Missing templates' })

  // Delete rows whose IDs are no longer present (only real UUIDs exist in the DB).
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

  // Strip non-UUID client IDs so Postgres assigns one (matches the prior
  // anon-client upsert in src/lib/db.ts).
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
