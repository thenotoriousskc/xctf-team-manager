import type { AthleticNetPR } from './types.ts'

// Jack Daniels' VDOT formula
// Reference: "Daniels' Running Formula" 3rd ed.

export function parseTimeSecs(mark: string): number | null {
  const parts = mark.trim().split(':')
  if (parts.length === 2) {
    const mins = parseFloat(parts[0])
    const secs = parseFloat(parts[1])
    if (isNaN(mins) || isNaN(secs)) return null
    return mins * 60 + secs
  }
  if (parts.length === 1) {
    const secs = parseFloat(parts[0])
    return isNaN(secs) ? null : secs
  }
  return null
}

function eventMeters(event: string): number | null {
  if (/relay/i.test(event)) return null
  const e = event.toLowerCase()
  if (e.includes('800')) return 800
  if (e.includes('1600')) return 1600
  if (e.includes('1 mile') || e.match(/\bmile\b/)) return 1609.34
  if (e.includes('3200') || e.includes('2 mile')) return 3218.69
  if (e.includes('3000') && !e.includes('steeplechase')) return 3000
  if (e.includes('5000') || e.includes('5k')) return 5000
  if (e.includes('10000') || e.includes('10k')) return 10000
  return null
}

function vdotFromRace(meters: number, secs: number): number {
  const t = secs / 60 // minutes
  const v = meters / t // m/min
  const pct = 0.8 + 0.1894393 * Math.exp(-0.012778 * t) + 0.2989558 * Math.exp(-0.1932605 * t)
  const vo2 = -4.60 + 0.182258 * v + 0.000104 * v * v
  return vo2 / pct
}

// Solve for velocity (m/min) at a given %VO2max intensity
function velocityAtIntensity(vdot: number, intensity: number): number {
  const vo2Target = vdot * intensity
  // Quadratic from VO2 = -4.60 + 0.182258*v + 0.000104*v^2
  const a = 0.000104, b = 0.182258, c = -(vo2Target + 4.60)
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a)
}

function secsPerMile(vMetersPerMin: number): number {
  return (1 / vMetersPerMin) * 60 * 1609.34
}

function secsPerKm(vMetersPerMin: number): number {
  return (1 / vMetersPerMin) * 60 * 1000
}

function formatPace(totalSecs: number): string {
  const mins = Math.floor(totalSecs / 60)
  const secs = Math.round(totalSecs % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export interface TrainingPaces {
  vdot: number
  sourcePR: AthleticNetPR
  easyFast: string; easyFastKm: string
  easySlow: string; easySlowKm: string
  marathon: string; marathonKm: string
  threshold: string; thresholdKm: string
  tenK: string; tenKKm: string
  fiveK: string; fiveKKm: string
}

// Tempo intensity anchors (duration → %VO2max), derived from Norwegian sub-threshold model.
// At 4 min = JD threshold (88%); longer intervals run progressively slower.
const TEMPO_ANCHORS: [number, number][] = [
  [4, 0.880],
  [6, 0.862],
  [8, 0.832],
  [12, 0.808],
]

export function computeTempoPace(vdot: number, durationMins: number): { mile: string; km: string } {
  const t = Math.max(4, durationMins)
  const anchors = TEMPO_ANCHORS
  let intensity: number
  if (t <= anchors[0][0]) {
    intensity = anchors[0][1]
  } else if (t >= anchors[anchors.length - 1][0]) {
    intensity = anchors[anchors.length - 1][1]
  } else {
    intensity = anchors[0][1]
    for (let i = 0; i < anchors.length - 1; i++) {
      const [t0, i0] = anchors[i]
      const [t1, i1] = anchors[i + 1]
      if (t >= t0 && t <= t1) {
        intensity = i0 + ((t - t0) / (t1 - t0)) * (i1 - i0)
        break
      }
    }
  }
  const v = velocityAtIntensity(vdot, intensity)
  return { mile: formatPace(secsPerMile(v)), km: formatPace(secsPerKm(v)) }
}

// Compute the standard training paces for a given VDOT. Source-PR-aware
// callers (e.g. computeTrainingPaces) can pass sourcePR for display; manual
// overrides (e.g. coach typed a VDOT into the roster) pass null.
export function pacesFromVdot(vdot: number, sourcePR: AthleticNetPR | null = null): TrainingPaces {
  const easyFastV  = velocityAtIntensity(vdot, 0.65)
  const easySlowV  = velocityAtIntensity(vdot, 0.59)
  const marathonV  = velocityAtIntensity(vdot, 0.80)
  const thresholdV = velocityAtIntensity(vdot, 0.88)
  const tenKV      = velocityAtIntensity(vdot, 0.92)
  const fiveKV     = velocityAtIntensity(vdot, 0.98)
  return {
    vdot: Math.round(vdot * 10) / 10,
    sourcePR: sourcePR ?? { event: 'manual', mark: '' },
    easyFast:     formatPace(secsPerMile(easyFastV)),
    easyFastKm:   formatPace(secsPerKm(easyFastV)),
    easySlow:     formatPace(secsPerMile(easySlowV)),
    easySlowKm:   formatPace(secsPerKm(easySlowV)),
    marathon:     formatPace(secsPerMile(marathonV)),
    marathonKm:   formatPace(secsPerKm(marathonV)),
    threshold:    formatPace(secsPerMile(thresholdV)),
    thresholdKm:  formatPace(secsPerKm(thresholdV)),
    tenK:         formatPace(secsPerMile(tenKV)),
    tenKKm:       formatPace(secsPerKm(tenKV)),
    fiveK:        formatPace(secsPerMile(fiveKV)),
    fiveKKm:      formatPace(secsPerKm(fiveKV)),
  }
}

export function computeTrainingPaces(prs: AthleticNetPR[]): TrainingPaces | null {
  let bestVdot = -Infinity
  let sourcePR: AthleticNetPR | null = null

  for (const pr of prs) {
    const meters = eventMeters(pr.event)
    if (!meters) continue
    const secs = parseTimeSecs(pr.mark)
    if (!secs || secs <= 0) continue
    // Only use track events between 800m and 10k for VDOT (most reliable)
    if (meters < 800 || meters > 10000) continue
    const v = vdotFromRace(meters, secs)
    if (v > bestVdot) {
      bestVdot = v
      sourcePR = pr
    }
  }

  if (!sourcePR || bestVdot <= 0) return null

  // Apply 15% penalty for short events (800m and under) — more anaerobic, inflates aerobic VDOT
  const sourceMeters = eventMeters(sourcePR.event) ?? Infinity
  const adjustedVdot = sourceMeters <= 800 ? bestVdot * 0.90 : bestVdot

  return pacesFromVdot(adjustedVdot, sourcePR)
}

// Roster VDOT override beats PR-derived calculation. Returns null only when
// neither is available (no override AND no usable PRs).
export function effectivePaces(
  rosterVdot: number | null | undefined,
  prs: AthleticNetPR[]
): TrainingPaces | null {
  if (rosterVdot != null && rosterVdot > 0) return pacesFromVdot(rosterVdot)
  return computeTrainingPaces(prs)
}
