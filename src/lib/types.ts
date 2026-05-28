export type RestType = 'easy' | 'float' | 'walk' | 'stand' | 'jog' | 'full recovery'
export type PaceType = 'easy' | '5k' | '3200' | '1600' | '800' | '400' | 'tempo' | 'threshold' | 'fast and relaxed' | '95% effort'
export type DistanceUnit = 'meters' | 'miles' | 'minutes'

export interface WorkoutSegment {
  id: string
  qty: string
  distance: string
  unit: DistanceUnit
  pace: PaceType
  restDuration: string
  rest: RestType
}

export interface WorkoutRow {
  athletesRaw: string
  coach: string
  focus: string
  warmup: string
  workout: string
  cooldown: string
  paceEffort: string
  notes: string
  segments: WorkoutSegment[]
}

export interface RosterEntry {
  name: string
  group: string
  target: string
  note: string
  checkout: string
  athleticNetId?: string
  lastLoginAt?: string | null
  lastStravaAt?: string | null
  inactive?: boolean
  bioEdit?: boolean
  offseason?: boolean
  manualMileage?: boolean
  email?: string | null
  vdot?: number | null
  planTemplateId?: string | null
}

// ─── Offseason weekly plan templates ────────────────────────────────────────
// A library of reusable weekly plans (e.g. "20A: 20 miles per week with 2x5
// tempos"). Each template has 7 days; cells render with two lines:
//   top    — miles (or "Rest" or a free-form line like "30 min 2 run 3 walk")
//   bottom — workout segments (same shape as WorkoutRow.segments) with a
//            text fallback while coach hasn't structured them yet.
export interface PlanDay {
  miles: number | null
  isRest: boolean
  notes: string                 // top-line override when not a simple miles/rest day
  segments: WorkoutSegment[]    // bottom-line, structured workout
  extra: string                 // bottom-line free-text fallback (used when segments is empty)
}

export interface PlanTemplate {
  id: string
  label: string                 // e.g. "20A", "2/3 Walk Run"
  description: string           // e.g. "20 miles per week"
  sortOrder: number
  weeklyMiles: number | null
  tempoMinutes: number | null
  days: PlanDay[]               // length 7, Mon..Sun
}

export interface AthleticNetPR {
  event: string
  mark: string
  date?: string
  meet?: string
}

export interface WorkoutHistoryEntry {
  date: string // YYYY-MM-DD
  focus: string
  warmup: string
  workout: string
  cooldown: string
  paceEffort: string
  notes: string
  segments: WorkoutSegment[]
  coach: string
}

export interface AthleteBio {
  athlete_name: string
  nickname: string | null
  likes: string | null
  dislikes: string | null
  fun_facts: string | null
  cheer: string | null
  photo_url: string | null
  updated_at: string | null
}

export interface DayHistoryGroup {
  focus: string
  coach: string
  warmup: string
  workout: string
  cooldown: string
  paceEffort: string
  notes: string
  segments: WorkoutSegment[]
  athletes: string[]
}

export type PublishStatus = 'PUBLISH' | 'UPDATING'

export interface SheetData {
  preRunRoutine: string
  postRunRoutine: string
  videoLabel: string
  videoUrl: string
  workoutRows: WorkoutRow[]
  roster: RosterEntry[]
  planTemplates: PlanTemplate[]
  publishStatus: PublishStatus
  stravaConnected: boolean
  timezone: string // IANA name (e.g. "America/Los_Angeles"); drives all calendar-day math
}
