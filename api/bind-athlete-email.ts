import type { VercelRequest, VercelResponse } from '@vercel/node'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Restrict auto-bind to a specific email domain (typically the school's). When
// unset, the auto-bind endpoint refuses any sign-in — coaches must fill the
// roster.email column by hand, or sign-in users must still match by display
// name only (no auto-write). Set ALLOWED_EMAIL_DOMAIN=yourschool.org in the
// Vercel env to enable.
const ALLOWED_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN ?? ''

function normName(s: string) {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

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

// POST /api/bind-athlete-email
// Body: { displayName: string, email: string }
//
// Auto-binds an authenticated user's email to the matching roster row when:
//   - email is from the allowed school domain
//   - displayName matches a roster entry name (case-insensitive, whitespace-normalized)
//   - the matched roster row currently has email=null (one-shot, can't overwrite)
//
// Server-side validation prevents anyone from rebinding someone else's row from
// the client. The matching roster row is identified server-side from displayName,
// not blindly trusted from the request.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { displayName, email } = (req.body ?? {}) as { displayName?: string; email?: string }
  if (!displayName || !email) return res.status(400).json({ error: 'displayName and email required' })

  const emailLower = email.trim().toLowerCase()
  if (!ALLOWED_DOMAIN) {
    return res.status(403).json({ error: 'Email auto-bind disabled (ALLOWED_EMAIL_DOMAIN not set)' })
  }
  if (!emailLower.endsWith(`@${ALLOWED_DOMAIN}`)) {
    return res.status(403).json({ error: `Email must be @${ALLOWED_DOMAIN}` })
  }

  // Look up the roster row by name (case-insensitive)
  const lookupParams = new URLSearchParams({ select: 'id,name,email' })
  const lookupRes = await sb(`roster?${lookupParams}`)
  if (!lookupRes.ok) return res.status(502).json({ error: 'roster lookup failed' })
  const rows: { id: string; name: string; email: string | null }[] = await lookupRes.json()

  const target = rows.find(r => normName(r.name) === normName(displayName))
  if (!target) return res.status(404).json({ error: 'no roster entry matches displayName', bound: false })

  // Already bound — only allow if it matches what we'd set (idempotent), otherwise refuse
  if (target.email && target.email.toLowerCase() !== emailLower) {
    return res.status(409).json({ error: 'roster row already bound to a different email', bound: false })
  }
  if (target.email && target.email.toLowerCase() === emailLower) {
    return res.json({ bound: true, alreadyBound: true, name: target.name })
  }

  // Atomic: PATCH only if email IS NULL
  const patchParams = new URLSearchParams({ id: `eq.${target.id}`, email: 'is.null' })
  const patchRes = await sb(`roster?${patchParams}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ email: emailLower }),
  })
  if (!patchRes.ok) return res.status(500).json({ error: await patchRes.text() })
  const patched = await patchRes.json()
  if (!Array.isArray(patched) || patched.length === 0) {
    return res.status(409).json({ error: 'race: email was set between lookup and patch', bound: false })
  }
  return res.json({ bound: true, alreadyBound: false, name: target.name })
}
