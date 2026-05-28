import type { VercelRequest, VercelResponse } from '@vercel/node'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

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

// Fetch all rows from a table, paginating in batches of 1000
async function sbFetchAll<T>(path: string): Promise<T[]> {
  const results: T[] = []
  const BATCH = 1000
  let offset = 0
  while (true) {
    const sep = path.includes('?') ? '&' : '?'
    const r = await sbFetch(`${path}${sep}limit=${BATCH}&offset=${offset}`)
    if (!r.ok) throw new Error(`DB error ${r.status}: ${await r.text()}`)
    const batch: T[] = await r.json()
    results.push(...batch)
    if (batch.length < BATCH) break
    offset += BATCH
  }
  return results
}

function getMondayStr(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  const dow = d.getDay()
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1))
  return d.toISOString().slice(0, 10)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  // GET ?weekly=1 — return weekly totals per athlete: { name: { 'YYYY-MM-DD (monday)': miles } }
  if (req.method === 'GET' && req.query.weekly) {
    const from = new Date()
    from.setDate(from.getDate() - 16 * 7)
    from.setHours(0, 0, 0, 0)

    const params = new URLSearchParams({
      select: 'athlete_firstname,athlete_lastname,distance_meters,start_date_local',
      start_date_local: `gte.${from.toISOString()}`,
    })
    const activities = await sbFetchAll<{
      athlete_firstname: string
      athlete_lastname: string
      distance_meters: number
      start_date_local: string
    }>(`strava_activities?${params}`)

    const result: Record<string, Record<string, number>> = {}
    for (const a of activities) {
      const name = `${a.athlete_firstname} ${a.athlete_lastname}`.trim()
      const date = (a.start_date_local ?? '').slice(0, 10)
      if (!date) continue
      const week = getMondayStr(date)
      const miles = (a.distance_meters ?? 0) / 1609.344
      if (!result[name]) result[name] = {}
      result[name][week] = (result[name][week] ?? 0) + miles
    }

    // Grand totals (all time)
    const totalsParams = new URLSearchParams({ select: 'athlete_firstname,athlete_lastname,distance_meters' })
    const allActs = await sbFetchAll<{ athlete_firstname: string; athlete_lastname: string; distance_meters: number }>(
      `strava_activities?${totalsParams}`
    )
    const totals: Record<string, number> = {}
    for (const a of allActs) {
      const name = `${a.athlete_firstname} ${a.athlete_lastname}`.trim()
      totals[name] = (totals[name] ?? 0) + (a.distance_meters ?? 0) / 1609.344
    }

    return res.json({ weekly: result, totals })
  }

  // GET — return daily miles per athlete:
  // { name: { 'YYYY-MM-DD': { miles: number; source: 'strava' | 'manual' | 'mixed' } } }
  if (req.method === 'GET') {
    const from = new Date()
    from.setDate(from.getDate() - 30)
    from.setHours(0, 0, 0, 0)

    const params = new URLSearchParams({
      select: 'athlete_firstname,athlete_lastname,distance_meters,start_date_local,athlete_strava_id',
      start_date_local: `gte.${from.toISOString()}`,
    })

    const activities = await sbFetchAll<{
      athlete_firstname: string
      athlete_lastname: string
      distance_meters: number
      start_date_local: string
      athlete_strava_id: string | null
    }>(`strava_activities?${params}`)

    type DayEntry = {
      miles: number
      source: 'strava' | 'manual' | 'mixed'
      manualMiles?: number
      stravaMiles?: number
    }
    const result: Record<string, Record<string, DayEntry>> = {}

    // Longest single run per athlete in the last 21 days — used by the offseason
    // card to compute a recommended max long run (= 1 + longest in 21d).
    const longestRun21d: Record<string, number> = {}
    const cutoff21 = new Date()
    cutoff21.setDate(cutoff21.getDate() - 21)
    cutoff21.setHours(0, 0, 0, 0)
    const cutoff21Str = cutoff21.toISOString().slice(0, 10)

    for (const a of activities) {
      const name = `${a.athlete_firstname} ${a.athlete_lastname}`.trim()
      const date = (a.start_date_local ?? '').slice(0, 10)
      if (!date) continue
      const miles = (a.distance_meters ?? 0) / 1609.344
      const isManual = a.athlete_strava_id === 'manual'
      const src: 'strava' | 'manual' = isManual ? 'manual' : 'strava'

      if (!result[name]) result[name] = {}
      const existing = result[name][date] ?? { miles: 0, source: src, manualMiles: 0, stravaMiles: 0 }
      const manualMiles = (existing.manualMiles ?? 0) + (isManual ? miles : 0)
      const stravaMiles = (existing.stravaMiles ?? 0) + (isManual ? 0 : miles)
      const source: 'strava' | 'manual' | 'mixed' =
        manualMiles > 0 && stravaMiles > 0 ? 'mixed' : isManual ? 'manual' : 'strava'
      result[name][date] = { miles: manualMiles + stravaMiles, source, manualMiles, stravaMiles }

      if (date >= cutoff21Str) {
        longestRun21d[name] = Math.max(longestRun21d[name] ?? 0, miles)
      }
    }

    // Grand totals (all time) — separate query, no date filter
    const totalsParams = new URLSearchParams({
      select: 'athlete_firstname,athlete_lastname,distance_meters',
    })
    const allActivities = await sbFetchAll<{ athlete_firstname: string; athlete_lastname: string; distance_meters: number }>(
      `strava_activities?${totalsParams}`
    )

    const totals: Record<string, number> = {}
    for (const a of allActivities) {
      const name = `${a.athlete_firstname} ${a.athlete_lastname}`.trim()
      totals[name] = (totals[name] ?? 0) + (a.distance_meters ?? 0) / 1609.344
    }

    return res.json({ daily: result, totals, longestRun21d })
  }

  // POST — upsert or delete mileage entries
  // Body: { athleteName, date, miles, source? }
  //   miles > 0  → upsert manual entry (source ignored)
  //   miles <= 0 → delete; source='strava' deletes all Strava rows that day, otherwise deletes the manual row
  if (req.method === 'POST') {
    const { athleteName, date, miles, source } = req.body as {
      athleteName: string
      date: string
      miles: number
      source?: 'strava' | 'manual'
    }
    const parts = athleteName.trim().split(/\s+/)
    const firstname = parts[0]
    const lastname = parts.slice(1).join(' ')
    const syntheticId = `manual_${athleteName.replace(/\s+/g, '_').toLowerCase()}_${date}`

    if (miles <= 0) {
      if (source === 'strava') {
        const params = new URLSearchParams()
        params.append('athlete_firstname', `eq.${firstname}`)
        params.append('athlete_lastname', `eq.${lastname}`)
        params.append('athlete_strava_id', 'neq.manual')
        params.append('start_date_local', `gte.${date}T00:00:00`)
        params.append('start_date_local', `lte.${date}T23:59:59`)
        const r = await sbFetch(`strava_activities?${params}`, { method: 'DELETE' })
        if (!r.ok) return res.status(500).json({ error: await r.text() })
        return res.json({ ok: true })
      }
      const params = new URLSearchParams({ strava_id: `eq.${syntheticId}` })
      await sbFetch(`strava_activities?${params}`, { method: 'DELETE' })
      return res.json({ ok: true })
    }

    const r = await sbFetch('strava_activities', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        strava_id: syntheticId,
        athlete_strava_id: 'manual',
        athlete_firstname: firstname,
        athlete_lastname: lastname,
        name: 'Manual entry',
        sport_type: 'Run',
        start_date: `${date}T12:00:00Z`,
        start_date_local: `${date}T12:00:00`,
        distance_meters: miles * 1609.344,
        moving_time: 0,
        elapsed_time: 0,
      }),
    })
    if (!r.ok) return res.status(500).json({ error: await r.text() })
    return res.json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
