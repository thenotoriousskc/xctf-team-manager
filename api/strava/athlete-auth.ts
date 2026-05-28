import type { VercelRequest, VercelResponse } from '@vercel/node'

export default function handler(req: VercelRequest, res: VercelResponse) {
  const athlete = Array.isArray(req.query.athlete) ? req.query.athlete[0] : req.query.athlete
  if (!athlete) return res.status(400).send('Missing athlete name')

  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID!.trim(),
    redirect_uri: 'https://xctf-team.vercel.app/api/strava/athlete-callback',
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'activity:read',
    state: encodeURIComponent(athlete),
  })

  res.redirect(`https://www.strava.com/oauth/authorize?${params.toString()}`)
}
