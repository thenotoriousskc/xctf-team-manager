// One-time import: Google Sheets mileage log → strava_activities
// Run: node scripts/import-mileage.mjs

import { readFileSync } from 'fs'

// Load env
const envText = readFileSync('.env.local', 'utf8')
const env = {}
for (const line of envText.split('\n')) {
  const eq = line.indexOf('=')
  if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
}
const SUPABASE_URL = env.SUPABASE_URL
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY

const SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1M0EqpiLRrJDLA_lZfNHwh9kCQhBbf4pKpZnT8I7lgWU/export?format=csv&gid=1723361870'

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCsv(text) {
  const rows = []
  let row = [], field = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      if (inQ && text[i + 1] === '"') { field += '"'; i++ }
      else inQ = !inQ
    } else if (c === ',' && !inQ) {
      row.push(field); field = ''
    } else if ((c === '\n' || c === '\r') && !inQ) {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(f => f.trim())) rows.push(row)
      row = []
    } else {
      field += c
    }
  }
  if (field || row.length) { row.push(field); if (row.some(f => f.trim())) rows.push(row) }
  return rows
}

// ── Date helpers ──────────────────────────────────────────────────────────────
// Columns span Aug 2025 → Apr 2026: month 8-12 = 2025, month 1-7 = 2026
function colToDate(header) {
  const parts = header.trim().split('/')
  if (parts.length !== 2) return null
  const m = parseInt(parts[0], 10)
  const d = parseInt(parts[1], 10)
  if (isNaN(m) || isNaN(d) || m < 1 || m > 12 || d < 1 || d > 31) return null
  const year = m >= 8 ? 2025 : 2026
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// ── Supabase upsert ───────────────────────────────────────────────────────────
async function upsertBatch(rows) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/strava_activities`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  })
  if (!r.ok) throw new Error(`Supabase error ${r.status}: ${await r.text()}`)
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Fetching sheet...')
  const res = await fetch(SHEET_URL, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const csv = await res.text()

  const rows = parseCsv(csv)
  const headers = rows[0]
  console.log(`Rows: ${rows.length - 1} athletes, ${headers.length} columns`)

  // Date columns start after the fixed summary columns
  // Fixed: Name, target miles, XC Top, Total, Last 7, Cur Week (indices 0-5)
  const DATE_START = 6
  const dateCols = []
  for (let i = DATE_START; i < headers.length; i++) {
    const date = colToDate(headers[i])
    if (date) dateCols.push({ index: i, date })
  }
  console.log(`Date columns: ${dateCols.length} (${dateCols[0]?.date} → ${dateCols[dateCols.length - 1]?.date})`)

  const activities = []
  const skipped = { noName: 0, notNumeric: 0, zero: 0 }

  for (let ri = 1; ri < rows.length; ri++) {
    const row = rows[ri]
    const name = row[0]?.trim()
    if (!name) { skipped.noName++; continue }

    const parts = name.split(/\s+/)
    const firstname = parts[0] ?? ''
    const lastname = parts.slice(1).join(' ')

    for (const { index, date } of dateCols) {
      const cell = (row[index] ?? '').trim()
      if (!cell) continue
      const miles = parseFloat(cell)
      if (isNaN(miles)) { skipped.notNumeric++; continue }
      if (miles <= 0) { skipped.zero++; continue }

      activities.push({
        strava_id: `manual_${name.replace(/\s+/g, '_').toLowerCase()}_${date}`,
        athlete_strava_id: 'manual',
        athlete_firstname: firstname,
        athlete_lastname: lastname,
        name: 'Imported entry',
        sport_type: 'Run',
        start_date: `${date}T12:00:00Z`,
        start_date_local: `${date}T12:00:00`,
        distance_meters: miles * 1609.344,
        moving_time: 0,
        elapsed_time: 0,
      })
    }
  }

  console.log(`Built ${activities.length} records (skipped: ${JSON.stringify(skipped)})`)

  const BATCH = 200
  let done = 0
  for (let i = 0; i < activities.length; i += BATCH) {
    await upsertBatch(activities.slice(i, i + BATCH))
    done += Math.min(BATCH, activities.length - i)
    process.stdout.write(`\r  Upserted ${done}/${activities.length}`)
  }
  console.log('\nDone!')
}

main().catch(err => { console.error(err); process.exit(1) })
