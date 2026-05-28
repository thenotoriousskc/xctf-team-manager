// Bulk conflict resolver: for every (athlete, local_date) where BOTH a manual
// row and a Strava row exist, delete the manual row.
//
// Run: node scripts/resolve-conflicts-strava-wins.mjs           # dry run
//      node scripts/resolve-conflicts-strava-wins.mjs --apply   # actually delete

import { readFileSync } from 'fs'

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const i = line.indexOf('=')
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
}
const SUPABASE_URL = env.SUPABASE_URL
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
const APPLY = process.argv.includes('--apply')

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

async function fetchAll() {
  const all = []
  const BATCH = 1000
  let offset = 0
  while (true) {
    const p = new URLSearchParams()
    p.append('select', 'strava_id,athlete_strava_id,athlete_firstname,athlete_lastname,start_date_local,distance_meters')
    p.append('limit', String(BATCH))
    p.append('offset', String(offset))
    const r = await sb(`strava_activities?${p}`)
    if (!r.ok) throw new Error(`fetch ${r.status}: ${await r.text()}`)
    const batch = await r.json()
    all.push(...batch)
    if (batch.length < BATCH) break
    offset += BATCH
  }
  return all
}

async function main() {
  const rows = await fetchAll()
  console.log(`Total rows: ${rows.length}`)

  // Group by athlete + local date
  const byKey = new Map()
  for (const r of rows) {
    const date = String(r.start_date_local ?? '').slice(0, 10)
    if (!date) continue
    const name = `${r.athlete_firstname} ${r.athlete_lastname}`.trim()
    const key = `${name.toLowerCase()}|${date}`
    if (!byKey.has(key)) byKey.set(key, { name, date, manual: [], strava: [] })
    const bucket = byKey.get(key)
    if (r.athlete_strava_id === 'manual') bucket.manual.push(r)
    else bucket.strava.push(r)
  }

  const conflicts = [...byKey.values()].filter(b => b.manual.length > 0 && b.strava.length > 0)
  const toDelete = conflicts.flatMap(b => b.manual)
  console.log(`Conflict days: ${conflicts.length}`)
  console.log(`Manual rows to delete: ${toDelete.length}`)

  // Show first 10 conflicts with their distances
  for (const c of conflicts.slice(0, 10)) {
    const m = c.manual.reduce((s, r) => s + r.distance_meters / 1609.344, 0)
    const s = c.strava.reduce((s, r) => s + r.distance_meters / 1609.344, 0)
    console.log(`  ${c.date}  ${c.name.padEnd(28)}  manual=${m.toFixed(1)}mi  strava=${s.toFixed(1)}mi`)
  }
  if (conflicts.length > 10) console.log(`  ... and ${conflicts.length - 10} more`)

  if (toDelete.length === 0) return
  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to delete the manual rows.')
    return
  }

  let done = 0
  for (const r of toDelete) {
    const u = new URLSearchParams({ strava_id: `eq.${r.strava_id}` })
    const resp = await sb(`strava_activities?${u}`, { method: 'DELETE' })
    if (!resp.ok) {
      console.error(`DELETE ${r.strava_id} failed: ${resp.status} ${await resp.text()}`)
      continue
    }
    done++
    if (done % 25 === 0) process.stdout.write(`\r  Deleted ${done}/${toDelete.length}`)
  }
  console.log(`\nDeleted ${done}/${toDelete.length} manual rows.`)
}

main().catch(err => { console.error(err); process.exit(1) })
