// Build a fake public/prs.json matching the demo roster names so VDOT
// calculations on the athlete cards have data to work with.
//
// Run: node seeds/generate-demo-prs.mjs > public/prs.json
//
// Each athlete gets 2–4 events scaled to their VDOT (faster VDOT → faster
// marks). Marks are deterministic given the same input so the output is
// stable across runs (useful for git diffs).

// Mirror of ROSTER from seed-demo.mjs (kept in sync by hand).
const ATHLETES = [
  { name: 'Alex Chen',        vdot: 56.0 },
  { name: 'Jordan Kim',       vdot: 52.5 },
  { name: 'Maya Patel',       vdot: 49.2 },
  { name: 'Taylor Brooks',    vdot: 58.7 },
  { name: 'Jamie Rivera',     vdot: 48.8 },
  { name: 'Sam Davis',        vdot: 54.3 },
  { name: 'Casey Nguyen',     vdot: 45.1 },
  { name: 'Riley Foster',     vdot: 51.6 },
  { name: 'Avery Park',       vdot: 47.2 },
  { name: 'Quinn Hayes',      vdot: 50.4 },
  { name: 'Drew Murphy',      vdot: 46.8 },
  { name: 'Skyler Reyes',     vdot: 43.5 },
  { name: 'Morgan Wells',     vdot: 42.0 },
  { name: 'Reese Anderson',   vdot: 40.5 },
  { name: 'Cameron Liu',      vdot: 41.8 },
  { name: 'Logan Bauer',      vdot: 39.7 },
  { name: 'Rowan O\'Connor',  vdot: 48.0 },
  { name: 'Emerson Carter',   vdot: 51.0 },
]

// Daniels' VDOT → race time mapping, anchored to published values and linearly
// interpolated between. Solving the VO2 = vdot × intensity formula directly
// doesn't reproduce the published tables (Daniels' intensity model is for
// training paces, not racing); these anchors come straight from the official
// "Daniels' Running Formula" 3rd ed. tables.
const VDOT_ANCHORS = [
  // [VDOT, 800s, 1600s, 3200s, 5000s, 400s]
  [30, 210, 480, 1015, 1655, 95],
  [40, 168, 388,  814, 1310, 76],
  [50, 143, 330,  691, 1116, 64],
  [55, 134, 309,  648, 1045, 61],
  [60, 126, 291,  611,  985, 57],
  [65, 119, 276,  579,  934, 54],
  [70, 113, 263,  551,  889, 51],
]
const EVENT_COL = { 800: 1, 1600: 2, 3200: 3, 5000: 4, 400: 5 }

function paceTimeSecs(vdot, meters) {
  // Pick the canonical column key for this distance.
  let key
  if (meters <= 400) key = 400
  else if (meters <= 800) key = 800
  else if (meters <= 1600) key = 1600
  else if (meters <= 3218.69) key = 3200
  else key = 5000
  const col = EVENT_COL[key]
  // Find bracketing anchors
  let lo = VDOT_ANCHORS[0], hi = VDOT_ANCHORS[VDOT_ANCHORS.length - 1]
  for (let i = 0; i < VDOT_ANCHORS.length - 1; i++) {
    if (vdot >= VDOT_ANCHORS[i][0] && vdot <= VDOT_ANCHORS[i + 1][0]) {
      lo = VDOT_ANCHORS[i]
      hi = VDOT_ANCHORS[i + 1]
      break
    }
  }
  if (vdot <= lo[0]) return lo[col]
  if (vdot >= hi[0]) return hi[col]
  const t = (vdot - lo[0]) / (hi[0] - lo[0])
  return lo[col] + t * (hi[col] - lo[col])
}

function formatSecs(secs, withColon = true) {
  if (secs < 60) return secs.toFixed(2)
  const m = Math.floor(secs / 60)
  const s = (secs - m * 60).toFixed(2).padStart(5, '0') // "08.34"
  return withColon ? `${m}:${s}` : `${(m * 60 + parseFloat(s)).toFixed(2)}`
}

// Each athlete gets a few events. Pick by VDOT band so distance runners
// favor 1600/3200/5k and shorter runners pick 800/1600.
function eventsFor(vdot) {
  if (vdot >= 50) return [
    { event: '1600 Meters', meters: 1600 },
    { event: '3200 Meters', meters: 3218.69 },
    { event: '800 Meters',  meters: 800 },
  ]
  if (vdot >= 45) return [
    { event: '1600 Meters', meters: 1600 },
    { event: '800 Meters',  meters: 800 },
  ]
  return [
    { event: '800 Meters', meters: 800 },
    { event: '400 Meters', meters: 400 },
  ]
}

const out = {}
let id = 100000000
for (const a of ATHLETES) {
  const athleteId = String(id++)
  const prs = []
  const history = []
  for (const ev of eventsFor(a.vdot)) {
    const secs = paceTimeSecs(a.vdot, ev.meters)
    const mark = ev.meters === 400 ? formatSecs(secs, false) : formatSecs(secs)
    const pr = { event: ev.event, mark, date: 'Apr 15, 2026', meet: 'Demo Spring Invitational' }
    prs.push(pr)
    history.push({ ...pr, is_pb: true })
    // Add one non-PB earlier in the season (~4% slower)
    const olderSecs = secs * 1.04
    const olderMark = ev.meters === 400 ? formatSecs(olderSecs, false) : formatSecs(olderSecs)
    history.push({ event: ev.event, mark: olderMark, date: 'Mar 10, 2026', meet: 'Demo Early Season', is_pb: false })
  }
  out[athleteId] = { name: a.name, prs, history, seasons: ['2026 Outdoor', '2025 Outdoor'] }
}

console.log(JSON.stringify(out, null, 2))
