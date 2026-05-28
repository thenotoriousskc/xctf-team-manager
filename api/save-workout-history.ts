import type { VercelRequest, VercelResponse } from '@vercel/node'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const CRON_SECRET = process.env.CRON_SECRET!

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  // Allow explicit date override; default to yesterday in PDT (UTC-7)
  // Cron runs at 7:05 UTC = 12:05am PDT — subtract 8h to land in previous PDT day
  const date = (req.query.date as string) ?? new Date(Date.now() - 8 * 3600_000).toISOString().slice(0, 10)

  const [wrRes, rRes] = await Promise.all([
    sbFetch('workout_rows?select=*&order=sort_order'),
    sbFetch('roster?select=name,inactive&order=sort_order'),
  ])
  if (!wrRes.ok || !rRes.ok) return res.status(502).json({ error: 'DB read failed' })

  const workoutRows: any[] = await wrRes.json()
  const roster: any[] = await rRes.json()

  const records: any[] = []
  for (const entry of roster) {
    if (!entry.name?.trim() || entry.inactive) continue
    const row = workoutRows.find(r =>
      (r.athletes_raw ?? '').split('\n').map((n: string) => n.trim()).filter(Boolean).includes(entry.name.trim())
    )
    if (!row) continue
    records.push({
      date,
      athlete_name: entry.name,
      focus: row.focus ?? '',
      coach: row.coach ?? '',
      warmup: row.warmup ?? '',
      workout: row.workout ?? '',
      cooldown: row.cooldown ?? '',
      pace_effort: row.pace_effort ?? '',
      notes: row.notes ?? '',
      segments: row.segments ?? [],
    })
  }

  if (records.length === 0) return res.json({ ok: true, saved: 0, date })

  const upsertRes = await sbFetch('workout_history', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(records),
  })
  if (!upsertRes.ok) return res.status(500).json({ error: await upsertRes.text() })

  res.json({ ok: true, saved: records.length, date })
}
