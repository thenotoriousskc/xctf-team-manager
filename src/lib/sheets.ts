import Papa from 'papaparse'
import { sheetCsvUrl, WORKOUT_GID, ROSTER_GID } from '../config.ts'
import type { WorkoutRow, RosterEntry, SheetData, PublishStatus } from './types.ts'

function fetchCsv(gid: string): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    Papa.parse<string[]>(sheetCsvUrl(gid), {
      download: true,
      skipEmptyLines: true,
      complete(results) {
        resolve(results.data)
      },
      error(err: Error) {
        reject(err)
      },
    })
  })
}

function parseWorkoutTab(rows: string[][]): {
  preRunRoutine: string
  postRunRoutine: string
  videoLabel: string
  videoUrl: string
  workoutRows: WorkoutRow[]
  publishStatus: PublishStatus
} {
  // Row 0 (row 1 in sheet) = pre-run routine in cols B-F (indices 1-5)
  const preRunRoutine = rows[0]?.slice(1, 6).filter(c => c.trim()).join(' | ').trim() ?? ''
  // Row 1 (row 2 in sheet) = post-run routine in cols B-F
  const postRunRoutine = rows[1]?.slice(1, 6).filter(c => c.trim()).join(' | ').trim() ?? ''

  // G1 (row 0, col 6) = publish status, H1 = video label, I1 = video URL
  const pubVal = (rows[0]?.[6] ?? '').trim().toUpperCase()
  const publishStatus: PublishStatus = pubVal === 'UPDATING' ? 'UPDATING' : 'PUBLISH'
  const videoLabel = (rows[0]?.[7] ?? '').trim()
  const videoUrl = (rows[0]?.[8] ?? '').trim()

  // Row 3+ (row 4+ in sheet) = workout data
  // Row 2 (row 3) is headers, skip it
  const workoutRows: WorkoutRow[] = []
  for (let i = 3; i < rows.length; i++) {
    const row = rows[i]
    if (!row || row.length < 2) continue
    // Columns: Athletes | Coach | Focus | Workout | Pace/Effort | Notes
    const athletesRaw = row[0] ?? ''
    if (!athletesRaw.trim()) continue
    workoutRows.push({
      athletesRaw: athletesRaw.trim(),
      coach: (row[1] ?? '').trim(),
      focus: (row[2] ?? '').trim(),
      warmup: '',
      workout: (row[3] ?? '').trim(),
      cooldown: '',
      paceEffort: (row[4] ?? '').trim(),
      notes: (row[5] ?? '').trim(),
      segments: [],
    })
  }
  return { preRunRoutine, postRunRoutine, videoLabel, videoUrl, workoutRows, publishStatus }
}

function parseRosterTab(rows: string[][]): RosterEntry[] {
  // Row 0 is headers: Name | Group | Current Week | Target | Note | Checkout | AthleticNetID
  const headers = (rows[0] ?? []).map(h => h.trim().toLowerCase())
  const athleticNetCol = headers.findIndex(h => h.includes('athletic') || h === 'athleticnetid')

  const entries: RosterEntry[] = []
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row || !row[0]?.trim()) continue
    entries.push({
      name: (row[0] ?? '').trim(),
      group: (row[1] ?? '').trim(),
      target: (row[3] ?? '').trim(),
      note: (row[4] ?? '').trim(),
      checkout: (row[5] ?? '').trim(),
      athleticNetId: athleticNetCol >= 0 ? (row[athleticNetCol] ?? '').trim() || undefined : undefined,
    })
  }
  return entries
}

export async function fetchSheetData(): Promise<SheetData> {
  const [workoutRows, rosterRows] = await Promise.all([
    fetchCsv(WORKOUT_GID),
    fetchCsv(ROSTER_GID),
  ])

  const { preRunRoutine, postRunRoutine, videoLabel, videoUrl, workoutRows: workouts, publishStatus } = parseWorkoutTab(workoutRows)
  const roster = parseRosterTab(rosterRows)

  return { preRunRoutine, postRunRoutine, videoLabel, videoUrl, workoutRows: workouts, roster, planTemplates: [], publishStatus, stravaConnected: false, timezone: 'America/Los_Angeles', coaches: [] }
}

export function findWorkoutForAthlete(
  name: string,
  workoutRows: WorkoutRow[],
): WorkoutRow | null {
  const lower = name.toLowerCase()
  for (const row of workoutRows) {
    if (row.athletesRaw.toLowerCase().includes(lower)) {
      return row
    }
  }
  return null
}

export function findGroupMates(
  name: string,
  row: WorkoutRow,
  roster: RosterEntry[],
): string[] {
  // Find all roster names that appear in this row's athletes string
  const rawLower = row.athletesRaw.toLowerCase()
  return roster
    .filter(r => r.name.toLowerCase() !== name.toLowerCase() && rawLower.includes(r.name.toLowerCase()))
    .map(r => r.name)
}

export function findRosterEntry(
  name: string,
  roster: RosterEntry[],
): RosterEntry | null {
  const lower = name.toLowerCase()
  return roster.find(r => r.name.toLowerCase() === lower) ?? null
}

// Sentinel focus value — coach views detect this to render the offseason
// group with its own styling.
export const OFFSEASON_FOCUS = 'Offseason'

// Build a synthetic workout row containing every offseason roster member who
// is NOT already assigned to a real workout. Returns null if nobody qualifies.
// Coach views append this row at the bottom; the athlete view falls back to
// OffseasonCard only when no real workout matches, so a coach assignment
// always wins.
export function buildOffseasonWorkoutRow(
  roster: RosterEntry[],
  realWorkoutRows: WorkoutRow[],
): WorkoutRow | null {
  const assignedLower = new Set<string>()
  for (const row of realWorkoutRows) {
    for (const r of roster) {
      if (row.athletesRaw.toLowerCase().includes(r.name.toLowerCase())) {
        assignedLower.add(r.name.toLowerCase())
      }
    }
  }
  const offseasonNames = roster
    .filter(r => r.offseason && !r.inactive && r.name.trim() && !assignedLower.has(r.name.toLowerCase()))
    .map(r => r.name)
  if (offseasonNames.length === 0) return null
  return {
    athletesRaw: offseasonNames.join('\n'),
    coach: '',
    focus: OFFSEASON_FOCUS,
    warmup: '',
    workout: 'Build base mileage — see your weekly target.',
    cooldown: '',
    paceEffort: 'Easy / conversational',
    notes: '',
    segments: [],
  }
}
