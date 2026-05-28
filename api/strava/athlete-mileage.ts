import type { VercelRequest, VercelResponse } from '@vercel/node'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

function weekBounds(tzOffset: number = -7): { thisWeekStart: number; lastWeekStart: number } {
  const now = new Date()
  const localNow = new Date(now.getTime() + tzOffset * 3600_000)
  const day = localNow.getUTCDay()
  const daysFromMon = day === 0 ? 6 : day - 1
  const mon = new Date(localNow)
  mon.setUTCDate(mon.getUTCDate() - daysFromMon)
  mon.setUTCHours(0, 0, 0, 0)
  const thisWeekMs = mon.getTime() - tzOffset * 3600_000
  return {
    thisWeekStart: Math.floor(thisWeekMs / 1000),
    lastWeekStart: Math.floor((thisWeekMs - 7 * 86400_000) / 1000),
  }
}

async function getTokenRecord(athleteName: string): Promise<{ access_token: string; refresh_token: string; token_expires_at: number; strava_athlete_id: string } | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/athlete_strava_tokens?athlete_name=eq.${encodeURIComponent(athleteName)}&select=access_token,refresh_token,token_expires_at,strava_athlete_id`,
    { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
  )
  const [data] = await res.json()
  return data ?? null
}

async function getValidToken(athleteName: string): Promise<{ token: string; stravaAthleteId: string }> {
  const data = await getTokenRecord(athleteName)
  if (!data?.access_token) throw new Error('not_connected')

  const nowSecs = Math.floor(Date.now() / 1000)
  if (data.token_expires_at > nowSecs + 60) {
    return { token: data.access_token, stravaAthleteId: data.strava_athlete_id }
  }

  // Refresh
  const refreshRes = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID?.trim(),
      client_secret: process.env.STRAVA_CLIENT_SECRET?.trim(),
      refresh_token: data.refresh_token,
      grant_type: 'refresh_token',
    }),
  })
  if (!refreshRes.ok) throw new Error('refresh_failed')
  const refreshed = await refreshRes.json()

  await fetch(`${SUPABASE_URL}/rest/v1/athlete_strava_tokens?athlete_name=eq.${encodeURIComponent(athleteName)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      token_expires_at: refreshed.expires_at,
      updated_at: new Date().toISOString(),
    }),
  })

  return { token: refreshed.access_token, stravaAthleteId: data.strava_athlete_id }
}

async function saveActivities(activities: any[], athleteName: string, stravaAthleteId: string) {
  const parts = athleteName.trim().split(/\s+/)
  const firstname = parts[0] ?? ''
  const lastname = parts.slice(1).join(' ')

  const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun', 'Treadmill'])
  const rows = activities
    .filter(a => RUN_TYPES.has(a.sport_type ?? a.type))
    .map(a => ({
      strava_id: String(a.id),
      athlete_strava_id: stravaAthleteId,
      athlete_firstname: firstname,
      athlete_lastname: lastname,
      name: a.name ?? '',
      sport_type: a.sport_type ?? a.type ?? '',
      start_date: a.start_date ?? null,
      start_date_local: a.start_date_local ?? null,
      distance_meters: a.distance ?? 0,
      moving_time: a.moving_time ?? 0,
      elapsed_time: a.elapsed_time ?? null,
      elevation_gain: a.total_elevation_gain ?? null,
      average_speed: a.average_speed ?? null,
      max_speed: a.max_speed ?? null,
      average_heartrate: a.average_heartrate ?? null,
      max_heartrate: a.max_heartrate ?? null,
      average_cadence: a.average_cadence ?? null,
      suffer_score: a.suffer_score ?? null,
      pr_count: a.pr_count ?? null,
    }))

  if (rows.length === 0) return

  await fetch(`${SUPABASE_URL}/rest/v1/strava_activities`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const athlete = Array.isArray(req.query.athlete) ? req.query.athlete[0] : req.query.athlete
  if (!athlete) return res.status(400).json({ error: 'Missing athlete' })

  try {
    const { token, stravaAthleteId } = await getValidToken(athlete)
    const { thisWeekStart, lastWeekStart } = weekBounds()

    const activitiesRes = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?per_page=100&after=${lastWeekStart}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!activitiesRes.ok) return res.status(502).json({ error: 'Strava API error' })

    const activities: any[] = await activitiesRes.json()
    const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun', 'Treadmill'])

    const runs = activities.filter(a => RUN_TYPES.has(a.sport_type ?? a.type))
    const thisWeekStartSec = thisWeekStart
    const miles = runs
      .filter(a => Math.floor(new Date(a.start_date).getTime() / 1000) >= thisWeekStartSec)
      .reduce((sum, a) => sum + (a.distance ?? 0) / 1609.344, 0)
    const lastWeekMiles = runs
      .filter(a => {
        const t = Math.floor(new Date(a.start_date).getTime() / 1000)
        return t >= lastWeekStart && t < thisWeekStartSec
      })
      .reduce((sum, a) => sum + (a.distance ?? 0) / 1609.344, 0)

    // Save activities + update last_strava_pull_at in background
    Promise.all([
      saveActivities(activities, athlete, stravaAthleteId),
      fetch(`${SUPABASE_URL}/rest/v1/roster?name=eq.${encodeURIComponent(athlete)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SERVICE_KEY,
          'Authorization': `Bearer ${SERVICE_KEY}`,
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ last_strava_pull_at: new Date().toISOString() }),
      }),
    ]).catch(err => console.error('Background update failed:', err))

    res.setHeader('Cache-Control', 'no-store')
    res.json({
      miles: Math.round(miles * 10) / 10,
      lastWeek: Math.round(lastWeekMiles * 10) / 10,
    })
  } catch (err: any) {
    if (err.message === 'not_connected') return res.json({ miles: null, connected: false })
    res.status(500).json({ error: err.message })
  }
}
