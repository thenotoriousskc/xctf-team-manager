import type { VercelRequest, VercelResponse } from '@vercel/node'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
// Strava approved this app for 10 authenticated athletes. An 11th would be
// rejected by Strava with an opaque error mid-OAuth; we block it up front with
// a clear message instead.
const ATHLETE_LIMIT = 10
const APP_URL = 'https://xctf-team.vercel.app'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const athlete = Array.isArray(req.query.athlete) ? req.query.athlete[0] : req.query.athlete
  if (!athlete) return res.status(400).send('Missing athlete name')

  // Enforce the athlete cap. An athlete who already has a token can always
  // re-auth (refresh / scope change); a new athlete is blocked once full. Fail
  // open on a count error — Strava enforces the hard limit regardless.
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/athlete_strava_tokens?select=athlete_name`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    })
    if (r.ok) {
      const rows = (await r.json()) as Array<{ athlete_name: string }>
      const names = new Set(rows.map(x => String(x.athlete_name).trim().toLowerCase()))
      const alreadyConnected = names.has(athlete.trim().toLowerCase())
      if (!alreadyConnected && names.size >= ATHLETE_LIMIT) {
        return res.redirect(`${APP_URL}?athlete=${encodeURIComponent(athlete)}&strava_athlete=limit`)
      }
    }
  } catch {
    // ignore — proceed to Strava
  }

  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID!.trim(),
    redirect_uri: `${APP_URL}/api/strava/athlete-callback`,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'activity:read',
    state: encodeURIComponent(athlete),
  })

  res.redirect(`https://www.strava.com/oauth/authorize?${params.toString()}`)
}
