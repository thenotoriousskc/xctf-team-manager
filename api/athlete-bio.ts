import type { VercelRequest, VercelResponse } from '@vercel/node'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const headers = {
  'Content-Type': 'application/json',
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')

  // GET /api/athlete-bio?name=Jane+Doe
  if (req.method === 'GET') {
    const name = req.query.name as string | undefined
    if (!name) return res.status(400).json({ error: 'Missing name' })

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/athlete_bios?athlete_name=eq.${encodeURIComponent(name)}&select=*`,
      { headers }
    )
    const rows = await r.json()
    return res.json(rows[0] ?? null)
  }

  // POST /api/athlete-bio — upsert a field, log to audit
  if (req.method === 'POST') {
    const { athlete_name, field_name, new_value, changed_by } = req.body as {
      athlete_name?: string
      field_name?: string
      new_value?: string
      changed_by?: string
    }

    if (!athlete_name || !field_name || !changed_by) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const ALLOWED_FIELDS = ['nickname', 'likes', 'dislikes', 'fun_facts', 'cheer', 'photo_url']
    if (!ALLOWED_FIELDS.includes(field_name)) {
      return res.status(400).json({ error: 'Invalid field' })
    }

    // Fetch current value for audit
    const existingR = await fetch(
      `${SUPABASE_URL}/rest/v1/athlete_bios?athlete_name=eq.${encodeURIComponent(athlete_name)}&select=${field_name}`,
      { headers }
    )
    const existing = await existingR.json()
    const old_value = existing[0]?.[field_name] ?? null

    // Upsert bio row
    await fetch(
      `${SUPABASE_URL}/rest/v1/athlete_bios`,
      {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({
          athlete_name,
          [field_name]: new_value ?? null,
          updated_at: new Date().toISOString(),
        }),
      }
    )

    // Write audit record
    await fetch(
      `${SUPABASE_URL}/rest/v1/athlete_bio_audit`,
      {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ athlete_name, changed_by, field_name, old_value, new_value: new_value ?? null }),
      }
    )

    return res.json({ ok: true })
  }

  return res.status(405).end()
}
