// Course matching for XC leaderboards.
//
// Times are only comparable on the same physical course at the same distance,
// so leaderboards group results by a coach-defined "course". A course is matched
// at the RACE level — (meet, season, event) — because: meet names carry changing
// ordinals/years ("21st Farmer" vs "22nd Farmer"), the same course drifts in
// measured distance year to year, one meet can host several race distances
// (frosh vs varsity), and league meets rotate venues.
//
// These helpers produce *suggestions* the coach confirms/merges/splits; they're
// deliberately conservative (over-splitting is fine — merging is one click).

export type Race = { meet: string; season: string; event: string; count: number }

// Stable key for a race across the data (mirrors the scraper's slugging intent).
export function raceKey(meet: string, season: string, event: string): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `${slug(meet)}:${season}:${slug(event)}`
}

// Strip the year/ordinal noise that makes the same recurring meet look distinct.
//   "1st Annual Fighting Knights Joust" -> "fighting knights joust"
//   "45th Annual Asics Clovis Invitational" -> "asics clovis invitational"
//   "2025 CIF State Cross Country Championships" -> "cif state cross country championships"
export function normalizeMeetName(meet: string): string {
  let s = (meet || '').toLowerCase().trim()
  s = s.replace(/^\d{4}\s+/, '')              // leading year
  s = s.replace(/^\d+(?:st|nd|rd|th)\s+/, '') // leading ordinal
  s = s.replace(/\bannual\b/g, '')            // "annual"
  s = s.replace(/^\d+(?:st|nd|rd|th)\s+/, '') // ordinal that followed "annual"
  s = s.replace(/championships?$/, 'championship') // singular/plural drift
  return s.replace(/\s+/g, ' ').trim()
}

// Distance of an event label in miles. "5000 Meters" -> 3.107, "3 Miles" -> 3.
export function eventMiles(event: string): number | null {
  const e = (event || '').toLowerCase()
  let m = e.match(/([\d,.]+)\s*meters?/)
  if (m) return parseFloat(m[1].replace(/,/g, '')) / 1609.344
  m = e.match(/([\d.]+)\s*k\b/)
  if (m) return (parseFloat(m[1]) * 1000) / 1609.344
  m = e.match(/([\d.]+)\s*miles?/)
  if (m) return parseFloat(m[1])
  return null
}

// Bucket distance to the nearest half mile — coarse enough to group frosh races
// together and varsity races together, fine enough to keep them apart.
function distanceBucket(event: string): string {
  const mi = eventMiles(event)
  if (mi == null) return event.toLowerCase()
  return (Math.round(mi * 2) / 2).toFixed(1)
}

export type CourseSuggestion = {
  key: string            // normalized-name | distance-bucket
  label: string          // human label, e.g. "Farmer Invitational ~3.0mi"
  races: Race[]
  totalResults: number
}

// Group unassigned races into suggested courses by normalized meet name +
// distance bucket. Sorted by total results (biggest/most-used first).
export function suggestCourses(races: Race[]): CourseSuggestion[] {
  const groups = new Map<string, CourseSuggestion>()
  for (const r of races) {
    const norm = normalizeMeetName(r.meet)
    const bucket = distanceBucket(r.event)
    const key = `${norm} | ${bucket}`
    let g = groups.get(key)
    if (!g) {
      const titled = norm.replace(/\b\w/g, c => c.toUpperCase())
      g = { key, label: `${titled} ~${bucket}mi`, races: [], totalResults: 0 }
      groups.set(key, g)
    }
    g.races.push(r)
    g.totalResults += r.count
  }
  return [...groups.values()].sort((a, b) => b.totalResults - a.totalResults)
}
