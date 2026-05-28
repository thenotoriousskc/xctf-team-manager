// Compute VDOT from each athlete's PRs (public/prs.json) and write to
// roster.vdot for any roster row whose vdot is currently NULL.
//
// Run: node scripts/backfill-vdot.mjs           # dry run
//      node scripts/backfill-vdot.mjs --apply   # write

import { readFileSync } from 'fs'

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const i = line.indexOf('=')
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
}
const SUPABASE_URL = env.SUPABASE_URL
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
const APPLY = process.argv.includes('--apply')

// ── VDOT math (mirrors src/lib/vdot.ts) ──────────────────────────────────────
function parseTimeSecs(mark) {
  const parts = String(mark).trim().split(':')
  if (parts.length === 2) {
    const m = parseFloat(parts[0]); const s = parseFloat(parts[1])
    return isNaN(m) || isNaN(s) ? null : m * 60 + s
  }
  if (parts.length === 1) { const s = parseFloat(parts[0]); return isNaN(s) ? null : s }
  return null
}
function eventMeters(event) {
  if (/relay/i.test(event)) return null
  const e = event.toLowerCase()
  if (e.includes('800')) return 800
  if (e.includes('1600')) return 1600
  if (e.includes('1 mile') || /\bmile\b/.test(e)) return 1609.34
  if (e.includes('3200') || e.includes('2 mile')) return 3218.69
  if (e.includes('3000') && !e.includes('steeplechase')) return 3000
  if (e.includes('5000') || e.includes('5k')) return 5000
  if (e.includes('10000') || e.includes('10k')) return 10000
  return null
}
function vdotFromRace(meters, secs) {
  const t = secs / 60
  const v = meters / t
  const pct = 0.8 + 0.1894393 * Math.exp(-0.012778 * t) + 0.2989558 * Math.exp(-0.1932605 * t)
  const vo2 = -4.60 + 0.182258 * v + 0.000104 * v * v
  return vo2 / pct
}
function bestVdot(prs) {
  let best = -Infinity, source = null
  for (const pr of prs ?? []) {
    const m = eventMeters(pr.event); if (!m) continue
    const s = parseTimeSecs(pr.mark); if (!s || s <= 0) continue
    if (m < 800 || m > 10000) continue
    const v = vdotFromRace(m, s)
    if (v > best) { best = v; source = pr }
  }
  if (!source) return null
  const sm = eventMeters(source.event) ?? Infinity
  const adj = sm <= 800 ? best * 0.90 : best
  return { vdot: Math.round(adj * 10) / 10, sourcePR: source }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function sb(path, opts = {}) {
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

async function main() {
  const prsFile = JSON.parse(readFileSync('public/prs.json', 'utf8'))
  const byName = new Map()
  for (const [id, rec] of Object.entries(prsFile)) {
    if (rec?.name) byName.set(rec.name.trim().toLowerCase(), { id, prs: rec.prs ?? [] })
  }

  const r = await sb('roster?select=id,name,vdot,inactive&order=name')
  if (!r.ok) throw new Error(`roster fetch ${r.status}: ${await r.text()}`)
  const roster = await r.json()
  const active = roster.filter(r => !r.inactive)

  const updates = []
  const skipped = []
  for (const row of active) {
    if (row.vdot != null) { skipped.push({ name: row.name, reason: `already set (${row.vdot})` }); continue }
    const match = byName.get(row.name.trim().toLowerCase())
    if (!match) { skipped.push({ name: row.name, reason: 'no PR data' }); continue }
    const calc = bestVdot(match.prs)
    if (!calc) { skipped.push({ name: row.name, reason: 'no usable PR' }); continue }
    updates.push({ id: row.id, name: row.name, vdot: calc.vdot, source: `${calc.sourcePR.event} ${calc.sourcePR.mark}` })
  }

  console.log(`Active: ${active.length}`)
  console.log(`Will write: ${updates.length}`)
  console.log(`Skipped: ${skipped.length}`)
  console.log()
  for (const u of updates) console.log(`  ✓ ${u.name.padEnd(28)} VDOT=${String(u.vdot).padStart(5)} ← ${u.source}`)
  console.log()
  for (const s of skipped) console.log(`  · ${s.name.padEnd(28)} ${s.reason}`)

  if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); return }

  let done = 0
  for (const u of updates) {
    const params = new URLSearchParams({ id: `eq.${u.id}` })
    const resp = await sb(`roster?${params}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ vdot: u.vdot }),
    })
    if (!resp.ok) { console.error(`PATCH ${u.name}: ${resp.status} ${await resp.text()}`); continue }
    done++
  }
  console.log(`\nWrote ${done}/${updates.length}.`)
}

main().catch(err => { console.error(err); process.exit(1) })
