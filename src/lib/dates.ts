// Timezone-aware calendar-day helpers.
//
// All calendar-day math in this app must run in the team's configured timezone
// (default America/Los_Angeles), NOT via toISOString().slice(0, 10) — the latter
// is UTC, so evening-Pacific moments roll onto the next calendar day and shift
// "today" / week boundaries (see CLAUDE.md). These helpers centralize that.

const DAY_MS = 86400_000

// 'YYYY-MM-DD' for the given instant in `tz`. en-CA formats as ISO-ish y-m-d.
export function localDay(tz: string, date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date)
}

// Calendar arithmetic on a 'YYYY-MM-DD' string. Anchored at noon UTC so DST
// transitions can't nudge the result across a day boundary. Pure date math —
// independent of any timezone.
export function addDays(dayStr: string, n: number): string {
  const t = new Date(`${dayStr}T12:00:00Z`).getTime() + n * DAY_MS
  return new Date(t).toISOString().slice(0, 10)
}

// Weekday of a 'YYYY-MM-DD' string (0=Sun..6=Sat), via noon-UTC anchor.
function weekday(dayStr: string): number {
  return new Date(`${dayStr}T12:00:00Z`).getUTCDay()
}

// Monday (week start) of the week containing `date`, in `tz`, as 'YYYY-MM-DD'.
export function mondayOf(tz: string, date: Date = new Date()): string {
  const today = localDay(tz, date)
  const dow = weekday(today)
  return addDays(today, -(dow === 0 ? 6 : dow - 1))
}
