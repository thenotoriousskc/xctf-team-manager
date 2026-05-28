import type { VercelRequest, VercelResponse } from '@vercel/node'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

function sb(path: string, opts: RequestInit = {}) {
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

async function getValidToken(
  row: { athlete_name: string; access_token: string; refresh_token: string; token_expires_at: number; strava_athlete_id: string }
): Promise<{ token: string; stravaAthleteId: string }> {
  const nowSecs = Math.floor(Date.now() / 1000)
  if (row.token_expires_at > nowSecs + 60) {
    return { token: row.access_token, stravaAthleteId: row.strava_athlete_id }
  }

  // Refresh expired token
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID?.trim(),
      client_secret: process.env.STRAVA_CLIENT_SECRET?.trim(),
      refresh_token: row.refresh_token,
      grant_type: 'refresh_token',
    }),
  })
  if (!r.ok) throw new Error(`refresh_failed for ${row.athlete_name}`)
  const refreshed = await r.json()

  await sb(`athlete_strava_tokens?athlete_name=eq.${encodeURIComponent(row.athlete_name)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      token_expires_at: refreshed.expires_at,
      updated_at: new Date().toISOString(),
    }),
  })

  return { token: refreshed.access_token, stravaAthleteId: row.strava_athlete_id }
}

const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun', 'Treadmill'])

async function syncAthlete(
  row: { athlete_name: string; access_token: string; refresh_token: string; token_expires_at: number; strava_athlete_id: string },
  after: number
): Promise<{ synced: number; error?: string }> {
  try {
    const { token, stravaAthleteId } = await getValidToken(row)

    const activitiesRes = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?per_page=100&after=${after}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!activitiesRes.ok) return { synced: 0, error: `Strava ${activitiesRes.status}` }

    const activities: any[] = await activitiesRes.json()
    const runs = activities.filter(a => RUN_TYPES.has(a.sport_type ?? a.type))
    if (runs.length === 0) return { synced: 0 }

    const parts = row.athlete_name.trim().split(/\s+/)
    const firstname = parts[0] ?? ''
    const lastname = parts.slice(1).join(' ')

    const dbRows = runs.map(a => ({
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

    await sb('strava_activities', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(dbRows),
    })

    // Update last_strava_pull_at on roster
    await sb(`roster?name=eq.${encodeURIComponent(row.athlete_name)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ last_strava_pull_at: new Date().toISOString() }),
    })

    return { synced: runs.length }
  } catch (err: any) {
    return { synced: 0, error: err.message }
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  // Protect cron calls — Vercel sets Authorization: Bearer <CRON_SECRET> automatically
  if (req.method === 'GET') {
    const cronSecret = process.env.CRON_SECRET
    const auth = req.headers.authorization
    if (cronSecret && auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  // Fetch all athlete tokens
  const tokensRes = await sb(
    'athlete_strava_tokens?select=athlete_name,access_token,refresh_token,token_expires_at,strava_athlete_id'
  )
  if (!tokensRes.ok) return res.status(502).json({ error: 'Failed to fetch tokens' })
  const tokens: {
    athlete_name: string
    access_token: string
    refresh_token: string
    token_expires_at: number
    strava_athlete_id: string
  }[] = await tokensRes.json()

  if (tokens.length === 0) return res.json({ synced: 0, athletes: [] })

  // Sync activities from the last 35 days (covers current + last month view)
  const after = Math.floor((Date.now() - 35 * 86400_000) / 1000)

  // Run sequentially to avoid Strava rate limits
  const results: { name: string; synced: number; error?: string }[] = []
  for (const row of tokens) {
    const result = await syncAthlete(row, after)
    results.push({ name: row.athlete_name, ...result })
  }

  const totalSynced = results.reduce((s, r) => s + r.synced, 0)
  const errors = results.filter(r => r.error)

  res.json({
    synced: totalSynced,
    athletes: results.length,
    errors: errors.length > 0 ? errors : undefined,
  })
}
