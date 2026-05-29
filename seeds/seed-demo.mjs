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
//   node seeds/seed-demo.mjs --apply --bios-only  # only (re)seed athlete bios
//
// Run this AFTER applying every file in migrations/. Bios are idempotent
// (athlete_name PK, merge-duplicates) so --bios-only is safe to re-run.
// The roster/plan/workout/mileage seed is NOT idempotent — re-running the
// full seed without --wipe creates duplicate athletes.

import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'

const APPLY = process.argv.includes('--apply')
const WIPE = process.argv.includes('--wipe')
const BIOS_ONLY = process.argv.includes('--bios-only')

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

// ── Athlete bios ──────────────────────────────────────────────────────────────
// One bio per athlete (keyed by name, matching ROSTER). photo_url left null —
// the bio page falls back to initials. Re-runnable: athlete_bios PK is the name.
const BIOS = [
  { athlete_name: 'Alex Chen',       nickname: 'Speedy',     cheer: 'Chant "AL-EX" on the final straight — it works every time.', likes: 'Negative splits, breakfast burritos, rainy long runs', dislikes: 'Treadmills, untied shoelaces', fun_facts: 'Team captain. Has run every day for 400+ days straight.' },
  { athlete_name: 'Jordan Kim',      nickname: 'JK',         cheer: 'Just yell "GO JORDAN!" loud enough to hear at the mile mark.', likes: 'Track Tuesdays, cold brew, new PRs', dislikes: 'Hills (claims to, secretly loves them)', fun_facts: 'Can recite every mile split from last season\'s 5k.' },
  { athlete_name: 'Maya Patel',      nickname: null,         cheer: 'A cowbell does the trick.', likes: 'Easy days, team pasta dinners', dislikes: 'Early-morning intervals', fun_facts: 'Plays violin and runs — claims both are about rhythm.' },
  { athlete_name: 'Taylor Brooks',   nickname: 'T-Bird',     cheer: 'Caw like a bird at the start line. Long story.', likes: 'Tempo runs, trail shoes, podcasts on the cooldown', dislikes: 'Humidity', fun_facts: 'Holds the team record for the steeplechase.' },
  { athlete_name: 'Jamie Rivera',    nickname: 'Jam',        cheer: 'Clap on the beat — Jamie paces to it.', likes: 'Group runs, fruit snacks at the finish', dislikes: 'Running alone', fun_facts: 'Started as a sprinter, converted to distance sophomore year.' },
  { athlete_name: 'Sam Davis',       nickname: 'Sammy D',    cheer: '"LET\'S GO SAM" — short and loud.', likes: 'Base mileage, building back from offseason', dislikes: 'Taking days off', fun_facts: 'Building base this offseason; aiming for a fall breakout.' },
  { athlete_name: 'Casey Nguyen',    nickname: null,         cheer: 'A quiet thumbs-up means the world to Casey.', likes: 'Steady easy miles, sketchbook after practice', dislikes: 'Crowded start lines', fun_facts: 'Logs miles by hand in a paper journal.' },
  { athlete_name: 'Riley Foster',    nickname: 'Rils',       cheer: 'Ring a cowbell and shout the last name.', likes: 'Fartleks, golden-hour runs', dislikes: 'Wind on the back stretch', fun_facts: 'Knows every shortcut on the team\'s long-run loop.' },
  { athlete_name: 'Avery Park',      nickname: 'Ave',        cheer: '"AVE-RY, AVE-RY" with a clap between.', likes: 'The 800, fast finishes', dislikes: 'Long slow distance', fun_facts: 'Drops a wicked kick in the last 200m.' },
  { athlete_name: 'Quinn Hayes',     nickname: 'Q',          cheer: 'Just "Q!" — one letter, full volume.', likes: 'Mid-distance reps, team playlists', dislikes: 'Lane-1 traffic', fun_facts: 'DJs the bus rides to meets.' },
  { athlete_name: 'Drew Murphy',     nickname: 'Murph',      cheer: 'Yell "MURPH!" — he\'ll find another gear.', likes: 'The 1500, post-run smoothies', dislikes: 'False starts', fun_facts: 'Can do the entire race warmup with eyes closed.' },
  { athlete_name: 'Skyler Reyes',    nickname: 'Sky',        cheer: 'Point at the sky and shout the name.', likes: 'Coming back strong from the offseason', dislikes: 'Cold mornings', fun_facts: 'Rebuilding mileage this offseason after a great track season.' },
  { athlete_name: 'Morgan Wells',    nickname: 'Mo',         cheer: '"GO MO" works at any distance.', likes: 'The 200, blocks practice', dislikes: 'Distance day', fun_facts: 'Fastest reaction time on the team out of the blocks.' },
  { athlete_name: 'Reese Anderson',  nickname: null,         cheer: 'A loud "REESE!" at the 100m mark.', likes: 'Sprint relays, handoff drills', dislikes: 'Dropped batons', fun_facts: 'Anchors the 4×100.' },
  { athlete_name: 'Cameron Liu',     nickname: 'Cam',        cheer: '"CAM-ERON" — two claps, then go.', likes: 'The 400, the dreaded-but-loved one-lap', dislikes: 'The back half of the 400 (everyone does)', fun_facts: 'Calls the 400 "a sprint that lies to you."' },
  { athlete_name: 'Logan Bauer',     nickname: 'Bauer',      cheer: 'Last-name energy: "BAU-ER!"', likes: 'Short sprints, explosive starts', dislikes: 'Anything over 400m', fun_facts: 'Long jumps in the offseason for fun.' },
  { athlete_name: 'Parker Schultz',  nickname: 'Park',       cheer: 'Cheer loudest when the bar goes up.', likes: 'High jump, the approach run', dislikes: 'Windy runways', fun_facts: 'Field athlete — measures success in inches, not minutes.' },
  { athlete_name: 'Sage Martinez',   nickname: null,         cheer: 'A big "SAGE!" before the throw.', likes: 'Shot put, technique sessions', dislikes: 'Rainy ring conditions', fun_facts: 'Field athlete; keeps a tape measure in their bag at all times.' },
  { athlete_name: "Rowan O'Connor",  nickname: 'Ro',         cheer: 'Roll the R: "RRROWAN!"', likes: 'Offseason base, trail long runs', dislikes: 'Skipping the warmup', fun_facts: 'Building base this offseason; favorite run is the Saturday trail loop.' },
  { athlete_name: 'Emerson Carter',  nickname: 'Em',         cheer: 'Save your voice — Em\'s out this season but still cheers loudest.', likes: 'Cheering the team on, comeback plans', dislikes: 'Being sidelined', fun_facts: 'Currently inactive/recovering — team\'s unofficial hype captain.' },
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

// ── Bios ──────────────────────────────────────────────────────────────────
async function seedBios() {
  console.log(`\n[bios: ${BIOS.length} rows]`)
  const r = await sb('athlete_bios', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(BIOS),
  })
  if (!r.ok) console.error(`  FAIL: ${r.status} ${await r.text()}`)
  else console.log(`  ✓ ${BIOS.length} bios upserted`)
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Target: ${SUPABASE_URL}`)
  if (BIOS_ONLY) {
    console.log(`Will seed: ${BIOS.length} athlete bios only`)
    if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); return }
    await seedBios()
    console.log('\nDone.')
    return
  }
  console.log(`Will seed: ${ROSTER.length} athletes, ${PLAN_TEMPLATES.length} plans, 1 workout, ~${ROSTER.filter(r => !r.inactive).length * 12} mileage rows, ${BIOS.length} bios`)
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

  // ── Bios ──────────────────────────────────────────────────────────────────
  await seedBios()

  console.log('\n\nDone.')
}

main().catch(err => { console.error(err); process.exit(1) })
