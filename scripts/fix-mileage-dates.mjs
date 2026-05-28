// One-off cleanup of strava_activities. Two passes:
//   1) Delete rows whose sport_type isn't a running type.
//   2) Fix start_date_local on rows the scraper wrote with the UTC-date bug
//      (set as `<date>T12:00:00`, which shifted Pacific-evening runs forward by a day).
//
// Run: node scripts/fix-mileage-dates.mjs            # dry run
//      node scripts/fix-mileage-dates.mjs --apply    # actually write

import { readFileSync } from 'fs'

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const i = line.indexOf('=')
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
}
const SUPABASE_URL = env.SUPABASE_URL
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
const APPLY = process.argv.includes('--apply')

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric', month: '2-digit', day: '2-digit',
})
const localDate = d => fmt.format(d)

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

const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun', 'Treadmill'])

async function fetchAll() {
  const all = []
  const BATCH = 1000
  let offset = 0
  while (true) {
    const p = new URLSearchParams()
    p.append('select', 'strava_id,start_date,start_date_local,sport_type,athlete_firstname,athlete_lastname')
    p.append('athlete_strava_id', 'neq.manual')
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

async function deleteNonRuns(rows) {
  const offenders = rows.filter(r => !RUN_TYPES.has(r.sport_type))
  console.log(`\n[1/2] Non-running rows: ${offenders.length}`)
  if (offenders.length === 0) return

  // Show breakdown by sport_type
  const counts = {}
  for (const o of offenders) counts[o.sport_type ?? '(null)'] = (counts[o.sport_type ?? '(null)'] ?? 0) + 1
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`)
  }
  for (const o of offenders.slice(0, 5)) {
    console.log(`  e.g. ${o.athlete_firstname} ${o.athlete_lastname} ${o.sport_type} ${String(o.start_date_local).slice(0, 10)}`)
  }

  if (!APPLY) {
    console.log('  Dry run — re-run with --apply to delete.')
    return
  }

  let done = 0
  for (const o of offenders) {
    const u = new URLSearchParams({ strava_id: `eq.${o.strava_id}` })
    const r = await sb(`strava_activities?${u}`, { method: 'DELETE' })
    if (!r.ok) {
      console.error(`DELETE ${o.strava_id} failed: ${r.status} ${await r.text()}`)
      continue
    }
    done++
    if (done % 25 === 0) process.stdout.write(`\r  Deleted ${done}/${offenders.length}`)
  }
  console.log(`\n  Deleted ${done}/${offenders.length}.`)
}

// Buggy rows: start_date_local has a time portion of 12:00:00 (the placeholder
// the scraper set when it didn't have real local time). OAuth-synced rows from
// team-sync.ts store the athlete's real start time, so they're skipped.
function looksBuggy(startLocal) {
  if (!startLocal) return false
  // PostgREST returns "2026-05-08T12:00:00+00:00" for a stored "2026-05-08T12:00:00".
  // Match the time portion regardless of the trailing offset.
  return /T12:00:00(\.0+)?(\+00:?00|Z)?$/.test(startLocal)
}

async function main() {
  const rows = await fetchAll()
  console.log(`Non-manual rows scanned: ${rows.length}`)

  await deleteNonRuns(rows)

  // Pass 2 — fix dates only on rows we keep
  const keep = rows.filter(r => RUN_TYPES.has(r.sport_type))
  const candidates = keep.filter(r => looksBuggy(r.start_date_local))
  console.log(`\n[2/2] Date-fix candidates (T12:00:00 placeholder): ${candidates.length}`)

  const fixes = []
  for (const row of candidates) {
    if (!row.start_date) continue
    const utc = new Date(row.start_date)
    if (!isFinite(+utc)) continue
    const correctDate = localDate(utc)
    const correctLocal = `${correctDate}T12:00:00`
    // Compare just the date portion of the stored value
    const storedDate = String(row.start_date_local).slice(0, 10)
    if (correctDate === storedDate) continue
    fixes.push({ ...row, correctLocal })
  }
  console.log(`  Need fix: ${fixes.length}`)

  if (fixes.length === 0) return

  // Show a few examples
  for (const f of fixes.slice(0, 5)) {
    console.log(`  e.g. ${f.athlete_firstname} ${f.athlete_lastname}  ${f.start_date_local} → ${f.correctLocal}  (UTC ${f.start_date})`)
  }

  if (!APPLY) {
    console.log('  Dry run only. Re-run with --apply to write.')
    return
  }

  let done = 0
  for (const f of fixes) {
    const u = new URLSearchParams({ strava_id: `eq.${f.strava_id}` })
    const r = await sb(`strava_activities?${u}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ start_date_local: f.correctLocal }),
    })
    if (!r.ok) {
      console.error(`PATCH ${f.strava_id} failed: ${r.status} ${await r.text()}`)
      continue
    }
    done++
    if (done % 25 === 0) process.stdout.write(`\r  Patched ${done}/${fixes.length}`)
  }
  console.log(`\nDone. Patched ${done}/${fixes.length}.`)
}

main().catch(err => { console.error(err); process.exit(1) })
