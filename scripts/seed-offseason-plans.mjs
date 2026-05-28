// One-time seed: parse a LibreOffice/Excel `.ods` weekly-plan grid into
// offseason_plan_templates rows in Supabase.
//
// Expected sheet shape (mirrors the original Bay School layout):
//   Header row: Monday | Tue | Wed | Thu | Fri | Sat | Sun | Total | Tempo
//   Each template is one or two rows:
//     - One row:  [label?, 7 day cells, total]  e.g. "2/3 Walk Run"
//     - Two rows: main row [label?, 7 days, total, tempo?] +
//                 extras row ["20 miles per week", 7 day-extras]
//
// Run:
//   node scripts/seed-offseason-plans.mjs <path-to.ods>           # dry run, prints diff
//   node scripts/seed-offseason-plans.mjs <path-to.ods> --apply   # write
//
// Idempotent on label: re-runs that find an existing row with the same label
// update it in place. Brand-new labels are inserted.

import { readFileSync } from 'fs'
import { execSync } from 'child_process'
import { randomUUID } from 'crypto'

const ODS_PATH = process.argv.find(a => a.endsWith('.ods'))
if (!ODS_PATH) {
  console.error('Usage: node scripts/seed-offseason-plans.mjs <path-to.ods> [--apply]')
  process.exit(1)
}
const APPLY = process.argv.includes('--apply')

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const i = line.indexOf('=')
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
}
const SUPABASE_URL = env.SUPABASE_URL
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) { console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local'); process.exit(1) }

// ── Parse ODS ────────────────────────────────────────────────────────────────
// content.xml is inside the ODS zip. Use system unzip into a temp dir.
const tmpDir = `/tmp/seed-ods-${Date.now()}`
execSync(`mkdir -p "${tmpDir}" && unzip -o "${ODS_PATH}" content.xml -d "${tmpDir}" > /dev/null`)
const xml = readFileSync(`${tmpDir}/content.xml`, 'utf8')

function parseRows(xml) {
  const m = xml.match(/<table:table table:name="[^"]+"[\s\S]*?<\/table:table>/)
  if (!m) throw new Error('No table found in ODS')
  const body = m[0]
  const rowMatches = [...body.matchAll(/<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g)]
  return rowMatches.map(rm => {
    const cells = []
    const cellRe = /<table:table-cell\b([^>]*)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g
    let cm
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1] || ''
      const inner = cm[2] || ''
      const repeatM = attrs.match(/table:number-columns-repeated="(\d+)"/)
      const repeat = repeatM ? parseInt(repeatM[1], 10) : 1
      const text = inner.replace(/<[^>]+>/g, '').trim()
      for (let i = 0; i < Math.min(repeat, 20); i++) cells.push(text)
    }
    while (cells.length && !cells[cells.length - 1]) cells.pop()
    return cells
  })
}

const rows = parseRows(xml)

// Build template objects from the row pattern in this specific sheet:
//   - Header row "Monday | Tue | ... | Total Mileage | Tempo Minutes"
//   - Each template is either:
//       (a) 1 row: label + 7 day cells + total      (e.g. "2/3 Walk Run")
//       (b) 2 rows: main row (label or A/B + 7 cells + total [+ tempo]),
//                   followed by extras row ("20 miles per week", strides/tempos for selected days)
// Days in the sheet: Mon Tue Wed Thu Fri Sat Sun
const parseMilesOrRest = (s) => {
  if (!s) return { miles: null, isRest: false, notes: '' }
  const t = s.trim()
  if (/^rest/i.test(t)) return { miles: null, isRest: true, notes: '' }
  const n = parseFloat(t)
  if (isFinite(n) && /^[\d.]+$/.test(t)) return { miles: n, isRest: false, notes: '' }
  return { miles: null, isRest: false, notes: t }
}

const templates = []

const isExtrasRow = (r) => r.length > 0 && /\bmiles? per week\b/i.test(r[0])
const isHeaderRow = (r) => /^(monday|mon)$/i.test(String(r[0] ?? '').trim())
// A cell is a label only if it's NOT a plain number and NOT "Rest".
// "A", "B", "2/3 Walk Run" → label. "5", "Rest", "Rest (or cross train)" → Monday content.
const looksLikeLabel = (s) => {
  if (!s) return false
  const t = String(s).trim()
  if (/^\d+(\.\d+)?$/.test(t)) return false
  if (/^rest(\b|$)/i.test(t)) return false
  return true
}

for (let i = 0; i < rows.length; i++) {
  const r = rows[i]
  if (r.length === 0) continue
  if (isHeaderRow(r)) continue
  if (isExtrasRow(r)) continue
  if (r.length < 7) continue

  let label, days, total, tempo
  if (looksLikeLabel(r[0])) {
    label = r[0]
    days = r.slice(1, 8)
    total = r[8] ?? null
    tempo = r[9] ?? null
  } else {
    label = ''
    days = r.slice(0, 7)
    total = r[7] ?? null
    tempo = r[8] ?? null
  }

  const next = rows[i + 1]
  let extras = null
  let extrasLabel = ''
  if (next && isExtrasRow(next)) {
    extrasLabel = next[0]
    extras = next.slice(1)
  }

  const description = extrasLabel || ''
  // Synthesize a label.
  //   - Bare letter labels (A, B, …) get the mileage prefix from extras: "20A".
  //   - Missing labels reuse the "X miles per week" base; collisions get a (2) suffix.
  const mileagePrefix = extrasLabel.match(/^(\d+)\s*miles? per week/i)?.[1] ?? ''
  let synthesizedLabel
  if (label && /^[A-Z]$/i.test(label.trim()) && mileagePrefix) {
    synthesizedLabel = `${mileagePrefix}${label.trim().toUpperCase()}`
  } else if (label) {
    synthesizedLabel = label
  } else {
    const base = mileagePrefix ? `${mileagePrefix} mi` : `Week ${templates.length + 1}`
    synthesizedLabel = base
    let suffix = 2
    while (templates.some(t => t.label === synthesizedLabel)) {
      synthesizedLabel = `${base} (${suffix++})`
    }
  }

  const planDays = days.map((dayText, di) => {
    const { miles, isRest, notes } = parseMilesOrRest(dayText)
    const extra = extras ? (extras[di] ?? '') : ''
    return { miles, isRest, notes, segments: [], extra }
  })

  // Pad to 7 days if any are missing
  while (planDays.length < 7) planDays.push({ miles: null, isRest: false, notes: '', segments: [], extra: '' })

  const weeklyMiles = total ? parseFloat(String(total).split('-')[0]) || null : null
  const tempoMinutes = tempo ? parseFloat(String(tempo)) || null : null

  templates.push({
    label: synthesizedLabel,
    description,
    weeklyMiles,
    tempoMinutes,
    days: planDays,
  })
}

console.log(`Parsed ${templates.length} templates from ${ODS_PATH}\n`)
for (const t of templates) {
  console.log(`• ${t.label.padEnd(20)} ${t.description || ''}  total=${t.weeklyMiles ?? '–'}  tempo=${t.tempoMinutes ?? '–'}`)
  const cells = t.days.map((d, i) => {
    const top = d.isRest ? 'Rest' : d.miles != null ? String(d.miles) : (d.notes || '·')
    const bot = d.extra || ''
    return `${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][i]}: ${top}${bot ? ` / ${bot}` : ''}`
  })
  console.log('   ', cells.join('  |  '))
}

if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to write.')
  process.exit(0)
}

// ── Upsert to Supabase ───────────────────────────────────────────────────────
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

const r = await sb('offseason_plan_templates?select=id,label')
if (!r.ok) { console.error(`Failed to read existing templates: ${r.status} ${await r.text()}`); process.exit(1) }
const existing = await r.json()
const byLabel = new Map(existing.map(t => [t.label, t.id]))

for (let i = 0; i < templates.length; i++) {
  const t = templates[i]
  const body = {
    label: t.label,
    description: t.description,
    sort_order: i,
    weekly_miles: t.weeklyMiles,
    tempo_minutes: t.tempoMinutes,
    days: t.days,
  }
  if (byLabel.has(t.label)) {
    const id = byLabel.get(t.label)
    const params = new URLSearchParams({ id: `eq.${id}` })
    const resp = await sb(`offseason_plan_templates?${params}`, { method: 'PATCH', body: JSON.stringify(body), headers: { Prefer: 'return=minimal' } })
    if (!resp.ok) { console.error(`PATCH ${t.label}: ${resp.status} ${await resp.text()}`); continue }
    console.log(`  ↻ updated ${t.label}`)
  } else {
    const resp = await sb('offseason_plan_templates', { method: 'POST', body: JSON.stringify({ id: randomUUID(), ...body }), headers: { Prefer: 'return=minimal' } })
    if (!resp.ok) { console.error(`POST ${t.label}: ${resp.status} ${await resp.text()}`); continue }
    console.log(`  + inserted ${t.label}`)
  }
}
console.log('\nDone.')
