// Local-only: scrape your Strava home feed (followers' activities) and
// upsert running activities for roster athletes into strava_activities.
//
// Setup (one-time):
//   1. Log in to strava.com in a browser.
//   2. DevTools → Application → Cookies → strava.com → copy value of `_strava4_session`.
//   3. Visit your profile; the URL contains your numeric athlete id: /athletes/<ID>.
//   4. Add to .env.local:
//        STRAVA_SESSION_COOKIE=<the _strava4_session value>
//        STRAVA_MY_ATHLETE_ID=<your numeric athlete id>
//
// Usage:
//   node scripts/scrape-strava-feed.mjs            # scrape last 30 days
//   node scripts/scrape-strava-feed.mjs 14         # scrape last 14 days
//   node scripts/scrape-strava-feed.mjs --inspect  # dump first page to strava-feed-page1.json and exit
//   node scripts/scrape-strava-feed.mjs --reset    # ignore saved cursor; start from the top
//
// Resumable: the script writes `.strava-feed-state.json` after every page (and
// on throttle exits). Re-running within 24h continues from where it left off,
// which avoids re-burning page 1 and lets you fill in deeper history across
// multiple runs without tripping Strava's rate limit.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'

// ── Load env ──────────────────────────────────────────────────────────────────
const env = {}
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const i = line.indexOf('=')
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
}

const SUPABASE_URL = env.SUPABASE_URL
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
const COOKIE = env.STRAVA_SESSION_COOKIE
const ATHLETE_ID = env.STRAVA_MY_ATHLETE_ID

for (const [k, v] of Object.entries({ SUPABASE_URL, SERVICE_KEY, COOKIE, ATHLETE_ID })) {
  if (!v) { console.error(`Missing ${k} in .env.local`); process.exit(1) }
}

const args = process.argv.slice(2)
const INSPECT = args.includes('--inspect')
const RESET = args.includes('--reset')
const DAYS = parseInt(args.find(a => /^\d+$/.test(a)) || '30', 10)

const STATE_FILE = '.strava-feed-state.json'
function readState() {
  if (RESET || !existsSync(STATE_FILE)) return null
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    const ageMs = Date.now() - new Date(s.savedAt).getTime()
    if (ageMs > 24 * 3600_000) return null
    return s
  } catch { return null }
}
function writeState(before, cursor, note) {
  writeFileSync(STATE_FILE, JSON.stringify({ before, cursor, savedAt: new Date().toISOString(), note }, null, 2))
}
function clearState() { try { unlinkSync(STATE_FILE) } catch {} }

// ── Human-ish browser simulation ──────────────────────────────────────────────
// Strava can rate-limit or flag scraping. To behave like a real browser:
//  - Send a realistic Chrome-on-macOS UA + Sec-Fetch-* + Accept-Language
//  - Warm up by GETting the dashboard HTML once, like a user opening the page
//  - Pause 1.5–3.5s between feed pages (matches infinite-scroll cadence)
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

const browserHeaders = (extra = {}) => ({
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Cookie: `_strava4_session=${COOKIE}`,
  ...extra,
})

const sleep = ms => new Promise(r => setTimeout(r, ms))
const jitter = (minMs, maxMs) => sleep(minMs + Math.random() * (maxMs - minMs))

let warmedUp = false
async function warmUp() {
  if (warmedUp) return
  warmedUp = true
  const r = await fetch('https://www.strava.com/dashboard', {
    headers: browserHeaders({
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    }),
  })
  if (r.status === 401 || r.status === 403) {
    throw new Error(`Strava dashboard returned ${r.status} — session cookie likely expired.`)
  }
  // Drain body so the connection cleanly closes; small think-pause like a real reader.
  await r.text().catch(() => '')
  await jitter(800, 1800)
}

// ── Strava feed fetch ─────────────────────────────────────────────────────────
// Returns { entries: [...], pagination: { hasMore } }
// Pagination requires BOTH:
//   before: cursorData.updated_at (seconds) of the last entry on prior page
//   cursor: cursorData.rank (milliseconds) of the last entry on prior page
async function fetchFeedPage(before, cursor) {
  await warmUp()

  const params = new URLSearchParams({
    feed_type: 'following',
    athlete_id: ATHLETE_ID,
    num_entries: '30',
  })
  if (before != null) params.set('before', String(before))
  if (cursor != null) params.set('cursor', String(cursor))

  const r = await fetch(`https://www.strava.com/dashboard/feed?${params}`, {
    headers: browserHeaders({
      Accept: 'text/javascript, application/javascript, application/json, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: 'https://www.strava.com/dashboard',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
    }),
  })

  if (r.status === 401 || r.status === 403) {
    throw new Error(`Strava ${r.status} — session cookie likely expired. Refresh _strava4_session in .env.local.`)
  }
  if (r.status === 429) {
    throw new Error('Strava 429 — rate limited. Stop, wait several minutes, and run with fewer pages.')
  }
  if (!r.ok) throw new Error(`Strava feed ${r.status}: ${(await r.text()).slice(0, 300)}`)

  const text = await r.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    writeFileSync('strava-feed-raw.html', text)
    throw new Error('Feed response was not JSON (raw saved to strava-feed-raw.html). Likely you got an HTML login page — cookie may be wrong.')
  }
  if (!data || !Array.isArray(data.entries)) {
    throw new Error(`Unexpected feed shape: top-level keys = ${Object.keys(data ?? {}).join(',')}`)
  }
  return data
}

// ── Inspect mode: dump first page and exit ────────────────────────────────────
if (INSPECT) {
  const data = await fetchFeedPage(null)
  writeFileSync('strava-feed-page1.json', JSON.stringify(data, null, 2))
  const counts = {}
  for (const e of data.entries) counts[e.entity] = (counts[e.entity] ?? 0) + 1
  console.log(`Wrote strava-feed-page1.json — ${data.entries.length} entries (${JSON.stringify(counts)}); hasMore=${data.pagination?.hasMore}`)
  process.exit(0)
}

const sinceMs = Date.now() - DAYS * 86400_000
console.log(`Scraping back to ${new Date(sinceMs).toISOString().slice(0, 10)} (${DAYS} days)`)

// ── Roster lookup ─────────────────────────────────────────────────────────────
async function fetchRoster() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/roster?select=name`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })
  if (!r.ok) throw new Error(`roster fetch ${r.status}: ${await r.text()}`)
  return r.json()
}

const norm = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

// ── Activity normalization ────────────────────────────────────────────────────
// The Strava feed mixes two shapes:
//   - entity=Activity (camelCase: athlete.athleteId, id, startDate, activityName)
//   - entity=GroupActivity child (snake_case: athlete_id, activity_id, start_date, name)
// Normalize to a single shape before parsing.
function normalizeFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return []
  if (entry.entity === 'Activity' && entry.activity) {
    const a = entry.activity
    const ath = a.athlete ?? {}
    return [{
      id: a.id,
      type: a.type,
      name: a.activityName ?? '',
      startIso: a.startDate ?? null,
      startLocalIso: null,
      athleteId: ath.athleteId ? String(ath.athleteId) : '',
      athleteName: ath.athleteName ?? '',
      stats: a.stats,
    }]
  }
  if (entry.entity === 'GroupActivity') {
    const subs = entry.rowData?.activities ?? []
    return subs.map(a => ({
      id: a.activity_id,
      type: a.type,
      name: a.name ?? '',
      startIso: a.start_date ?? null,
      startLocalIso: a.start_date_local ?? null,
      athleteId: a.athlete_id ? String(a.athlete_id) : '',
      athleteName: a.athlete_name ?? '',
      stats: a.stats,
    }))
  }
  return []
}

const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun', 'Treadmill'])

// Stats are pairs: { key: 'stat_one', value: '<html>' } and { key: 'stat_one_subtitle', value: 'Distance' }.
// Build a map subtitle → cleaned value text, then pull out whichever stats we need.
function statsMap(stats) {
  const out = {}
  if (!Array.isArray(stats)) return out
  for (const s of stats) {
    if (typeof s.key !== 'string' || !s.key.endsWith('_subtitle')) continue
    const subtitle = String(s.value ?? '').trim().toLowerCase()
    const valKey = s.key.replace('_subtitle', '')
    const valStat = stats.find(x => x.key === valKey)
    if (!valStat) continue
    const text = String(valStat.value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    out[subtitle] = text
  }
  return out
}

function parseDistanceMeters(text) {
  if (!text) return null
  const m = String(text).match(/([\d,.]+)\s*(mi|km|m)\b/i)
  if (!m) return null
  const n = parseFloat(m[1].replace(/,/g, ''))
  if (!isFinite(n)) return null
  const u = m[2].toLowerCase()
  if (u === 'mi') return n * 1609.344
  if (u === 'km') return n * 1000
  return n
}

// Strava time strings: "30m 45s", "1h 22m", "1h 22m 5s", "45s".
function parseDurationSecs(text) {
  if (!text) return null
  let total = 0
  let found = false
  const re = /(\d+)\s*(h|m|s)\b/gi
  let m
  while ((m = re.exec(text))) {
    const n = parseFloat(m[1])
    if (!isFinite(n)) continue
    const u = m[2].toLowerCase()
    if (u === 'h') total += n * 3600
    else if (u === 'm') total += n * 60
    else if (u === 's') total += n
    found = true
  }
  return found ? Math.round(total) : null
}

// Pace strings: "10:58 /mi" or "6:30 /km". Returns mile-equivalent secs/mi.
function paceTextToSecsPerMile(text) {
  if (!text) return null
  const m = String(text).match(/(\d+):(\d{2})\s*\/?(mi|km)?\b/i)
  if (!m) return null
  const secs = parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
  const unit = (m[3] ?? 'mi').toLowerCase()
  return unit === 'km' ? secs * 1.609344 : secs
}

// Format a Date as YYYY-MM-DD in the team's local timezone (Pacific).
// Strava feed Activity entries only give UTC `startDate`; a 7pm Pacific run is
// next-day UTC, so we must convert before slicing the date.
const TEAM_TZ = 'America/Los_Angeles'
const LOCAL_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TEAM_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
function localDate(d) {
  return LOCAL_DATE_FMT.format(d) // en-CA → "YYYY-MM-DD"
}

function buildRecord(a, rosterIndex) {
  if (!a || !RUN_TYPES.has(a.type)) return { skip: 'not-run' }

  const fullName = String(a.athleteName ?? '').trim()
  if (!fullName) return { skip: 'no-name' }
  if (!rosterIndex.has(norm(fullName))) return { skip: `not-on-roster:${fullName}` }

  const sm = statsMap(a.stats)
  const distM = parseDistanceMeters(sm['distance'])
  if (!distM || distM <= 0) return { skip: 'no-distance' }

  // Time can be missing on group activities. Derive it from distance/pace if
  // we have a pace stat — gives us a value even without an explicit time.
  let movingSecs = parseDurationSecs(sm['time'] ?? sm['moving time'])
  if (movingSecs == null) {
    const secsPerMile = paceTextToSecsPerMile(sm['pace'])
    if (secsPerMile != null) movingSecs = Math.round((distM / 1609.344) * secsPerMile)
  }

  const startRaw = a.startIso ?? a.startLocalIso
  if (!startRaw) return { skip: 'no-date' }
  const startMs = +new Date(startRaw)
  if (!isFinite(startMs)) return { skip: 'bad-date' }

  if (!a.id) return { skip: 'no-id' }

  const parts = fullName.split(/\s+/)
  const firstname = parts[0] ?? ''
  const lastname = parts.slice(1).join(' ')
  // Prefer Strava's own start_date_local when present (GroupActivity children have it,
  // already TZ-correct for the athlete). Otherwise convert UTC startIso to Pacific.
  const dateOnly = a.startLocalIso ? a.startLocalIso.slice(0, 10) : localDate(new Date(startMs))

  return {
    startMs,
    record: {
      strava_id: String(a.id),
      athlete_strava_id: a.athleteId || 'feed',
      athlete_firstname: firstname,
      athlete_lastname: lastname,
      name: a.name ?? '',
      sport_type: a.type,
      start_date: new Date(startMs).toISOString(),
      start_date_local: `${dateOnly}T12:00:00`,
      distance_meters: distM,
      // moving_time captures the actual running time. average_speed lets the
      // UI render pace without re-parsing the feed string. elapsed_time isn't
      // surfaced by the feed; default to moving_time so any "pace from elapsed"
      // calculations don't divide by zero.
      moving_time: movingSecs ?? 0,
      elapsed_time: movingSecs ?? 0,
      average_speed: movingSecs && movingSecs > 0 ? distM / movingSecs : null,
    },
  }
}

// ── Upsert ────────────────────────────────────────────────────────────────────
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
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`)
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const roster = await fetchRoster()
  const rosterIndex = new Map(roster.map(r => [norm(r.name), r]))
  console.log(`Roster: ${roster.length} athletes`)

  const collected = []
  const skips = {}
  const seenIds = new Set()
  const resume = readState()
  let before = resume?.before ?? null
  let cursor = resume?.cursor ?? null
  if (resume) {
    const ageMin = Math.round((Date.now() - new Date(resume.savedAt).getTime()) / 60000)
    console.log(`Resuming from saved cursor before=${before} cursor=${cursor} (saved ${ageMin}min ago, ${resume.note ?? ''}). Pass --reset to start fresh.`)
  }

  const MAX_PAGES = 20
  let throttled = false
  for (let page = 1; page <= MAX_PAGES; page++) {
    let data
    try {
      data = await fetchFeedPage(before, cursor)
    } catch (err) {
      console.error(`Page ${page} failed: ${err.message}`)
      // Persist cursor on throttle so a later re-run continues here
      if (before != null && cursor != null) {
        writeState(before, cursor, `throttled at page ${page}: ${err.message.slice(0, 80)}`)
        console.log(`Saved cursor to ${STATE_FILE}. Re-run later to continue.`)
        throttled = true
      }
      break
    }
    const entries = data.entries
    if (entries.length === 0) {
      console.log(`Page ${page}: empty — done.`)
      break
    }

    let oldestStartMs = null
    let oldestUpdatedAt = null
    let oldestRank = null
    let activities = 0
    let newKept = 0
    // Track the very last entry's cursor — that's what Strava's web client passes
    // as `before` and `cursor` for the next page.
    const lastEntry = entries[entries.length - 1]
    const lastUpdatedAt = lastEntry?.cursorData?.updated_at ?? null
    const lastRank = lastEntry?.cursorData?.rank ?? null
    for (const entry of entries) {
      const u = entry.cursorData?.updated_at
      const r = entry.cursorData?.rank
      if (typeof u === 'number') oldestUpdatedAt = oldestUpdatedAt == null ? u : Math.min(oldestUpdatedAt, u)
      if (typeof r === 'number') oldestRank = oldestRank == null ? r : Math.min(oldestRank, r)
      for (const a of normalizeFromEntry(entry)) {
        activities++
        const startRaw = a.startIso ?? a.startLocalIso
        if (startRaw) {
          const t = +new Date(startRaw)
          if (isFinite(t)) oldestStartMs = oldestStartMs == null ? t : Math.min(oldestStartMs, t)
        }
        const out = buildRecord(a, rosterIndex)
        if (out.skip) {
          const tag = out.skip.startsWith('not-on-roster:') ? 'not-on-roster' : out.skip
          skips[tag] = (skips[tag] ?? 0) + 1
          continue
        }
        if (seenIds.has(out.record.strava_id)) continue
        seenIds.add(out.record.strava_id)
        collected.push(out.record)
        newKept++
      }
    }

    console.log(`  Page ${page}: ${entries.length} entries, ${activities} activities, +${newKept} new (total ${collected.length}), oldest=${oldestStartMs ? new Date(oldestStartMs).toISOString().slice(0, 10) : '?'}`)

    if (data.pagination?.hasMore === false) {
      console.log('  Strava reports no more pages — done.')
      clearState()
      break
    }
    if (oldestStartMs != null && oldestStartMs < sinceMs) {
      console.log(`  Reached cutoff (${new Date(oldestStartMs).toISOString().slice(0, 10)}).`)
      clearState()
      break
    }
    // Pagination: pass the LAST entry's cursorData (updated_at as `before`, rank as `cursor`).
    // Falling back to the page's oldest pair if the last entry is missing cursorData.
    const nextBefore = lastUpdatedAt ?? oldestUpdatedAt
    const nextCursor = lastRank ?? oldestRank
    if (nextBefore == null || nextCursor == null) {
      console.log('  No cursor data on entries — stopping (parser may be out of date).')
      break
    }
    // Guarantee monotonic progress — if Strava returned the same cursor again, bail.
    if (cursor != null && nextCursor >= cursor) {
      console.log('  Cursor did not advance — Strava likely refused to paginate further.')
      break
    }
    before = nextBefore
    cursor = nextCursor
    writeState(before, cursor, `page ${page} ok`)
    // Pause 5–10s between pages — Strava throttles fast even when headers look human.
    await jitter(5000, 10000)
  }
  void throttled

  console.log(`\nCollected ${collected.length} records. Skips: ${JSON.stringify(skips)}`)
  if (collected.length === 0) return

  const BATCH = 200
  for (let i = 0; i < collected.length; i += BATCH) {
    await upsertBatch(collected.slice(i, i + BATCH))
    process.stdout.write(`\rUpserted ${Math.min(i + BATCH, collected.length)}/${collected.length}`)
  }
  console.log('\nDone.')
}

main().catch(err => { console.error(err); process.exit(1) })
