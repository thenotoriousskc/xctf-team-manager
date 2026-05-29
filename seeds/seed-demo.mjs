// Populate a Supabase project with realistic-but-fake demo data:
//   - 20 athletes with mixed groups, targets, VDOTs, and feature flags
//   - 4 weekly plan templates spanning beginner → varsity volume
//   - 1 workout group for today
//   - 14 days of mileage entries per athlete (some hitting target, some not)
//
// Usage:
//   node seeds/seed-demo.mjs            # dry run
//   node seeds/seed-demo.mjs --apply    # write to .env.local's Supabase
//   node seeds/seed-demo.mjs --apply --wipe  # delete all existing data first
//
// Run this AFTER applying every file in migrations/. It's idempotent on
// athlete name + plan label — re-runs update in place.

import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'

const APPLY = process.argv.includes('--apply')
const WIPE = process.argv.includes('--wipe')

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const i = line.indexOf('=')
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
}
const SUPABASE_URL = env.SUPABASE_URL
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

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

// ── Roster ───────────────────────────────────────────────────────────────────
// Two coaches, then 20 athletes mixed across distance/sprint groups. VDOT
// roughly matches event focus. A few flags to demo the dashboard's features.
const ROSTER = [
  { name: 'Alex Chen',        group: 'Distance',  target: '32', vdot: 56.0, offseason: false, manual_mileage: false, inactive: false },
  { name: 'Jordan Kim',       group: 'Distance',  target: '28', vdot: 52.5 },
  { name: 'Maya Patel',       group: 'Distance',  target: '24', vdot: 49.2 },
  { name: 'Taylor Brooks',    group: 'Distance',  target: '36', vdot: 58.7 },
  { name: 'Jamie Rivera',     group: 'Distance',  target: '24', vdot: 48.8 },
  { name: 'Sam Davis',        group: 'Distance',  target: '32', vdot: 54.3, offseason: true },
  { name: 'Casey Nguyen',     group: 'Distance',  target: '20', vdot: 45.1, manual_mileage: true },
  { name: 'Riley Foster',     group: 'Distance',  target: '28', vdot: 51.6 },
  { name: 'Avery Park',       group: 'Mid',       target: '18', vdot: 47.2 },
  { name: 'Quinn Hayes',      group: 'Mid',       target: '24', vdot: 50.4 },
  { name: 'Drew Murphy',      group: 'Mid',       target: '20', vdot: 46.8 },
  { name: 'Skyler Reyes',     group: 'Mid',       target: '15', vdot: 43.5, offseason: true, manual_mileage: true },
  { name: 'Morgan Wells',     group: 'Sprint',    target: '15', vdot: 42.0 },
  { name: 'Reese Anderson',   group: 'Sprint',    target: '12', vdot: 40.5 },
  { name: 'Cameron Liu',      group: 'Sprint',    target: '15', vdot: 41.8 },
  { name: 'Logan Bauer',      group: 'Sprint',    target: '12', vdot: 39.7 },
  { name: 'Parker Schultz',   group: 'Field',     target: '12', vdot: null },
  { name: 'Sage Martinez',    group: 'Field',     target: '12', vdot: null },
  { name: 'Rowan O\'Connor',  group: 'Distance',  target: '24', vdot: 48.0, offseason: true },
  { name: 'Emerson Carter',   group: 'Distance',  target: '28', vdot: 51.0, inactive: true },
]

// ── Plan templates ──────────────────────────────────────────────────────────
// Four progressions. Each day has miles + optional structured tempo segments.
function day(miles, opts = {}) {
  return {
    miles: opts.rest ? null : miles,
    isRest: !!opts.rest,
    notes: opts.notes ?? '',
    segments: opts.segments ?? [],
    extra: opts.extra ?? '',
  }
}
function tempoSeg(qty, mins) {
  return [{ id: randomUUID().slice(0, 8), qty: String(qty), distance: String(mins), unit: 'minutes', pace: 'tempo', restDuration: '90s', rest: 'jog' }]
}

const PLAN_TEMPLATES = [
  {
    label: 'Recovery week',
    description: '12 miles per week — light',
    weekly_miles: 12,
    days: [
      day(3, { extra: '2 strides' }),
      day(0, { rest: true }),
      day(3, { extra: '2 strides' }),
      day(3),
      day(3),
      day(0, { rest: true }),
      day(0, { rest: true }),
    ],
  },
  {
    label: 'Base 18',
    description: '18 miles per week',
    weekly_miles: 18,
    days: [
      day(4, { extra: '2 strides' }),
      day(3, { extra: '2 strides' }),
      day(0, { rest: true }),
      day(4),
      day(3),
      day(4),
      day(0, { rest: true }),
    ],
  },
  {
    label: 'Base 28 A',
    description: '28 miles per week',
    weekly_miles: 28,
    days: [
      day(4, { segments: tempoSeg(4, 5) }),
      day(3, { extra: '4 strides' }),
      day(4, { segments: tempoSeg(4, 5) }),
      day(5, { extra: '4 strides' }),
      day(7, { extra: '4×30s pickups' }),
      day(0, { rest: true }),
      day(5),
    ],
  },
  {
    label: 'Pre-season 36',
    description: '36 miles per week',
    weekly_miles: 36,
    days: [
      day(5, { segments: tempoSeg(5, 5) }),
      day(5, { extra: '4 strides' }),
      day(6, { extra: '2 strides' }),
      day(5, { segments: tempoSeg(5, 5) }),
      day(9, { extra: '4 strides' }),
      day(0, { rest: true, extra: '4×30s pickups' }),
      day(6),
    ],
  },
]

// ── Today's workout ─────────────────────────────────────────────────────────
const TODAY_WORKOUT = {
  athletes_raw: 'Alex Chen\nJordan Kim\nMaya Patel\nTaylor Brooks\nJamie Rivera\nRiley Foster\nQuinn Hayes',
  coach: 'Coach Lin',
  focus: 'Aerobic build',
  workout: '5×800m at 5k pace · 90s jog recovery',
  pace_effort: 'Controlled, even splits. Last rep can drop 1–2s if feeling strong.',
  notes: 'Warmup: 1.5 mi + 4 strides. Cooldown: 1 mi easy.',
  warmup: '15',
  cooldown: '10',
  segments: [
    { id: randomUUID().slice(0, 8), qty: '5', distance: '800', unit: 'meters', pace: '5k', restDuration: '90s', rest: 'jog' },
  ],
}

// ── Mileage entries (last 14 days) ──────────────────────────────────────────
// Generates one row per athlete per day, with miles ≈ target/7 ± noise.
// Marked as manual entries (athlete_strava_id = 'manual') so they show up
// blue in the dashboard.
function localDate(daysAgo) {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

function generateMileage() {
  const rows = []
  for (const r of ROSTER) {
    if (r.inactive) continue
    const target = parseFloat(r.target) || 0
    if (target <= 0) continue
    const daily = target / 7
    for (let i = 0; i < 14; i++) {
      // Skip ~1 day per week (rest day) and randomize a bit
      const skip = (i + r.name.length) % 7 === 0
      if (skip) continue
      const noise = 0.6 + Math.random() * 0.9 // 0.6× – 1.5×
      const miles = +(daily * noise).toFixed(1)
      if (miles < 0.5) continue
      const date = localDate(i)
      const [firstname, ...rest] = r.name.split(/\s+/)
      const lastname = rest.join(' ')
      rows.push({
        strava_id: `manual_${r.name.toLowerCase().replace(/\s+/g, '_').replace(/'/g, '')}_${date}`,
        athlete_strava_id: 'manual',
        athlete_firstname: firstname,
        athlete_lastname: lastname,
        name: 'Demo entry',
        sport_type: 'Run',
        start_date: `${date}T12:00:00Z`,
        start_date_local: `${date}T12:00:00`,
        distance_meters: miles * 1609.344,
        moving_time: Math.round(miles * 480),     // ≈ 8 min/mi
        elapsed_time: Math.round(miles * 480),
      })
    }
  }
  return rows
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Target: ${SUPABASE_URL}`)
  console.log(`Will seed: ${ROSTER.length} athletes, ${PLAN_TEMPLATES.length} plans, 1 workout, ~${ROSTER.filter(r => !r.inactive).length * 12} mileage rows`)
  if (WIPE) console.log('⚠️  --wipe set: will DELETE all existing rows in roster, offseason_plan_templates, workout_rows, strava_activities first')

  if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); return }

  if (WIPE) {
    console.log('\n[wipe]')
    for (const tbl of ['strava_activities', 'workout_rows', 'offseason_plan_templates']) {
      const r = await sb(`${tbl}?strava_id=neq.__never__&id=neq.00000000-0000-0000-0000-000000000000`, { method: 'DELETE' })
      console.log(`  ${tbl}: ${r.status}`)
    }
    // Wipe roster separately so we can preserve nothing
    const r = await sb('roster?id=neq.00000000-0000-0000-0000-000000000000', { method: 'DELETE' })
    console.log(`  roster: ${r.status}`)
  }

  // ── Plan templates ────────────────────────────────────────────────────────
  console.log('\n[plan templates]')
  const planIds = {}
  for (let i = 0; i < PLAN_TEMPLATES.length; i++) {
    const t = PLAN_TEMPLATES[i]
    const id = randomUUID()
    planIds[t.label] = id
    const body = {
      id,
      label: t.label,
      description: t.description,
      sort_order: i,
      weekly_miles: t.weekly_miles,
      tempo_minutes: t.days.reduce((sum, d) => sum + d.segments.reduce((s, seg) => s + parseFloat(seg.qty) * parseFloat(seg.distance), 0), 0) || null,
      days: t.days,
    }
    const r = await sb('offseason_plan_templates', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(body) })
    if (!r.ok) console.error(`  FAIL ${t.label}: ${r.status} ${await r.text()}`)
    else console.log(`  ✓ ${t.label}`)
  }

  // ── Roster ────────────────────────────────────────────────────────────────
  console.log('\n[roster]')
  for (let i = 0; i < ROSTER.length; i++) {
    const r = ROSTER[i]
    // Assign plans round-robin to athletes that don't already have one
    const planLabels = Object.keys(planIds)
    const planLabel = planLabels[i % planLabels.length]
    const body = {
      name: r.name,
      group: r.group,
      target: r.target,
      note: '',
      checkout: '',
      sort_order: i,
      inactive: r.inactive ?? false,
      offseason: r.offseason ?? false,
      manual_mileage: r.manual_mileage ?? false,
      bio_edit: false,
      vdot: r.vdot ?? null,
      plan_template_id: r.offseason ? planIds[planLabel] : null,
    }
    const resp = await sb('roster', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) })
    if (!resp.ok) console.error(`  FAIL ${r.name}: ${resp.status} ${await resp.text()}`)
    else console.log(`  ✓ ${r.name}`)
  }

  // ── Workout row ───────────────────────────────────────────────────────────
  console.log('\n[workout]')
  const wr = await sb('workout_rows', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ...TODAY_WORKOUT, sort_order: 0 }) })
  if (!wr.ok) console.error(`  FAIL: ${wr.status} ${await wr.text()}`)
  else console.log(`  ✓ Aerobic build group`)

  // ── Mileage ───────────────────────────────────────────────────────────────
  const mileage = generateMileage()
  console.log(`\n[mileage: ${mileage.length} rows]`)
  const BATCH = 200
  for (let i = 0; i < mileage.length; i += BATCH) {
    const batch = mileage.slice(i, i + BATCH)
    const r = await sb('strava_activities', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(batch) })
    if (!r.ok) console.error(`  batch FAIL: ${r.status} ${await r.text()}`)
    else process.stdout.write(`\r  wrote ${Math.min(i + BATCH, mileage.length)}/${mileage.length}`)
  }
  console.log('\n\nDone.')
}

main().catch(err => { console.error(err); process.exit(1) })
