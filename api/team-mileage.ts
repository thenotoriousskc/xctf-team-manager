import type { VercelRequest, VercelResponse } from '@vercel/node'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!


function getMondayStr(tzOffset: number = -7): { thisWeekMon: string; lastWeekMon: string } {
  const now = new Date()
  const localNow = new Date(now.getTime() + tzOffset * 3600_000)
  const dow = localNow.getUTCDay()
  const daysFromMon = dow === 0 ? 6 : dow - 1
  const thisMon = new Date(localNow)
  thisMon.setUTCDate(localNow.getUTCDate() - daysFromMon)
  const yyyy = thisMon.getUTCFullYear()
  const mm = String(thisMon.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(thisMon.getUTCDate()).padStart(2, '0')
  const thisWeekMon = `${yyyy}-${mm}-${dd}`
  const lastMonDate = new Date(thisMon)
  lastMonDate.setUTCDate(thisMon.getUTCDate() - 7)
  const y2 = lastMonDate.getUTCFullYear()
  const m2 = String(lastMonDate.getUTCMonth() + 1).padStart(2, '0')
  const d2 = String(lastMonDate.getUTCDate()).padStart(2, '0')
  const lastWeekMon = `${y2}-${m2}-${d2}`
  return { thisWeekMon, lastWeekMon }
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const { thisWeekMon, lastWeekMon } = getMondayStr()

  const url = new URL(`${SUPABASE_URL}/rest/v1/strava_activities`)
  url.searchParams.set('select', 'athlete_firstname,athlete_lastname,distance_meters,start_date_local')
  url.searchParams.set('start_date_local', `gte.${lastWeekMon}T00:00:00`)

  const r = await fetch(url.toString(), {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
  })
  if (!r.ok) return res.status(502).json({ error: 'DB error' })

  const activities: any[] = await r.json()

  const result: Record<string, { currentWeek: number; lastWeek: number }> = {}
  for (const a of activities) {
    const name = `${a.athlete_firstname} ${a.athlete_lastname}`.trim()
    if (!result[name]) result[name] = { currentWeek: 0, lastWeek: 0 }
    const miles = (a.distance_meters ?? 0) / 1609.344
    const dateStr = (a.start_date_local ?? '').slice(0, 10)
    if (dateStr >= thisWeekMon) result[name].currentWeek += miles
    else result[name].lastWeek += miles
  }

  // Round to 1 decimal
  for (const v of Object.values(result)) {
    v.currentWeek = Math.round(v.currentWeek * 10) / 10
    v.lastWeek = Math.round(v.lastWeek * 10) / 10
  }

  res.setHeader('Cache-Control', 'no-store')
  res.json(result)
}
