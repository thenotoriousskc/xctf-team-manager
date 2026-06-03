import type { VercelRequest, VercelResponse } from '@vercel/node'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun', 'Treadmill'])
const APP_URL = 'https://xctf-team.vercel.app'

async function fetchAllActivities(accessToken: string): Promise<any[]> {
  const all: any[] = []
  let page = 1
  while (true) {
    const res = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?per_page=200&page=${page}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )
    if (!res.ok) break
    const batch: any[] = await res.json()
    if (!batch.length) break
    all.push(...batch)
    if (batch.length < 200) break // last page
    page++
  }
  return all
}

async function saveActivities(activities: any[], athleteName: string, stravaAthleteId: string) {
  const parts = athleteName.trim().split(/\s+/)
  const firstname = parts[0] ?? ''
  const lastname = parts.slice(1).join(' ')

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

  if (!rows.length) return

  // Upsert in batches of 500 to avoid request size limits
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500)
    await fetch(`${SUPABASE_URL}/rest/v1/strava_activities`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(batch),
    })
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const code = Array.isArray(req.query.code) ? req.query.code[0] : req.query.code
    const state = Array.isArray(req.query.state) ? req.query.state[0] : req.query.state
    const athlete = decodeURIComponent(state ?? '')

    if (!code || !athlete) {
      return res.redirect(`${APP_URL}?strava_athlete=error`)
    }

    const tokenRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID?.trim(),
        client_secret: process.env.STRAVA_CLIENT_SECRET?.trim(),
        code,
        grant_type: 'authorization_code',
      }),
    })

    if (!tokenRes.ok) {
      console.error('Token exchange failed:', await tokenRes.text())
      return res.redirect(`${APP_URL}?athlete=${encodeURIComponent(athlete)}&strava_athlete=error`)
    }

    const token = await tokenRes.json()
    const stravaAthleteId = String(token.athlete?.id ?? '')

    const dbRes = await fetch(`${SUPABASE_URL}/rest/v1/athlete_strava_tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        athlete_name: athlete,
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        token_expires_at: token.expires_at,
        strava_athlete_id: stravaAthleteId,
        updated_at: new Date().toISOString(),
      }),
    })

    if (!dbRes.ok) {
      console.error('DB save failed:', await dbRes.text())
      return res.redirect(`${APP_URL}?athlete=${encodeURIComponent(athlete)}&strava_athlete=error`)
    }

    // Fetch and save full activity history (best-effort, don't block on failure)
    try {
      const activities = await fetchAllActivities(token.access_token)
      console.log(`Fetched ${activities.length} total activities for ${athlete}`)
      await saveActivities(activities, athlete, stravaAthleteId)
      console.log(`Saved history for ${athlete}`)
    } catch (err) {
      console.error('History sync failed (non-fatal):', err)
    }

    res.redirect(`${APP_URL}?athlete=${encodeURIComponent(athlete)}&strava_athlete=connected`)
  } catch (err) {
    console.error('Athlete callback crash:', err)
    res.redirect(`${APP_URL}?strava_athlete=error`)
  }
}
