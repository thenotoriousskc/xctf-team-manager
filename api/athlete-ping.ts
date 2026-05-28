import type { VercelRequest, VercelResponse } from '@vercel/node'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const { athlete } = req.body as { athlete?: string }
  if (!athlete) return res.status(400).json({ error: 'Missing athlete' })

  await fetch(
    `${SUPABASE_URL}/rest/v1/roster?name=eq.${encodeURIComponent(athlete)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ last_login_at: new Date().toISOString() }),
    }
  )

  res.json({ ok: true })
}
