import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { User } from '@supabase/supabase-js'
import type { WorkoutRow, RosterEntry, SheetData, WorkoutSegment, RestType, PaceType, DistanceUnit, PlanTemplate, PlanDay } from '../lib/types.ts'

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return 'just now'
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

const PACE_TYPES: PaceType[] = ['easy', '5k', '3200', '1600', '800', '400', 'tempo', 'threshold', 'fast and relaxed', '95% effort']
const DIST_UNITS: DistanceUnit[] = ['meters', 'miles', 'minutes']
import { saveWorkoutRows, saveRoster, saveWorkoutHistory, fetchDayHistory, saveDayHistory, savePlanTemplates, saveSettings } from '../lib/db.ts'
import { envCoaches } from '../lib/coaches.ts'
import { localDay, addDays, mondayOf } from '../lib/dates.ts'
import type { AthleticNetPR } from '../lib/types.ts'
import { loadPRsFile, findAthleteId } from '../hooks/useAthleticNetPRs.ts'
import { computeTrainingPaces } from '../lib/vdot.ts'
import type { PRsFile } from '../hooks/useAthleticNetPRs.ts'

const REST_TYPES: RestType[] = ['easy', 'float', 'walk', 'stand', 'jog', 'full recovery']

function segUid() { return Math.random().toString(36).slice(2) }

type EditableWorkoutRow = WorkoutRow & { id: string }
type EditableRosterEntry = RosterEntry & { id: string }
type Tab = 'workouts' | 'roster' | 'mileage' | 'weekly' | 'plans' | 'settings'

function uid() { return Math.random().toString(36).slice(2) }

// ─── Auto-resizing cell textarea ─────────────────────────────────────────────

function Cell({
  value, onChange, onTab, placeholder = '', multiline = false, className = '',
}: {
  value: string
  onChange: (v: string) => void
  onTab?: (e: React.KeyboardEvent) => void
  placeholder?: string
  multiline?: boolean
  className?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = 'auto'
      ref.current.style.height = ref.current.scrollHeight + 'px'
    }
  }, [value])

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => {
        if (!multiline && e.key === 'Enter') e.preventDefault()
        if (e.key === 'Tab' && onTab) onTab(e)
      }}
      className={`w-full resize-none bg-transparent border-0 outline-none focus:bg-blue-50 focus:ring-1 focus:ring-blue-400 rounded px-1.5 py-1 text-sm leading-snug ${className}`}
      style={{ overflow: 'hidden', minHeight: '28px' }}
    />
  )
}

// Numeric cell for the VDOT column. Keeps the user-typed string locally so
// "45." doesn't get re-parsed to 45 on every keystroke (the bug that
// stripped decimals). Commits to parent only on blur or Enter.
// Two-line VDOT cell:
//   top    — calculated VDOT (read-only, from Athletic.net PRs)
//   bottom — editable override (writes to roster.vdot)
// Empty override falls back to the calculated value everywhere VDOT is used
// (see effectivePaces in vdot.ts).
function VdotCell({
  value, calculated, onCommit,
}: {
  value: number | null
  calculated: number | null
  onCommit: (v: number | null) => void
}) {
  const [draft, setDraft] = useState<string>(value == null ? '' : String(value))
  const focusedRef = useRef(false)
  useEffect(() => {
    if (!focusedRef.current) setDraft(value == null ? '' : String(value))
  }, [value])

  const commit = () => {
    const s = draft.trim()
    if (s === '') { onCommit(null); return }
    const n = parseFloat(s)
    if (!isFinite(n) || n <= 0) { setDraft(value == null ? '' : String(value)); return }
    const rounded = Math.round(n * 10) / 10
    onCommit(rounded)
    setDraft(String(rounded))
  }

  return (
    <div className="flex flex-col gap-0">
      <div
        className="px-1.5 py-0.5 text-[11px] font-mono tabular-nums text-gray-500 leading-tight"
        title="Calculated from Athletic.net PRs"
      >
        {calculated != null ? calculated.toFixed(1) : <span className="text-gray-300">—</span>}
      </div>
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        placeholder={calculated != null ? 'override' : ''}
        onChange={e => setDraft(e.target.value)}
        onFocus={() => { focusedRef.current = true }}
        onBlur={() => { focusedRef.current = false; commit() }}
        onKeyDown={e => { if (e.key === 'Enter') { e.currentTarget.blur() } }}
        className={`w-full bg-transparent border-0 outline-none focus:bg-blue-50 focus:ring-1 focus:ring-blue-400 rounded px-1.5 py-0.5 text-sm leading-tight font-mono tabular-nums font-semibold ${
          value != null ? 'text-red-600' : 'text-navy-800'
        }`}
        title="Override VDOT (leave blank to use calculated)"
      />
    </div>
  )
}

// ─── Weekly Miles Tab ─────────────────────────────────────────────────────────

function WeeklyMilesTab({
  roster,
  onTargetChange,
  onPlanChange,
  onNoteChange,
  planTemplates,
  refreshKey,
  timezone,
}: {
  roster: EditableRosterEntry[]
  onTargetChange: (id: string, target: string) => void
  onPlanChange: (id: string, planTemplateId: string | null) => void
  onNoteChange: (id: string, note: string) => void
  planTemplates: PlanTemplate[]
  refreshKey: number
  timezone: string
}) {
  const [weeklyMiles, setWeeklyMiles] = useState<Record<string, Record<string, number>>>({})
  const [grandTotals, setGrandTotals] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const currentWeekRef = useRef<HTMLTableCellElement>(null)

  // Generate 16-week range of Monday dates, oldest first. Computed in the team
  // timezone so the current-week Monday matches the server's week keys (and
  // doesn't slide to Tuesday on evening-Pacific loads). See src/lib/dates.ts.
  const weeks = useMemo(() => {
    const thisMon = mondayOf(timezone)
    return Array.from({ length: 16 }, (_, i) => addDays(thisMon, -(15 - i) * 7))
  }, [timezone])

  const currentWeekStr = weeks[weeks.length - 1]

  useEffect(() => {
    setLoading(true)
    fetch('/api/mileage?weekly=1')
      .then(r => r.json())
      .then(data => { setWeeklyMiles(data.weekly ?? {}); setGrandTotals(data.totals ?? {}); setLoading(false) })
      .catch(() => setLoading(false))
  }, [refreshKey])

  useEffect(() => {
    if (!loading && currentWeekRef.current) {
      currentWeekRef.current.scrollIntoView({ inline: 'end', behavior: 'smooth', block: 'nearest' })
    }
  }, [loading])

  const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

  const getAthleteWeeks = (rosterName: string): Record<string, number> => {
    const norm = normName(rosterName)
    for (const [key, val] of Object.entries(weeklyMiles)) {
      if (normName(key) === norm) return val
    }
    return {}
  }

  type SortCol = 'roster' | 'name' | 'target' | 'total'
  const [sortCol, setSortCol] = useState<SortCol>('roster')
  const athletes = roster.filter(r => r.name.trim() && !r.inactive)
  const sortedAthletes = useMemo(() => {
    if (sortCol === 'name') return [...athletes].sort((a, b) => a.name.localeCompare(b.name))
    if (sortCol === 'target') return [...athletes].sort((a, b) => (parseFloat(b.target) || 0) - (parseFloat(a.target) || 0))
    if (sortCol === 'total') {
      return [...athletes].sort((a, b) => {
        const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
        const totA = Object.entries(grandTotals).find(([k]) => norm(k) === norm(a.name))?.[1] ?? 0
        const totB = Object.entries(grandTotals).find(([k]) => norm(k) === norm(b.name))?.[1] ?? 0
        return totB - totA
      })
    }
    return athletes
  }, [athletes, sortCol, grandTotals])
  const toggleSort = (col: SortCol) => setSortCol(s => s === col ? 'roster' : col)
  const sortIndicator = (col: SortCol) => sortCol === col ? ' ↓' : <span className="text-gray-300 font-normal"> ↕</span>

  const fmt = (n: number) => n > 0 ? n.toFixed(1) : ''
  const stickyBg = (i: number) => i % 2 === 0 ? '#ffffff' : '#f9fafb'

  return (
    <div className="flex-1 overflow-auto p-4 bg-slate-50">
      {loading ? (
        <div className="text-center text-gray-400 py-12 text-sm">Loading…</div>
      ) : (
        <div className="overflow-scroll scrollbar-always rounded-xl border border-gray-200 bg-white shadow-sm max-h-[80vh]">
          <table className="border-collapse text-xs w-max">
            <thead className="sticky top-0 z-30">
              <tr className="bg-gray-100 border-b-2 border-gray-300">
                <th onClick={() => toggleSort('name')} className="sticky left-0 z-40 bg-gray-100 border border-gray-200 px-3 py-2 text-left font-semibold text-gray-600 w-36 min-w-[9rem] cursor-pointer select-none hover:bg-gray-200">
                  Athlete{sortIndicator('name')}
                </th>
                <th onClick={() => toggleSort('target')} className="sticky left-[144px] z-40 bg-gray-100 border border-gray-200 px-2 py-2 text-center font-semibold text-gray-600 w-16 cursor-pointer select-none hover:bg-gray-200">
                  Target{sortIndicator('target')}
                </th>
                <th onClick={() => toggleSort('total')} className="sticky left-[208px] z-40 bg-gray-100 border border-gray-200 px-2 py-2 text-center font-semibold text-gray-500 w-14 cursor-pointer select-none hover:bg-gray-200">
                  Total{sortIndicator('total')}
                </th>
                <th className="sticky left-[264px] z-40 bg-gray-100 border border-gray-200 px-2 py-2 text-center font-semibold text-gray-600 w-28" title="Assigned offseason weekly plan">
                  Plan
                </th>
                <th className="sticky left-[376px] z-40 bg-gray-100 border border-gray-200 px-2 py-2 text-left font-semibold text-gray-600 w-48" title="Roster note">
                  Note
                </th>
                {weeks.map(week => {
                  const d = new Date(week + 'T12:00:00')
                  const isCurrent = week === currentWeekStr
                  const label = `${d.getMonth() + 1}/${d.getDate()}`
                  return (
                    <th
                      key={week}
                      ref={isCurrent ? currentWeekRef as React.RefObject<HTMLTableCellElement> : undefined}
                      className={`border border-gray-200 px-2 py-2 text-center w-14 font-medium ${
                        isCurrent ? 'bg-blue-50 text-blue-600 border-x border-x-blue-300' : 'text-gray-500'
                      }`}
                    >
                      {label}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {sortedAthletes.map((entry, i) => {
                const data = getAthleteWeeks(entry.name)
                const bg = stickyBg(i)
                const norm = normName(entry.name)
                const grandTotal = Object.entries(grandTotals).find(([k]) => normName(k) === norm)?.[1] ?? 0

                return (
                  <tr key={entry.id} className="hover-row">
                    <td className="sticky left-0 z-10 border border-gray-200 px-3 py-1.5 font-medium text-gray-800 truncate max-w-[9rem]" style={{ background: bg }}>
                      <a
                        href={`/?athlete=${encodeURIComponent(entry.name)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-blue-600 hover:underline"
                        title="Open athlete page in new tab"
                      >
                        {entry.name}
                      </a>
                    </td>
                    <td className="sticky left-[144px] z-10 border border-gray-200 px-1 py-1 text-center" style={{ background: bg }}>
                      <input
                        type="text"
                        value={entry.target}
                        onChange={e => onTargetChange(entry.id, e.target.value)}
                        className="w-12 text-center border-0 bg-transparent focus:bg-blue-50 focus:ring-1 focus:ring-blue-300 rounded px-1 py-0.5 outline-none text-xs"
                        placeholder="—"
                      />
                    </td>
                    <td className="sticky left-[208px] z-10 border border-gray-200 px-2 py-1.5 text-center text-gray-700 font-medium" style={{ background: bg }}>
                      {fmt(grandTotal) || <span className="text-gray-200">—</span>}
                    </td>
                    <td className="sticky left-[264px] z-10 border border-gray-200 p-0 align-middle" style={{ background: bg }}>
                      <select
                        value={entry.planTemplateId ?? ''}
                        onChange={e => onPlanChange(entry.id, e.target.value || null)}
                        className="w-full bg-transparent border-0 outline-none focus:bg-blue-50 text-xs px-1 py-1"
                      >
                        <option value="">—</option>
                        {planTemplates.map(t => (
                          <option key={t.id} value={t.id}>{t.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="sticky left-[376px] z-10 border border-gray-200 p-0 align-middle" style={{ background: bg }}>
                      <input
                        type="text"
                        value={entry.note}
                        onChange={e => onNoteChange(entry.id, e.target.value)}
                        placeholder="—"
                        className="w-full bg-transparent border-0 outline-none focus:bg-blue-50 text-xs px-2 py-1"
                        title={entry.note}
                      />
                    </td>
                    {weeks.map(week => {
                      const miles = data[week] ?? 0
                      const isCurrent = week === currentWeekStr
                      const target = parseFloat(entry.target)
                      const pct = miles > 0 && target > 0 ? miles / target : 0
                      // Color: gray if no data, green if at/above target, amber if close, red if well under
                      const valueClass = miles === 0 ? '' :
                        isCurrent ? 'text-blue-700 font-bold' :
                        pct >= 1 ? 'text-green-600 font-semibold' :
                        pct >= 0.8 ? 'text-amber-600 font-semibold' :
                        'text-gray-700 font-medium'

                      return (
                        <td
                          key={week}
                          className={`border border-gray-200 px-2 py-1.5 text-center ${
                            isCurrent ? 'bg-blue-50/40 border-x border-x-blue-200' : ''
                          }`}
                        >
                          {miles > 0
                            ? <span className={valueClass}>{miles.toFixed(1)}</span>
                            : <span className="text-gray-150">·</span>
                          }
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Mileage Tab ─────────────────────────────────────────────────────────────

function MileageTab({
  roster,
  onTargetChange,
  onReorder,
  refreshKey,
  timezone,
}: {
  roster: EditableRosterEntry[]
  onTargetChange: (id: string, target: string) => void
  onReorder: (fromName: string, toName: string) => void
  refreshKey: number
  timezone: string
}) {
  type DayEntry = {
    miles: number
    source: 'strava' | 'manual' | 'mixed'
    manualMiles?: number
    stravaMiles?: number
  }
  const [dailyMiles, setDailyMiles] = useState<Record<string, Record<string, DayEntry>>>({})
  const [dragRow, setDragRow] = useState<string | null>(null)
  const [dragOverRow, setDragOverRow] = useState<string | null>(null)
  const [grandTotals, setGrandTotals] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ name: string; date: string } | null>(null)
  const [editVal, setEditVal] = useState('')
  const [conflict, setConflict] = useState<{ name: string; date: string; entry: DayEntry } | null>(null)
  const todayRef = useRef<HTMLTableCellElement>(null)

  // All calendar-day math runs in the team timezone (not UTC) — otherwise
  // evening-Pacific shifts "today" and the week boundary onto the next day,
  // dropping Monday's miles from CW. See src/lib/dates.ts / CLAUDE.md.
  const todayStr = useMemo(() => localDay(timezone), [timezone])

  // 30 past days + today + 7 future = 38 columns
  const dates = useMemo(
    () => Array.from({ length: 38 }, (_, i) => addDays(todayStr, -30 + i)),
    [todayStr],
  )

  // Monday of current week
  const weekStartStr = useMemo(() => mondayOf(timezone), [timezone])

  const sevenDaysAgoStr = useMemo(() => addDays(todayStr, -7), [todayStr])

  useEffect(() => {
    setLoading(true)
    fetch('/api/mileage')
      .then(r => r.json())
      .then(data => { setDailyMiles(data.daily ?? {}); setGrandTotals(data.totals ?? {}); setLoading(false) })
      .catch(() => setLoading(false))
  }, [refreshKey])

  useEffect(() => {
    if (!loading && todayRef.current) {
      todayRef.current.scrollIntoView({ inline: 'center', behavior: 'smooth', block: 'nearest' })
    }
  }, [loading])

  const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

  const getAthleteData = (rosterName: string): Record<string, DayEntry> => {
    const norm = normName(rosterName)
    for (const [key, val] of Object.entries(dailyMiles)) {
      if (normName(key) === norm) return val
    }
    return {}
  }

  const saveEntry = async (athleteName: string, date: string, milesStr: string) => {
    const miles = parseFloat(milesStr) || 0
    // No-op when the value hasn't changed — otherwise blurring an orange (Strava)
    // cell would write a duplicate manual row and turn the day into a mixed conflict.
    const currentMiles = getAthleteData(athleteName)[date]?.miles ?? 0
    if (Math.abs(miles - currentMiles) < 0.005) {
      setEditing(null)
      return
    }
    try {
      await fetch('/api/mileage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ athleteName, date, miles }),
      })
      setDailyMiles(prev => {
        const norm = normName(athleteName)
        const key = Object.keys(prev).find(k => normName(k) === norm) ?? athleteName
        const updated = { ...prev, [key]: { ...(prev[key] ?? {}) } }
        const existing = updated[key][date]
        const stravaMiles = existing?.stravaMiles ?? (existing?.source !== 'manual' ? existing?.miles ?? 0 : 0)
        if (miles <= 0) {
          if (stravaMiles > 0) {
            updated[key][date] = { miles: stravaMiles, source: 'strava', manualMiles: 0, stravaMiles }
          } else {
            delete updated[key][date]
          }
        } else {
          updated[key][date] = {
            miles: miles + stravaMiles,
            source: stravaMiles > 0 ? 'mixed' : 'manual',
            manualMiles: miles,
            stravaMiles,
          }
        }
        return updated
      })
    } finally {
      setEditing(null)
    }
  }

  const resolveConflict = async (athleteName: string, date: string, keep: 'manual' | 'strava') => {
    const drop: 'manual' | 'strava' = keep === 'manual' ? 'strava' : 'manual'
    await fetch('/api/mileage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ athleteName, date, miles: 0, source: drop }),
    })
    setDailyMiles(prev => {
      const norm = normName(athleteName)
      const key = Object.keys(prev).find(k => normName(k) === norm) ?? athleteName
      const existing = prev[key]?.[date]
      if (!existing) return prev
      const kept = keep === 'manual' ? (existing.manualMiles ?? 0) : (existing.stravaMiles ?? 0)
      const updated = { ...prev, [key]: { ...prev[key] } }
      if (kept > 0) {
        updated[key][date] = {
          miles: kept,
          source: keep,
          manualMiles: keep === 'manual' ? kept : 0,
          stravaMiles: keep === 'strava' ? kept : 0,
        }
      } else {
        delete updated[key][date]
      }
      return updated
    })
    setConflict(null)
  }

  const [sortByName, setSortByName] = useState(false)
  const athletes = roster.filter(r => r.name.trim() && !r.inactive)
  const sortedAthletes = sortByName ? [...athletes].sort((a, b) => a.name.localeCompare(b.name)) : athletes
  const fmt = (n: number) => n > 0 ? n.toFixed(1) : ''

  // Sticky column left offsets: Name(144) + Target(64) + Total(56) + L7(48) + CW(48) + LR(48)
  const stickyBg = (i: number) => i % 2 === 0 ? '#ffffff' : '#f9fafb'

  return (
    <div className="flex-1 overflow-auto p-4 bg-slate-50">
      {loading ? (
        <div className="text-center text-gray-400 py-12 text-sm">Loading mileage…</div>
      ) : (
        <div className="overflow-scroll scrollbar-always rounded-xl border border-gray-200 bg-white shadow-sm max-h-[80vh]">
          <table className="border-collapse text-xs w-max">
            <thead className="sticky top-0 z-30">
              <tr className="bg-gray-100 border-b-2 border-gray-300">
                <th onClick={() => setSortByName(s => !s)} className="sticky left-0 z-40 bg-gray-100 border border-gray-200 px-3 py-2 text-left font-semibold text-gray-600 w-36 min-w-[9rem] cursor-pointer select-none hover:bg-gray-200">
                  Athlete {sortByName ? '↑' : <span className="text-gray-300 font-normal">↕</span>}
                </th>
                <th className="sticky left-[144px] z-40 bg-gray-100 border border-gray-200 px-2 py-2 text-center font-semibold text-gray-600 w-16">Target</th>
                <th className="sticky left-[208px] z-40 bg-gray-100 border border-gray-200 px-2 py-2 text-center font-semibold text-gray-500 w-14">Total</th>
                <th className="sticky left-[264px] z-40 bg-gray-100 border border-gray-200 px-2 py-2 text-center font-semibold text-gray-500 w-12">L7</th>
                <th className="sticky left-[312px] z-40 bg-gray-100 border border-gray-200 px-2 py-2 text-center font-bold text-blue-600 w-12">CW</th>
                <th className="sticky left-[360px] z-40 bg-gray-100 border border-gray-200 px-2 py-2 text-center font-semibold text-gray-500 w-12" title="Longest run (30 days)">LR</th>
                {dates.map(date => {
                  const d = new Date(date + 'T12:00:00')
                  const isToday = date === todayStr
                  const isFuture = date > todayStr
                  const isMonday = d.getDay() === 1
                  const label = `${d.getMonth() + 1}/${d.getDate()}`
                  return (
                    <th
                      key={date}
                      ref={isToday ? todayRef as React.RefObject<HTMLTableCellElement> : undefined}
                      className={`border border-gray-200 px-1 py-2 text-center w-12 font-medium ${
                        isToday
                          ? 'bg-blue-50 text-blue-600 border-x border-x-blue-300'
                          : isFuture
                          ? 'text-gray-300'
                          : isMonday
                          ? 'text-gray-600 border-l-2 border-l-gray-400'
                          : 'text-gray-500'
                      }`}
                    >
                      {label}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {sortedAthletes.map((entry, i) => {
                const data = getAthleteData(entry.name)
                const bg = stickyBg(i)

                // Grand total from API (all time)
                const norm = normName(entry.name)
                const grandTotal = Object.entries(grandTotals).find(([k]) => normName(k) === norm)?.[1] ?? 0

                const last7 = dates
                  .filter(d => d > sevenDaysAgoStr && d <= todayStr)
                  .reduce((s, d) => s + (data[d]?.miles ?? 0), 0)
                const cw = dates
                  .filter(d => d >= weekStartStr && d <= todayStr)
                  .reduce((s, d) => s + (data[d]?.miles ?? 0), 0)
                const longestRun = dates
                  .filter(d => d <= todayStr)
                  .reduce((mx, d) => Math.max(mx, data[d]?.miles ?? 0), 0)

                return (
                  <tr
                    key={entry.id}
                    className={`hover-row ${dragOverRow === entry.name ? 'border-t-2 border-t-blue-400' : ''}`}
                    draggable
                    onDragStart={e => { e.dataTransfer.setData('text/plain', entry.name); e.dataTransfer.effectAllowed = 'move'; setDragRow(entry.name) }}
                    onDragEnd={() => { setDragRow(null); setDragOverRow(null) }}
                    onDragOver={e => { e.preventDefault(); setDragOverRow(entry.name) }}
                    onDragLeave={() => setDragOverRow(null)}
                    onDrop={e => { e.preventDefault(); const from = e.dataTransfer.getData('text/plain'); if (from && from !== entry.name) onReorder(from, entry.name); setDragOverRow(null); setDragRow(null) }}
                  >
                    <td className={`sticky left-0 z-10 border border-gray-200 px-3 py-1.5 font-medium text-gray-800 truncate max-w-[9rem] ${dragRow === entry.name ? 'opacity-50' : ''}`} style={{ background: bg, cursor: 'grab' }}>
                      <a
                        href={`/?athlete=${encodeURIComponent(entry.name)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        draggable={false}
                        className="hover:text-blue-600 hover:underline"
                        title="Open athlete page in new tab"
                      >
                        {entry.name}
                      </a>
                    </td>
                    <td className="sticky left-[144px] z-10 border border-gray-200 px-1 py-1 text-center" style={{ background: bg }}>
                      <input
                        type="text"
                        value={entry.target}
                        onChange={e => onTargetChange(entry.id, e.target.value)}
                        className="w-12 text-center border-0 bg-transparent focus:bg-blue-50 focus:ring-1 focus:ring-blue-300 rounded px-1 py-0.5 outline-none text-xs"
                        placeholder="—"
                      />
                    </td>
                    <td className="sticky left-[208px] z-10 border border-gray-200 px-2 py-1.5 text-center text-gray-700 font-medium" style={{ background: bg }}>
                      {fmt(grandTotal) || <span className="text-gray-200">—</span>}
                    </td>
                    <td className="sticky left-[264px] z-10 border border-gray-200 px-2 py-1.5 text-center text-gray-600" style={{ background: bg }}>
                      {fmt(last7) || <span className="text-gray-200">—</span>}
                    </td>
                    <td className="sticky left-[312px] z-10 border border-gray-200 px-2 py-1.5 text-center font-bold text-blue-600" style={{ background: bg }}>
                      {fmt(cw) || <span className="text-gray-200 font-normal">—</span>}
                    </td>
                    <td className="sticky left-[360px] z-10 border border-gray-200 px-2 py-1.5 text-center text-gray-600" style={{ background: bg }}>
                      {fmt(longestRun) || <span className="text-gray-200">—</span>}
                    </td>
                    {dates.map(date => {
                      const day = data[date]
                      const miles = day?.miles ?? 0
                      const source = day?.source
                      const isEditing = editing?.name === entry.name && editing?.date === date
                      const isToday = date === todayStr
                      const isFuture = date > todayStr
                      const d = new Date(date + 'T12:00:00')
                      const isMonday = d.getDay() === 1

                      // Color by source: orange=strava, blue=manual, purple=mixed (conflict)
                      const valueClass = isFuture
                        ? 'text-blue-400 font-medium'
                        : source === 'strava' ? 'text-orange-500 font-medium'
                        : source === 'manual' ? 'text-blue-600 font-medium'
                        : source === 'mixed' ? 'text-purple-700 font-bold'
                        : 'text-gray-700 font-medium'

                      const isConflict = source === 'mixed'
                      const tooltip = isConflict
                        ? `Conflict — Manual: ${(day?.manualMiles ?? 0).toFixed(1)} mi · Strava: ${(day?.stravaMiles ?? 0).toFixed(1)} mi (click to resolve)`
                        : source

                      const cellBg = isConflict
                        ? 'bg-amber-100 hover:bg-amber-200'
                        : isToday ? 'bg-blue-50/40 border-x border-x-blue-200 hover:bg-blue-50'
                        : isMonday ? 'border-l-2 border-l-gray-300 hover:bg-blue-50'
                        : 'hover:bg-blue-50'

                      return (
                        <td
                          key={date}
                          onClick={() => {
                            if (isEditing) return
                            if (isConflict && day) {
                              setConflict({ name: entry.name, date, entry: day })
                            } else {
                              setEditing({ name: entry.name, date })
                              setEditVal(miles > 0 ? miles.toFixed(2) : '')
                            }
                          }}
                          className={`border border-gray-200 px-0.5 py-1 text-center cursor-pointer transition-colors ${cellBg}`}
                        >
                          {isEditing ? (
                            <input
                              autoFocus
                              type="text"
                              value={editVal}
                              onChange={e => setEditVal(e.target.value)}
                              onBlur={() => saveEntry(entry.name, date, editVal)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') saveEntry(entry.name, date, editVal)
                                if (e.key === 'Escape') setEditing(null)
                              }}
                              className="w-10 text-center border border-blue-400 rounded outline-none bg-white px-1 text-xs"
                            />
                          ) : miles > 0 ? (
                            <span className={valueClass} title={tooltip}>
                              {miles.toFixed(1)}
                            </span>
                          ) : (
                            <span className="text-gray-150 select-none">·</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {conflict && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setConflict(null)}
        >
          <div
            className="w-[360px] rounded-xl bg-white shadow-xl border border-gray-200 p-5"
            onClick={e => e.stopPropagation()}
          >
            <div className="text-sm text-gray-500 mb-1">{conflict.date}</div>
            <div className="text-base font-semibold text-gray-900 mb-3">{conflict.name}</div>
            <div className="text-xs text-gray-600 mb-4">
              Both manual and Strava data exist for this day. Pick which to keep — the other will be deleted.
            </div>
            <div className="space-y-2">
              <button
                onClick={() => resolveConflict(conflict.name, conflict.date, 'manual')}
                className="w-full flex items-center justify-between rounded-lg border border-blue-300 bg-blue-50 hover:bg-blue-100 px-3 py-2 text-sm"
              >
                <span className="text-blue-700 font-medium">Keep manual</span>
                <span className="text-blue-700 font-semibold">{(conflict.entry.manualMiles ?? 0).toFixed(1)} mi</span>
              </button>
              <button
                onClick={() => resolveConflict(conflict.name, conflict.date, 'strava')}
                className="w-full flex items-center justify-between rounded-lg border border-orange-300 bg-orange-50 hover:bg-orange-100 px-3 py-2 text-sm"
              >
                <span className="text-orange-600 font-medium">Keep Strava</span>
                <span className="text-orange-600 font-semibold">{(conflict.entry.stravaMiles ?? 0).toFixed(1)} mi</span>
              </button>
            </div>
            <button
              onClick={() => setConflict(null)}
              className="mt-4 w-full text-xs text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Athlete Assignment Sheet ─────────────────────────────────────────────────

function AthleteSheet({
  roster, workoutRows, onAssign, onSetOffseason, onAddGroup, onWorkoutRowChange, onDeleteGroup, onDuplicateGroup, onReorderGroups,
}: {
  roster: EditableRosterEntry[]
  workoutRows: EditableWorkoutRow[]
  onAssign: (athleteName: string, toGroupFocus: string | null) => void
  onSetOffseason: (athleteName: string, value: boolean) => void
  onAddGroup: (row: Omit<EditableWorkoutRow, 'id' | 'athletesRaw'>) => void
  onWorkoutRowChange: (id: string, k: keyof WorkoutRow, v: string | WorkoutSegment[]) => void
  onDeleteGroup: (id: string) => void
  onDuplicateGroup: (id: string) => void
  onReorderGroups: (fromId: string, toId: string) => void
}) {
  const [dragging, setDragging] = useState<Set<string>>(new Set())
  const [draggingCard, setDraggingCard] = useState<string | null>(null)
  const [dragOverCard, setDragOverCard] = useState<string | null>(null)
  const [prsFile, setPrsFile] = useState<PRsFile | null>(null)
  useEffect(() => { loadPRsFile().then(setPrsFile).catch(() => {}) }, [])


const [dragOver, setDragOver] = useState<string | null>(null)
  const [showAddGroup, setShowAddGroup] = useState(false)
  const [newGroup, setNewGroup] = useState({ focus: '', coach: '', warmup: '', workout: '', cooldown: '', paceEffort: '', notes: '', segments: [] as WorkoutSegment[] })
  const [editingWorkoutId, setEditingWorkoutId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [picker, setPicker] = useState<{ names: string[] } | null>(null)
  const longPressTimer = useRef<number | null>(null)

  const toggleSelect = (name: string) =>
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  const openPicker = (anchor: string) => {
    const names = selected.has(anchor) ? Array.from(selected) : [anchor]
    setPicker({ names })
  }
  const cancelLongPress = () => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }
  const startLongPress = (name: string) => {
    cancelLongPress()
    longPressTimer.current = window.setTimeout(() => openPicker(name), 450)
  }

  // Build a map: athleteName → workoutRow id (based on athletesRaw)
  const assignedTo: Record<string, string> = {}
  for (const row of workoutRows) {
    for (const name of row.athletesRaw.split('\n').map(n => n.trim()).filter(Boolean)) {
      assignedTo[name] = row.focus
    }
  }

  // Only show chips for roster members (prevents garbage athletesRaw content appearing as chips)
  const rosterNames = new Set(roster.filter(r => !r.inactive).map(r => r.name.trim()).filter(Boolean))
  const allNames = [...rosterNames]

  // Groups = workout rows (by focus), plus Unassigned bucket
  const groups = workoutRows.map(r => ({ focus: r.focus, coach: r.coach, warmup: r.warmup, workout: r.workout, cooldown: r.cooldown, paceEffort: r.paceEffort, notes: r.notes ?? '', segments: r.segments ?? [], id: r.id }))
  const unassigned = allNames.filter(n => !assignedTo[n]).sort((a, b) => a.localeCompare(b))

  const startDrag = (name: string, e: React.DragEvent) => {
    cancelLongPress()
    const names = selected.has(name) ? Array.from(selected) : [name]
    e.dataTransfer.setData('text/plain', JSON.stringify(names))
    setDragging(new Set(names))
  }

  const handleDrop = (focus: string | null, e: React.DragEvent) => {
    e.preventDefault()
    try {
      const names: string[] = JSON.parse(e.dataTransfer.getData('text/plain'))
      names.forEach(name => onAssign(name, focus))
    } catch {
      // legacy single-name fallback
      const name = e.dataTransfer.getData('text/plain')
      if (name) onAssign(name, focus)
    }
    setDragging(new Set())
    setDragOver(null)
  }

  const chipClass = (name: string) =>
    `inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium cursor-grab transition-all select-none ${
      dragging.has(name)
        ? 'opacity-40 bg-blue-100 border border-blue-300 text-blue-600'
        : selected.has(name)
        ? 'bg-blue-50 border border-blue-500 ring-1 ring-blue-400 text-blue-700'
        : 'bg-white border border-gray-300 text-gray-700 hover:border-blue-400 hover:text-blue-600'
    }`

  const chipInteractionProps = (name: string) => ({
    onClick: (e: React.MouseEvent) => { e.stopPropagation(); toggleSelect(name) },
    onPointerDown: () => startLongPress(name),
    onPointerUp: cancelLongPress,
    onPointerLeave: cancelLongPress,
    onPointerCancel: cancelLongPress,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    style: { WebkitTouchCallout: 'none', WebkitUserSelect: 'none' } as React.CSSProperties,
  })

  void roster // rosterMap removed; chip labels now use PR-based target times

  const emptyGroups = [...groups].filter(g => allNames.filter(n => assignedTo[n] === g.focus).length === 0)
  const populatedGroups = [...groups].filter(g => allNames.filter(n => assignedTo[n] === g.focus).length > 0)

  return (
    <div className="flex-1 overflow-auto p-4 bg-slate-50">
      <div className="flex gap-3 items-start">

      {/* Left sidebar: unassigned (on top, where the coach's eye lands first) + empty groups */}
      <div className="flex flex-col gap-2 w-44 shrink-0">
        {/* Unassigned — pinned to top */}
        <div
          onDragOver={e => { e.preventDefault(); setDragOver('__unassigned__') }}
          onDragLeave={() => setDragOver(null)}
          onDrop={e => handleDrop(null, e)}
          className={`rounded-xl border-2 p-2.5 transition-all ${
            dragOver === '__unassigned__' ? 'border-amber-400 bg-amber-50 shadow-md' : 'border-dashed border-gray-300 bg-gray-50'
          }`}
        >
          <div className="text-xs font-bold text-gray-500 mb-1.5">Unassigned</div>
          <div className="flex flex-col gap-1">
            {unassigned.map(name => (
              <span
                key={name}
                draggable
                onDragStart={e => startDrag(name, e)}
                onDragEnd={() => setDragging(new Set())}
                {...chipInteractionProps(name)}
                className={chipClass(name)}
              >
                {name}
              </span>
            ))}
            {unassigned.length === 0 && <span className="text-xs text-gray-300 italic">none</span>}
          </div>
        </div>

        {emptyGroups.map(g => {
          const athletes = allNames.filter(n => assignedTo[n] === g.focus)
          return (
            <div
              key={g.id}
              onDragOver={e => {
                e.preventDefault()
                if (Array.from(e.dataTransfer.types).includes('card-id')) setDragOverCard(g.id)
                else setDragOver(g.id)
              }}
              onDragLeave={() => { setDragOver(null); setDragOverCard(null) }}
              onDrop={e => {
                const fromId = e.dataTransfer.getData('card-id')
                if (fromId && fromId !== g.id) {
                  onReorderGroups(fromId, g.id)
                  setDraggingCard(null); setDragOverCard(null)
                } else {
                  handleDrop(g.focus, e)
                }
              }}
              className={`rounded-xl border-2 p-2.5 transition-all ${
                dragOverCard === g.id ? 'border-purple-400 bg-purple-50 shadow-md'
                : dragOver === g.id ? 'border-blue-400 bg-blue-50 shadow-md'
                : draggingCard === g.id ? 'opacity-40'
                : 'border-gray-200 bg-white'
              }`}
            >
              <div className="flex items-center justify-between gap-1 mb-1">
                <div className="text-xs font-bold text-gray-500 truncate">{g.focus || '(no focus)'}</div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={e => { e.stopPropagation(); setEditingWorkoutId(prev => prev === g.id ? null : g.id) }}
                    className="text-[10px] text-blue-400 hover:text-blue-600">{editingWorkoutId === g.id ? 'done' : 'edit'}</button>
                  <button onClick={e => { e.stopPropagation(); onDuplicateGroup(g.id) }}
                    className="text-[10px] text-gray-400 hover:text-gray-600" title="Duplicate">⧉</button>
                  <button onClick={e => { e.stopPropagation(); onDeleteGroup(g.id) }}
                    className="text-[10px] text-gray-300 hover:text-red-400" title="Delete">✕</button>
                </div>
              </div>
              {g.coach && editingWorkoutId !== g.id && <div className="text-[10px] text-gray-400 mb-1">Coach: {g.coach}</div>}
              {editingWorkoutId === g.id ? (
                <div className="mt-1 flex flex-col gap-2">
                  <div className="flex gap-2">
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] font-semibold text-amber-600 uppercase">WU</span>
                      <input type="number" min="0" value={g.warmup} onChange={e => onWorkoutRowChange(g.id, 'warmup', e.target.value)}
                        className="w-10 text-xs text-center border border-amber-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-amber-400" />
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] font-semibold text-green-600 uppercase">CD</span>
                      <input type="number" min="0" value={g.cooldown} onChange={e => onWorkoutRowChange(g.id, 'cooldown', e.target.value)}
                        className="w-10 text-xs text-center border border-green-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-green-400" />
                    </div>
                  </div>
                  {g.segments.map((seg, si) => {
                    const upd = (patch: Partial<WorkoutSegment>) =>
                      onWorkoutRowChange(g.id, 'segments', g.segments.map((s, i) => i === si ? { ...s, ...patch } : s))
                    return (
                      <div key={seg.id} className="bg-blue-50 border border-blue-100 rounded-lg p-1.5 flex items-center gap-1 flex-wrap">
                        <input value={seg.qty} onChange={e => upd({ qty: e.target.value })} placeholder="4"
                          className="w-7 text-xs text-center border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                        <span className="text-xs text-gray-400">×</span>
                        <input value={seg.distance} onChange={e => upd({ distance: e.target.value })} placeholder="400"
                          className="w-12 text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                        <select value={seg.unit} onChange={e => upd({ unit: e.target.value as DistanceUnit })}
                          className="text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white">
                          {DIST_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                        </select>
                        <span className="text-xs text-gray-400">@</span>
                        <select value={seg.pace} onChange={e => upd({ pace: e.target.value as PaceType })}
                          className="text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white font-medium text-blue-700">
                          {PACE_TYPES.map(p => <option key={p} value={p}>{p}</option>)}
                        </select>
                        <input value={seg.restDuration} onChange={e => upd({ restDuration: e.target.value })} placeholder="90s"
                          className="w-10 text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                        <select value={seg.rest} onChange={e => upd({ rest: e.target.value as RestType })}
                          className="text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white">
                          {REST_TYPES.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <button onClick={() => onWorkoutRowChange(g.id, 'segments', g.segments.filter((_, i) => i !== si))}
                          className="text-gray-300 hover:text-red-400 text-sm leading-none ml-auto">×</button>
                      </div>
                    )
                  })}
                  <button onClick={() => onWorkoutRowChange(g.id, 'segments', [...g.segments, { id: segUid(), qty: '1', distance: '', unit: 'meters', pace: '5k', restDuration: '', rest: 'jog' }])}
                    className="text-xs text-blue-400 hover:text-blue-600">+ add segment</button>
                  <textarea rows={1} value={g.notes}
                    onChange={e => { onWorkoutRowChange(g.id, 'notes', e.target.value); const el = e.target; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }}
                    onFocus={e => { const el = e.target; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }}
                    className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none overflow-hidden"
                    placeholder="Notes…" />
                </div>
              ) : (
                <div className="text-[10px] text-gray-300 italic">drop athletes here</div>
              )}
              {athletes.length > 0 && (
                <div className="mt-1 flex flex-col gap-0.5">
                  {athletes.map(name => (
                    <span
                      key={name}
                      draggable
                      data-chip
                      onDragStart={e => startDrag(name, e)}
                      onDragEnd={() => setDragging(new Set())}
                      {...chipInteractionProps(name)}
                      className={`${chipClass(name)} w-full`}
                    >
                      {name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}

        {/* Add group */}
        {!showAddGroup && (
          <button onClick={() => setShowAddGroup(true)}
            className="rounded-xl border-2 border-dashed border-gray-200 p-2.5 text-xs text-gray-400 hover:border-blue-300 hover:text-blue-500 transition-colors text-left w-full">
            + Add group
          </button>
        )}
      </div>

      {/* Main area: populated groups */}
      <div className="flex-1 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
        {populatedGroups.map(g => {
          const athletes = allNames.filter(n => assignedTo[n] === g.focus).sort((a, b) => {
            const vdotFor = (name: string) => {
              const r = roster.find(x => x.name === name)
              if (r?.vdot != null && r.vdot > 0) return r.vdot
              if (!prsFile) return 0
              const id = findAthleteId(prsFile, name)
              if (!id) return 0
              return computeTrainingPaces(prsFile[id].prs)?.vdot ?? 0
            }
            return vdotFor(b) - vdotFor(a) // fast (high VDOT) first
          })
          return (
            <div
              key={g.id}
              onDragOver={e => {
                e.preventDefault()
                if (Array.from(e.dataTransfer.types).includes('card-id')) setDragOverCard(g.id)
                else setDragOver(g.id)
              }}
              onDragLeave={() => { setDragOver(null); setDragOverCard(null) }}
              onDrop={e => {
                const fromId = e.dataTransfer.getData('card-id')
                if (fromId && fromId !== g.id) {
                  onReorderGroups(fromId, g.id)
                  setDraggingCard(null); setDragOverCard(null)
                } else {
                  handleDrop(g.focus, e)
                }
              }}
              className={`rounded-xl border-2 p-3 transition-all ${
                dragOverCard === g.id
                  ? 'border-purple-400 bg-purple-50 shadow-md'
                  : dragOver === g.id
                  ? 'border-blue-400 bg-blue-50 shadow-md'
                  : draggingCard === g.id
                  ? 'opacity-40'
                  : 'border-gray-200 bg-white cursor-default'
              }`}
            >
              <div className="mb-2">
                <div className="flex items-start justify-between gap-1">
                  <div className="flex items-start gap-1 min-w-0">
                    {/* Drag handle — only this element initiates card reorder */}
                    <span
                      draggable
                      onDragStart={e => { e.stopPropagation(); e.dataTransfer.setData('card-id', g.id); e.dataTransfer.effectAllowed = 'move'; setDraggingCard(g.id) }}
                      onDragEnd={() => { setDraggingCard(null); setDragOverCard(null) }}
                      onClick={e => e.stopPropagation()}
                      className="text-gray-300 hover:text-gray-500 cursor-grab mt-0.5 shrink-0 select-none text-sm leading-none"
                      title="Drag to reorder"
                    >⠿</span>
                    <div>
                      <div className="text-xs font-bold text-gray-800 leading-tight">{g.focus || '(no focus)'}</div>
                      {g.coach && <div className="text-xs text-gray-400 mt-0.5">Coach: {g.coach}</div>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={e => { e.stopPropagation(); setEditingWorkoutId(prev => prev === g.id ? null : g.id) }}
                      className="text-[10px] text-blue-400 hover:text-blue-600">
                      {editingWorkoutId === g.id ? 'done' : 'edit'}
                    </button>
                    <button onClick={e => { e.stopPropagation(); onDuplicateGroup(g.id) }}
                      className="text-[10px] text-gray-400 hover:text-gray-600" title="Duplicate">⧉</button>
                    <button onClick={e => { e.stopPropagation(); onDeleteGroup(g.id) }}
                      className="text-[10px] text-gray-300 hover:text-red-400" title="Delete">✕</button>
                  </div>
                </div>

                {/* Warmup/cooldown summary */}
                {(g.warmup || g.cooldown) && editingWorkoutId !== g.id && (
                  <div className="mt-1 flex gap-2 text-xs text-gray-400">
                    {g.warmup && <span><span className="text-amber-500">WU</span> {g.warmup}min</span>}
                    {g.cooldown && <span><span className="text-green-500">CD</span> {g.cooldown}min</span>}
                  </div>
                )}

                {/* Segments read-only */}
                {g.segments.length > 0 && editingWorkoutId !== g.id && (
                  <div className="mt-1.5 flex flex-col gap-0.5">
                    {g.segments.map(seg => (
                      <div key={seg.id} className="text-xs text-gray-700 bg-blue-50 rounded px-2 py-0.5">
                        <span className="font-medium">{seg.qty}×{seg.distance} {seg.unit}</span>
                        <span className="ml-1.5 text-blue-600 font-medium">@ {seg.pace}</span>
                        {(seg.restDuration && seg.restDuration !== '0') && (
                          <span className="ml-1.5 text-gray-400">· {seg.restDuration} {seg.rest}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Notes preview (read-only) */}
                {g.notes && editingWorkoutId !== g.id && (
                  <p className="mt-1 text-xs text-gray-500 whitespace-pre-wrap">{g.notes}</p>
                )}

                {/* Edit workout panel */}
                {editingWorkoutId === g.id && (
                  <div className="mt-2 flex flex-col gap-2">
                    {/* Warmup / Cooldown */}
                    <div className="flex gap-3">
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] font-semibold text-amber-600 uppercase">WU</span>
                        <input type="number" min="0" value={g.warmup} onChange={e => onWorkoutRowChange(g.id, 'warmup', e.target.value)}
                          placeholder="0" className="w-10 text-xs text-center border border-amber-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-amber-400" />
                        <span className="text-xs text-gray-400">min</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] font-semibold text-green-600 uppercase">CD</span>
                        <input type="number" min="0" value={g.cooldown} onChange={e => onWorkoutRowChange(g.id, 'cooldown', e.target.value)}
                          placeholder="0" className="w-10 text-xs text-center border border-green-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-green-400" />
                        <span className="text-xs text-gray-400">min</span>
                      </div>
                    </div>
                    {/* Segments */}
                    <div className="flex flex-col gap-1.5">
                      {g.segments.map((seg, si) => {
                        const upd = (patch: Partial<WorkoutSegment>) =>
                          onWorkoutRowChange(g.id, 'segments', g.segments.map((s, i) => i === si ? { ...s, ...patch } : s))
                        return (
                          <div key={seg.id} className="bg-blue-50 border border-blue-100 rounded-lg p-1.5 flex items-center gap-1 flex-wrap">
                            <input value={seg.qty} onChange={e => upd({ qty: e.target.value })} placeholder="4"
                              className="w-7 text-xs text-center border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                            <span className="text-xs text-gray-400">×</span>
                            <input value={seg.distance} onChange={e => upd({ distance: e.target.value })} placeholder="400"
                              className="w-12 text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                            <select value={seg.unit} onChange={e => upd({ unit: e.target.value as DistanceUnit })}
                              className="text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white">
                              {DIST_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                            </select>
                            <span className="text-xs text-gray-400">@</span>
                            <select value={seg.pace} onChange={e => upd({ pace: e.target.value as PaceType })}
                              className="text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white font-medium text-blue-700">
                              {PACE_TYPES.map(p => <option key={p} value={p}>{p}</option>)}
                            </select>
                            <input value={seg.restDuration} onChange={e => upd({ restDuration: e.target.value })} placeholder="90s"
                              className="w-10 text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                            <select value={seg.rest} onChange={e => upd({ rest: e.target.value as RestType })}
                              className="text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white">
                              {REST_TYPES.map(r => <option key={r} value={r}>{r}</option>)}
                            </select>
                            <button onClick={() => onWorkoutRowChange(g.id, 'segments', g.segments.filter((_, i) => i !== si))}
                              className="text-gray-300 hover:text-red-400 text-sm leading-none ml-auto">×</button>
                          </div>
                        )
                      })}
                    </div>
                    <button
                      onClick={() => onWorkoutRowChange(g.id, 'segments', [...g.segments, { id: segUid(), qty: '1', distance: '', unit: 'meters', pace: '5k', restDuration: '', rest: 'jog' }])}
                      className="text-xs text-blue-400 hover:text-blue-600"
                    >+ add segment</button>
                    {/* Notes */}
                    <div>
                      <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Notes</span>
                      <textarea
                        rows={1}
                        value={g.notes}
                        onChange={e => {
                          onWorkoutRowChange(g.id, 'notes', e.target.value)
                          const el = e.target; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'
                        }}
                        onFocus={e => { const el = e.target; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }}
                        className="w-full mt-0.5 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none overflow-hidden"
                        placeholder="Notes visible to athletes…"
                      />
                    </div>
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1">
                {athletes.map(name => {
                  return (
                    <span
                      key={name}
                      draggable
                      data-chip
                      onDragStart={e => startDrag(name, e)}
                      onDragEnd={() => setDragging(new Set())}
                      {...chipInteractionProps(name)}
                      className={`${chipClass(name)} w-full group/chip`}
                    >
                      <span className="flex-1 truncate">{name}</span>
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); onAssign(name, null) }}
                        onMouseDown={e => e.stopPropagation()}
                        onPointerDown={e => e.stopPropagation()}
                        title="Unassign"
                        className="opacity-0 group-hover/chip:opacity-100 text-gray-400 hover:text-red-500 text-xs leading-none px-0.5 transition-opacity"
                      >
                        ✕
                      </button>
                    </span>
                  )
                })}
              </div>
            </div>
          )
        })}

        {/* Offseason group — derived from roster.offseason flag. Drop targets:
            dropping any chip here sets offseason=true and clears workout
            assignment (athlete appears below). Dragging out into a workout
            group keeps offseason=true and adds the workout on top.
            Untick offseason in the Roster tab to remove entirely. */}
        {(() => {
          const offseasonNames = roster
            .filter(r => r.offseason && !r.inactive && r.name.trim() && !assignedTo[r.name])
            .map(r => r.name)
            .sort((a, b) => a.localeCompare(b))
          const isDragOver = dragOver === '__offseason__'
          return (
            <div
              onDragOver={e => { e.preventDefault(); setDragOver('__offseason__') }}
              onDragLeave={() => setDragOver(null)}
              onDrop={e => {
                e.preventDefault()
                let names: string[] = []
                try { names = JSON.parse(e.dataTransfer.getData('text/plain')) }
                catch { const n = e.dataTransfer.getData('text/plain'); if (n) names = [n] }
                names.forEach(name => { onSetOffseason(name, true); onAssign(name, null) })
                setDragging(new Set())
                setDragOver(null)
              }}
              className={`rounded-xl border-2 p-2.5 flex flex-col gap-1.5 transition-all ${
                isDragOver ? 'border-amber-500 bg-amber-100 shadow-md' : 'border-amber-300 bg-amber-50/60'
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-xs font-bold text-amber-700 uppercase tracking-wide">Offseason</div>
                <div className="text-[10px] text-amber-600">{offseasonNames.length}</div>
              </div>
              <div className="text-[10px] text-amber-700/80 italic">Drop here to mark offseason · drag into a group to assign today.</div>
              <div className="flex flex-col gap-0.5 mt-0.5">
                {offseasonNames.map(name => (
                  <span
                    key={name}
                    draggable
                    onDragStart={e => startDrag(name, e)}
                    onDragEnd={() => setDragging(new Set())}
                    {...chipInteractionProps(name)}
                    className={`${chipClass(name)} w-full group/chip`}
                  >
                    <span className="flex-1 truncate">{name}</span>
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); onSetOffseason(name, false) }}
                      onMouseDown={e => e.stopPropagation()}
                      onPointerDown={e => e.stopPropagation()}
                      title="Remove from offseason"
                      className="opacity-0 group-hover/chip:opacity-100 text-gray-400 hover:text-red-500 text-xs leading-none px-0.5 transition-opacity"
                    >
                      ✕
                    </button>
                  </span>
                ))}
                {offseasonNames.length === 0 && <span className="text-[10px] text-amber-700/60 italic">none</span>}
              </div>
            </div>
          )
        })()}

        {/* Add group card */}
        {showAddGroup ? (
          <div className="rounded-xl border-2 border-blue-300 bg-blue-50 p-3 flex flex-col gap-2 col-span-full max-w-xl">
            <div className="text-xs font-bold text-blue-700 mb-1">New Workout Group</div>

            {/* Basic fields */}
            {(['focus', 'coach'] as const).map(k => (
              <div key={k}>
                <label className="text-[10px] font-semibold text-blue-500 uppercase tracking-wide">
                  {k === 'focus' ? 'Focus / Group Name *' : 'Coach'}
                </label>
                <input
                  value={newGroup[k]}
                  onChange={e => setNewGroup(g => ({ ...g, [k]: e.target.value }))}
                  className="w-full border border-blue-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white mt-0.5"
                />
              </div>
            ))}
            <div>
              <label className="text-[10px] font-semibold text-blue-500 uppercase tracking-wide">Notes</label>
              <textarea
                rows={1}
                value={newGroup.notes}
                onChange={e => {
                  setNewGroup(g => ({ ...g, notes: e.target.value }))
                  const el = e.target; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'
                }}
                onFocus={e => { const el = e.target; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }}
                className="w-full border border-blue-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white mt-0.5 resize-none overflow-hidden"
                placeholder="Visible to athletes on their workout card…"
              />
            </div>

            {/* Warmup / Cooldown (moved below notes) */}

            {/* Warmup / Cooldown */}
            <div className="flex gap-3">
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] font-semibold text-amber-600 uppercase tracking-wide">Warmup</label>
                <input type="number" min="0" value={newGroup.warmup} onChange={e => setNewGroup(g => ({ ...g, warmup: e.target.value }))}
                  placeholder="0" className="w-12 text-xs text-center border border-amber-200 rounded px-1 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-amber-400" />
                <span className="text-xs text-gray-400">min</span>
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] font-semibold text-green-600 uppercase tracking-wide">Cooldown</label>
                <input type="number" min="0" value={newGroup.cooldown} onChange={e => setNewGroup(g => ({ ...g, cooldown: e.target.value }))}
                  placeholder="0" className="w-12 text-xs text-center border border-green-200 rounded px-1 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-green-400" />
                <span className="text-xs text-gray-400">min</span>
              </div>
            </div>

            {/* Segment builder */}
            <div>
              <div className="text-[10px] font-semibold text-blue-600 uppercase tracking-wide mb-1">Segments</div>
              <div className="flex flex-col gap-2">
                {newGroup.segments.map((seg, si) => {
                  const upd = (patch: Partial<WorkoutSegment>) =>
                    setNewGroup(g => ({ ...g, segments: g.segments.map((s, i) => i === si ? { ...s, ...patch } : s) }))
                  return (
                    <div key={seg.id} className="bg-white border border-blue-200 rounded-lg p-2 flex flex-col gap-1.5">
                      <div className="flex items-center gap-1 flex-wrap">
                        {/* qty × distance unit @ pace */}
                        <input value={seg.qty} onChange={e => upd({ qty: e.target.value })}
                          placeholder="4" className="w-8 text-xs text-center border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                        <span className="text-xs text-gray-400">×</span>
                        <input value={seg.distance} onChange={e => upd({ distance: e.target.value })}
                          placeholder="400" className="w-14 text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                        <select value={seg.unit} onChange={e => upd({ unit: e.target.value as DistanceUnit })}
                          className="text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400">
                          {DIST_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                        </select>
                        <span className="text-xs text-gray-400">@</span>
                        <select value={seg.pace} onChange={e => upd({ pace: e.target.value as PaceType })}
                          className="text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400 font-medium text-blue-700">
                          {PACE_TYPES.map(p => <option key={p} value={p}>{p}</option>)}
                        </select>
                        <span className="text-xs text-gray-400 ml-1">rest:</span>
                        <input value={seg.restDuration} onChange={e => upd({ restDuration: e.target.value })}
                          placeholder="90s" className="w-12 text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                        <select value={seg.rest} onChange={e => upd({ rest: e.target.value as RestType })}
                          className="text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400">
                          {REST_TYPES.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <button onClick={() => setNewGroup(g => ({ ...g, segments: g.segments.filter((_, i) => i !== si) }))}
                          className="text-gray-300 hover:text-red-400 text-sm leading-none ml-auto">×</button>
                      </div>
                    </div>
                  )
                })}
              </div>
              <button
                onClick={() => setNewGroup(g => ({ ...g, segments: [...g.segments, { id: segUid(), qty: '1', distance: '', unit: 'meters', pace: '5k', restDuration: '', rest: 'jog' }] }))}
                className="mt-1.5 text-xs text-blue-400 hover:text-blue-600"
              >+ add segment</button>
            </div>

            <div className="flex gap-2 mt-1">
              <button
                onClick={() => {
                  if (!newGroup.focus.trim()) return
                  onAddGroup(newGroup)
                  setNewGroup({ focus: '', coach: '', warmup: '', workout: '', cooldown: '', paceEffort: '', notes: '', segments: [] })
                  setShowAddGroup(false)
                }}
                disabled={!newGroup.focus.trim()}
                className="px-3 py-1 bg-blue-500 text-white rounded text-xs font-semibold hover:bg-blue-600 disabled:opacity-40"
              >Add</button>
              <button
                onClick={() => { setShowAddGroup(false); setNewGroup({ focus: '', coach: '', warmup: '', workout: '', cooldown: '', paceEffort: '', notes: '', segments: [] }) }}
                className="px-3 py-1 text-blue-400 hover:text-blue-600 text-xs"
              >Cancel</button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowAddGroup(true)}
            className="rounded-xl border-2 border-dashed border-gray-200 p-3 text-sm text-gray-400 hover:border-blue-300 hover:text-blue-500 transition-colors text-left"
          >
            + Add workout group
          </button>
        )}
      </div>

      </div>

      {selected.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-full bg-slate-900 text-white px-4 py-2 shadow-xl">
          <span className="text-sm">{selected.size} selected</span>
          <button
            onClick={() => openPicker(Array.from(selected)[0])}
            className="rounded-full bg-blue-500 px-3 py-1 text-xs font-semibold hover:bg-blue-400"
          >
            Move to group…
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-xs text-slate-400 hover:text-white"
          >
            Clear
          </button>
        </div>
      )}

      {picker && (
        <div
          onClick={() => setPicker(null)}
          className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center"
        >
          <div
            onClick={e => e.stopPropagation()}
            className="bg-white rounded-lg shadow-xl w-64 max-h-[70vh] overflow-auto"
          >
            <div className="px-3 py-2 border-b text-xs font-semibold text-gray-600">
              Move {picker.names.length} athlete{picker.names.length > 1 ? 's' : ''} to…
            </div>
            {groups.map(g => (
              <button
                key={g.id}
                onClick={() => {
                  picker.names.forEach(n => onAssign(n, g.focus))
                  setSelected(new Set())
                  setPicker(null)
                }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 border-b border-gray-100 last:border-0"
              >
                {g.focus || <span className="text-gray-400 italic">(no focus)</span>}
              </button>
            ))}
            <button
              onClick={() => {
                picker.names.forEach(n => onAssign(n, null))
                setSelected(new Set())
                setPicker(null)
              }}
              className="w-full text-left px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 border-t"
            >
              Unassigned
            </button>
            <button
              onClick={() => {
                picker.names.forEach(n => { onSetOffseason(n, true); onAssign(n, null) })
                setSelected(new Set())
                setPicker(null)
              }}
              className="w-full text-left px-3 py-2 text-sm text-amber-700 hover:bg-amber-50"
            >
              Offseason
            </button>
            <button
              onClick={() => setPicker(null)}
              className="w-full text-left px-3 py-2 text-xs text-gray-400 hover:bg-gray-50 border-t"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── History Day Editor ───────────────────────────────────────────────────────

type HistoryEditGroup = {
  id: string
  focus: string
  coach: string
  warmup: string
  workout: string
  cooldown: string
  paceEffort: string
  notes: string
  segments: WorkoutSegment[]
  athletesText: string // one name per line
}

function HistoryDayEditor({ date, todayRows }: { date: string; todayRows: EditableWorkoutRow[] }) {
  const [groups, setGroups] = useState<HistoryEditGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAddGroup, setShowAddGroup] = useState(false)
  const [newGroup, setNewGroup] = useState<Omit<HistoryEditGroup, 'id'>>({
    focus: '', coach: '', warmup: '', workout: '', cooldown: '', paceEffort: '', notes: '', segments: [], athletesText: '',
  })

  const dirtyRef = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const groupsRef = useRef(groups)
  groupsRef.current = groups

  useEffect(() => {
    dirtyRef.current = false
    setLoading(true)
    setEditingId(null)
    setSavedAt(null)
    setSaveError(null)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    fetchDayHistory(date).then(g => {
      if (g.length > 0) {
        setGroups(g.map(group => ({
          id: uid(),
          focus: group.focus,
          coach: group.coach,
          warmup: group.warmup,
          workout: group.workout,
          cooldown: group.cooldown,
          paceEffort: group.paceEffort,
          notes: group.notes,
          segments: group.segments,
          athletesText: group.athletes.join('\n'),
        })))
      } else {
        // No history for this date — copy today's workout rows as a starting point
        setGroups(todayRows.map(row => ({
          id: uid(),
          focus: row.focus,
          coach: row.coach,
          warmup: row.warmup,
          workout: row.workout,
          cooldown: row.cooldown,
          paceEffort: row.paceEffort,
          notes: row.notes,
          segments: row.segments,
          athletesText: row.athletesRaw,
        })))
      }
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [date])

  useEffect(() => {
    if (!dirtyRef.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      setSaving(true)
      setSaveError(null)
      try {
        const toSave = groupsRef.current.map(g => ({
          focus: g.focus,
          coach: g.coach,
          warmup: g.warmup,
          workout: g.workout,
          cooldown: g.cooldown,
          paceEffort: g.paceEffort,
          notes: g.notes,
          segments: g.segments,
          athletes: g.athletesText.split('\n').map(n => n.trim()).filter(Boolean),
        }))
        await saveDayHistory(date, toSave)
        setSavedAt(new Date())
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Save failed')
      }
      setSaving(false)
    }, 1500)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [groups, date])

  const updateGroup = (id: string, patch: Partial<HistoryEditGroup>) => {
    dirtyRef.current = true
    setGroups(gs => gs.map(g => g.id === id ? { ...g, ...patch } : g))
  }

  if (loading) return <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">Loading…</div>

  return (
    <div className="flex-1 overflow-auto p-4 bg-slate-50">
      <div className="mb-2 h-4 text-xs">
        {saving && <span className="text-gray-400 animate-pulse">Saving…</span>}
        {!saving && savedAt && !saveError && <span className="text-green-500">Saved {savedAt.toLocaleTimeString()}</span>}
        {saveError && <span className="text-red-400">{saveError}</span>}
      </div>

      {groups.length === 0 && !showAddGroup && (
        <div className="text-center text-gray-400 py-8 text-sm">No workout recorded for this day</div>
      )}

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
        {groups.map(g => {
          const athletes = g.athletesText.split('\n').map(n => n.trim()).filter(Boolean)
          return (
            <div key={g.id} className="rounded-xl border-2 border-gray-200 bg-white p-3">
              <div className="flex items-start justify-between mb-2">
                <div className="min-w-0 flex-1 mr-2">
                  {editingId === g.id ? (
                    <input value={g.focus} onChange={e => updateGroup(g.id, { focus: e.target.value })}
                      className="text-xs font-bold border border-gray-200 rounded px-1 py-0.5 w-full focus:outline-none focus:ring-1 focus:ring-blue-400" />
                  ) : (
                    <div className="text-xs font-bold text-gray-800 leading-tight">{g.focus || '(no focus)'}</div>
                  )}
                  {g.coach && editingId !== g.id && <div className="text-xs text-gray-400 mt-0.5">Coach: {g.coach}</div>}
                </div>
                <button onClick={() => setEditingId(prev => prev === g.id ? null : g.id)}
                  className="text-[10px] text-blue-400 hover:text-blue-600 shrink-0">
                  {editingId === g.id ? 'done' : 'edit'}
                </button>
              </div>

              {editingId === g.id ? (
                <div className="flex flex-col gap-2">
                  <div>
                    <span className="text-[10px] font-semibold text-gray-500 uppercase">Coach</span>
                    <input value={g.coach} onChange={e => updateGroup(g.id, { coach: e.target.value })}
                      className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 mt-0.5" />
                  </div>
                  <div className="flex gap-3">
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] font-semibold text-amber-600 uppercase">WU</span>
                      <input type="number" min="0" value={g.warmup} onChange={e => updateGroup(g.id, { warmup: e.target.value })}
                        className="w-10 text-xs text-center border border-amber-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-amber-400" />
                      <span className="text-xs text-gray-400">min</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] font-semibold text-green-600 uppercase">CD</span>
                      <input type="number" min="0" value={g.cooldown} onChange={e => updateGroup(g.id, { cooldown: e.target.value })}
                        className="w-10 text-xs text-center border border-green-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-green-400" />
                      <span className="text-xs text-gray-400">min</span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {g.segments.map((seg, si) => {
                      const upd = (patch: Partial<WorkoutSegment>) =>
                        updateGroup(g.id, { segments: g.segments.map((s, i) => i === si ? { ...s, ...patch } : s) })
                      return (
                        <div key={seg.id} className="bg-blue-50 border border-blue-100 rounded-lg p-1.5 flex items-center gap-1 flex-wrap">
                          <input value={seg.qty} onChange={e => upd({ qty: e.target.value })} placeholder="4"
                            className="w-7 text-xs text-center border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                          <span className="text-xs text-gray-400">×</span>
                          <input value={seg.distance} onChange={e => upd({ distance: e.target.value })} placeholder="400"
                            className="w-12 text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                          <select value={seg.unit} onChange={e => upd({ unit: e.target.value as DistanceUnit })}
                            className="text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white">
                            {DIST_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                          </select>
                          <span className="text-xs text-gray-400">@</span>
                          <select value={seg.pace} onChange={e => upd({ pace: e.target.value as PaceType })}
                            className="text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white font-medium text-blue-700">
                            {PACE_TYPES.map(p => <option key={p} value={p}>{p}</option>)}
                          </select>
                          <input value={seg.restDuration} onChange={e => upd({ restDuration: e.target.value })} placeholder="90s"
                            className="w-10 text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                          <select value={seg.rest} onChange={e => upd({ rest: e.target.value as RestType })}
                            className="text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white">
                            {REST_TYPES.map(r => <option key={r} value={r}>{r}</option>)}
                          </select>
                          <button onClick={() => updateGroup(g.id, { segments: g.segments.filter((_, i) => i !== si) })}
                            className="text-gray-300 hover:text-red-400 text-sm leading-none ml-auto">×</button>
                        </div>
                      )
                    })}
                  </div>
                  <button onClick={() => updateGroup(g.id, { segments: [...g.segments, { id: segUid(), qty: '1', distance: '', unit: 'meters', pace: '5k', restDuration: '', rest: 'jog' }] })}
                    className="text-xs text-blue-400 hover:text-blue-600">+ add segment</button>
                  <div>
                    <span className="text-[10px] font-semibold text-gray-500 uppercase">Notes</span>
                    <textarea rows={2} value={g.notes} onChange={e => updateGroup(g.id, { notes: e.target.value })}
                      className="w-full mt-0.5 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none" />
                  </div>
                  <div>
                    <span className="text-[10px] font-semibold text-gray-500 uppercase">Athletes (one per line)</span>
                    <textarea rows={3} value={g.athletesText} onChange={e => updateGroup(g.id, { athletesText: e.target.value })}
                      className="w-full mt-0.5 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none font-mono" />
                  </div>
                  <button onClick={() => { dirtyRef.current = true; setGroups(gs => gs.filter(x => x.id !== g.id)) }}
                    className="text-xs text-red-400 hover:text-red-600 text-left">Delete group</button>
                </div>
              ) : (
                <>
                  {(g.warmup || g.cooldown) && (
                    <div className="flex gap-2 text-xs text-gray-400 mb-1">
                      {g.warmup && <span><span className="text-amber-500">WU</span> {g.warmup}min</span>}
                      {g.cooldown && <span><span className="text-green-500">CD</span> {g.cooldown}min</span>}
                    </div>
                  )}
                  {g.segments.length > 0 && (
                    <div className="flex flex-col gap-0.5 mb-1">
                      {g.segments.map(seg => (
                        <div key={seg.id} className="text-xs text-gray-700 bg-blue-50 rounded px-2 py-0.5">
                          <span className="font-medium">{seg.qty}×{seg.distance} {seg.unit}</span>
                          <span className="ml-1.5 text-blue-600 font-medium">@ {seg.pace}</span>
                          {(seg.restDuration && seg.restDuration !== '0') && (
                            <span className="ml-1.5 text-gray-400">· {seg.restDuration} {seg.rest}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {g.notes && <p className="mt-1 text-xs text-gray-500 whitespace-pre-wrap">{g.notes}</p>}
                  <div className="mt-2 flex flex-wrap gap-1">
                    {athletes.sort((a, b) => a.localeCompare(b)).map(name => (
                      <span key={name} className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-white border border-gray-300 text-gray-700">
                        {name}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          )
        })}

        {showAddGroup ? (
          <div className="rounded-xl border-2 border-blue-300 bg-blue-50 p-3 flex flex-col gap-2 col-span-full max-w-xl">
            <div className="text-xs font-bold text-blue-700 mb-1">New Workout Group</div>
            {(['focus', 'coach'] as const).map(k => (
              <div key={k}>
                <label className="text-[10px] font-semibold text-blue-500 uppercase tracking-wide">
                  {k === 'focus' ? 'Focus / Group Name *' : 'Coach'}
                </label>
                <input value={newGroup[k]} onChange={e => setNewGroup(g => ({ ...g, [k]: e.target.value }))}
                  className="w-full border border-blue-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white mt-0.5" />
              </div>
            ))}
            <div>
              <label className="text-[10px] font-semibold text-blue-500 uppercase tracking-wide">Athletes (one per line)</label>
              <textarea rows={3} value={newGroup.athletesText} onChange={e => setNewGroup(g => ({ ...g, athletesText: e.target.value }))}
                className="w-full border border-blue-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white mt-0.5 resize-none font-mono" />
            </div>
            <div>
              <label className="text-[10px] font-semibold text-blue-500 uppercase tracking-wide">Notes</label>
              <textarea rows={2} value={newGroup.notes} onChange={e => setNewGroup(g => ({ ...g, notes: e.target.value }))}
                className="w-full border border-blue-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white mt-0.5 resize-none" />
            </div>
            <div className="flex gap-2 mt-1">
              <button
                onClick={() => {
                  if (!newGroup.focus.trim()) return
                  dirtyRef.current = true; setGroups(gs => [...gs, { ...newGroup, id: uid() }])
                  setNewGroup({ focus: '', coach: '', warmup: '', workout: '', cooldown: '', paceEffort: '', notes: '', segments: [], athletesText: '' })
                  setShowAddGroup(false)
                }}
                disabled={!newGroup.focus.trim()}
                className="px-3 py-1 bg-blue-500 text-white rounded text-xs font-semibold hover:bg-blue-600 disabled:opacity-40"
              >Add</button>
              <button onClick={() => { setShowAddGroup(false); setNewGroup({ focus: '', coach: '', warmup: '', workout: '', cooldown: '', paceEffort: '', notes: '', segments: [], athletesText: '' }) }}
                className="px-3 py-1 text-blue-400 hover:text-blue-600 text-xs">Cancel</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowAddGroup(true)}
            className="rounded-xl border-2 border-dashed border-gray-200 p-3 text-sm text-gray-400 hover:border-blue-300 hover:text-blue-500 transition-colors text-left">
            + Add workout group
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Roster Sheet ────────────────────────────────────────────────────────────

function RosterSheet({
  entries, onEntryAdd, onEntryChange, teamMileage, planTemplates,
}: {
  entries: EditableRosterEntry[]
  onEntryAdd: (name: string) => void
  onEntryChange: (id: string, k: keyof RosterEntry, v: string | boolean | number | null) => void
  teamMileage: Record<string, { currentWeek: number; lastWeek: number }>
  planTemplates: PlanTemplate[]
}) {
  const [showInactive, setShowInactive] = useState(false)
  const [addingName, setAddingName] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [prsIdMap, setPrsIdMap] = useState<Record<string, string>>({})
  const [prsDataMap, setPrsDataMap] = useState<Record<string, AthleticNetPR[]>>({})
  const [featuredEvent, setFeaturedEvent] = useState<string>('')
  // Display-only sort. 'manual' uses the saved sort_order from the DB.
  // Click cycles: manual → asc → desc → manual.
  type SortKey = 'manual' | 'name' | 'target' | 'vdot'
  const [sortKey, setSortKey] = useState<SortKey>('manual')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const cycleSort = (key: Exclude<SortKey, 'manual'>) => {
    if (sortKey !== key) { setSortKey(key); setSortDir('asc'); return }
    if (sortDir === 'asc') { setSortDir('desc'); return }
    setSortKey('manual'); setSortDir('asc')
  }
  const sortGlyph = (key: Exclude<SortKey, 'manual'>) =>
    sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''

  useEffect(() => {
    loadPRsFile().then(file => {
      const idMap: Record<string, string> = {}
      const dataMap: Record<string, AthleticNetPR[]> = {}
      for (const entry of entries) {
        if (entry.name) {
          const id = findAthleteId(file, entry.name)
          if (id) {
            idMap[entry.name] = id
            dataMap[entry.name] = file[id].prs
          }
        }
      }
      setPrsIdMap(idMap)
      setPrsDataMap(dataMap)
    }).catch(() => {})
  }, [entries.map(e => e.name).join(',')])

  // Collect all unique events across all athletes, preserving order of first appearance
  const allEvents = Array.from(
    new Set(Object.values(prsDataMap).flatMap(prs => prs.map(p => p.event)))
  )

  const handleAdd = () => {
    const name = addingName.trim()
    if (!name) return
    onEntryAdd(name)
    setAddingName('')
    setShowAdd(false)
  }

  const COLS: { key: keyof RosterEntry; label: string; width: string }[] = [
    { key: 'name',     label: 'Name',     width: 'w-40' },
    { key: 'target',   label: 'Target',   width: 'w-24' },
    { key: 'vdot',     label: 'VDOT',     width: 'w-20' },
    { key: 'email',    label: 'Email',    width: 'w-56' },
    { key: 'note',     label: 'Note',     width: 'w-48' },
  ]

  return (
    <div className="overflow-auto flex-1 p-4 bg-slate-50">
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="border-collapse text-sm w-full">
          <thead>
            <tr className="bg-gray-100 border-b-2 border-gray-300">
              <th className="border border-gray-200 px-2 py-1.5 text-xs text-gray-400 w-8 text-center">#</th>
              {COLS.map(col => {
                const sortable = col.key === 'name' || col.key === 'target' || col.key === 'vdot'
                if (!sortable) {
                  return (
                    <th key={col.key} className={`border border-gray-200 px-2 py-1.5 text-xs font-semibold text-gray-600 text-left ${col.width}`}>
                      {col.label}
                    </th>
                  )
                }
                return (
                  <th
                    key={col.key}
                    onClick={() => cycleSort(col.key as Exclude<SortKey, 'manual'>)}
                    className={`border border-gray-200 px-2 py-1.5 text-xs font-semibold text-gray-600 text-left cursor-pointer select-none hover:bg-gray-200 ${col.width} ${sortKey === col.key ? 'text-blue-600' : ''}`}
                    title="Click to sort"
                  >
                    {col.label}{sortGlyph(col.key as Exclude<SortKey, 'manual'>)}
                  </th>
                )
              })}
              <th className="border border-gray-200 px-2 py-1 text-left w-36">
                <select
                  value={featuredEvent}
                  onChange={e => setFeaturedEvent(e.target.value)}
                  className="w-full text-xs font-semibold text-gray-600 bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-blue-400 rounded cursor-pointer"
                >
                  <option value="">— PR Event —</option>
                  {allEvents.map(event => (
                    <option key={event} value={event}>{event}</option>
                  ))}
                </select>
              </th>
              <th className="border border-gray-200 px-2 py-1.5 text-xs font-semibold text-gray-600 text-center w-16">Bio Edit</th>
              <th className="border border-gray-200 px-2 py-1.5 text-xs font-semibold text-gray-600 text-center w-20" title="Offseason: athlete sees mileage target + progress instead of a daily workout">Offseason</th>
              <th className="border border-gray-200 px-2 py-1.5 text-xs font-semibold text-gray-600 text-center w-32" title="Weekly plan: which offseason plan template the athlete sees on their card">Plan</th>
              <th className="border border-gray-200 px-2 py-1.5 text-xs font-semibold text-gray-600 text-center w-20" title="Manual Miles: athlete can self-log mileage from their athlete card (last 3 days)">Manual Miles</th>
              <th className="border border-gray-200 px-2 py-1.5 text-xs font-semibold text-gray-600 text-right w-20">This Wk</th>
              <th className="border border-gray-200 px-2 py-1.5 text-xs font-semibold text-gray-600 text-center w-24">Last Login</th>
              <th className="border border-gray-200 px-2 py-1.5 text-xs font-semibold text-gray-600 text-center w-24">Last Strava</th>
              <th className="border border-gray-200 px-2 py-1.5 text-xs font-semibold text-gray-600 text-left w-28">Profile</th>
              <th className="border border-gray-200 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              const active = entries.filter(e => !e.inactive)
              if (sortKey === 'manual') return active
              const dir = sortDir === 'asc' ? 1 : -1
              const cmp = (a: EditableRosterEntry, b: EditableRosterEntry): number => {
                if (sortKey === 'name') return a.name.localeCompare(b.name) * dir
                if (sortKey === 'target') {
                  const av = parseFloat(a.target ?? ''); const bv = parseFloat(b.target ?? '')
                  const an = isFinite(av) ? av : -Infinity
                  const bn = isFinite(bv) ? bv : -Infinity
                  return (an - bn) * dir
                }
                // vdot — falls back to PR-derived for sort ordering when no override
                const vdotFor = (e: EditableRosterEntry) => {
                  if (e.vdot != null && e.vdot > 0) return e.vdot
                  const prs = prsDataMap[e.name]
                  if (!prs) return -Infinity
                  return computeTrainingPaces(prs)?.vdot ?? -Infinity
                }
                return (vdotFor(a) - vdotFor(b)) * dir
              }
              return [...active].sort(cmp)
            })().map((entry, i) => {
              const mark = featuredEvent
                ? (prsDataMap[entry.name]?.find(p => p.event === featuredEvent)?.mark ?? '')
                : ''
              return (
                <tr key={entry.id} className="hover:bg-blue-50/30 group">
                  <td className="border border-gray-200 px-2 py-1 text-xs text-gray-400 text-center">{i + 1}</td>
                  {COLS.map(col => {
                    if (col.key === 'vdot') {
                      const prs = prsDataMap[entry.name]
                      const calculated = prs ? computeTrainingPaces(prs)?.vdot ?? null : null
                      return (
                        <td key={col.key} className="border border-gray-200 p-0 align-top">
                          <VdotCell
                            value={entry.vdot ?? null}
                            calculated={calculated}
                            onCommit={v => onEntryChange(entry.id, 'vdot', v)}
                          />
                        </td>
                      )
                    }
                    return (
                      <td key={col.key} className="border border-gray-200 p-0 align-top">
                        <div className="relative group/cell">
                          <Cell
                            value={(entry[col.key] as string) ?? ''}
                            onChange={v => onEntryChange(entry.id, col.key, v)}
                            multiline={col.key === 'note'}
                          />
                          {col.key === 'name' && entry.name.trim() && (
                            <a
                              href={`/?athlete=${encodeURIComponent(entry.name)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Open athlete page in new tab"
                              className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-300 hover:text-blue-600 opacity-0 group-hover/cell:opacity-100 transition-opacity text-xs leading-none px-1 py-0.5"
                            >↗</a>
                          )}
                        </div>
                      </td>
                    )
                  })}
                  <td className="border border-gray-200 px-2 py-1 text-right w-36">
                    {mark
                      ? <span className="font-mono text-sm font-medium text-navy-700">{mark}</span>
                      : <span className="text-xs text-gray-300">{featuredEvent ? '—' : ''}</span>
                    }
                  </td>
                  <td className="border border-gray-200 px-2 py-1 text-center w-16">
                    <input type="checkbox" checked={!!entry.bioEdit}
                      onChange={e => onEntryChange(entry.id, 'bioEdit', e.target.checked)}
                      className="w-4 h-4 cursor-pointer" />
                  </td>
                  <td className="border border-gray-200 px-2 py-1 text-center w-20">
                    <input type="checkbox" checked={!!entry.offseason}
                      onChange={e => onEntryChange(entry.id, 'offseason', e.target.checked)}
                      className="w-4 h-4 cursor-pointer accent-amber-600" />
                  </td>
                  <td className="border border-gray-200 p-0 align-middle w-32">
                    <select
                      value={entry.planTemplateId ?? ''}
                      onChange={e => onEntryChange(entry.id, 'planTemplateId', e.target.value || null)}
                      className="w-full bg-transparent border-0 outline-none focus:bg-blue-50 text-xs px-1 py-1"
                    >
                      <option value="">—</option>
                      {planTemplates.map(t => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="border border-gray-200 px-2 py-1 text-center w-20">
                    <input type="checkbox" checked={!!entry.manualMileage}
                      onChange={e => onEntryChange(entry.id, 'manualMileage', e.target.checked)}
                      className="w-4 h-4 cursor-pointer accent-blue-600" />
                  </td>
                  <td className="border border-gray-200 px-2 py-1 text-right w-20">
                    {teamMileage[entry.name]
                      ? <span className="font-mono text-xs text-orange-600">{teamMileage[entry.name].currentWeek} mi</span>
                      : <span className="text-xs text-gray-300">—</span>}
                  </td>
                  <td className="border border-gray-200 px-2 py-1 text-center w-24">
                    <span className="text-xs text-gray-500" title={entry.lastLoginAt ?? ''}>{timeAgo(entry.lastLoginAt)}</span>
                  </td>
                  <td className="border border-gray-200 px-2 py-1 text-center w-24">
                    <span className="text-xs text-gray-500" title={entry.lastStravaAt ?? ''}>{timeAgo(entry.lastStravaAt)}</span>
                  </td>
                  <td className="border border-gray-200 px-2 py-1 text-center w-28">
                    {(() => {
                      const id = entry.athleticNetId || prsIdMap[entry.name]
                      return id ? (
                        <a href={`https://www.athletic.net/athlete/${id}/track-and-field`}
                          target="_blank" rel="noopener noreferrer"
                          className="text-xs text-blue-500 hover:underline">View profile</a>
                      ) : <span className="text-xs text-gray-300">—</span>
                    })()}
                  </td>
                  <td className="border border-gray-200 text-center">
                    <button onClick={() => onEntryChange(entry.id, 'inactive', true)}
                      title="Move to inactive"
                      className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-gray-500 px-1 text-sm leading-none transition-opacity">▾</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="px-3 py-2 border-t border-gray-200">
          {showAdd ? (
            <div className="flex items-center gap-2">
              <input autoFocus value={addingName} onChange={e => setAddingName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setShowAdd(false) }}
                placeholder="Athlete name..."
                className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
              <button onClick={handleAdd} className="px-3 py-1.5 bg-blue-500 text-white rounded-lg text-sm hover:bg-blue-600">Add</button>
              <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 text-gray-400 hover:text-gray-600 text-sm">Cancel</button>
            </div>
          ) : (
            <button onClick={() => setShowAdd(true)} className="text-sm text-gray-400 hover:text-gray-600">
              + Add athlete
            </button>
          )}
        </div>
      </div>

      {/* Inactive section */}
      {entries.some(e => e.inactive) && (
        <div className="mt-4 bg-white rounded-xl border border-gray-200 overflow-hidden">
          <button
            onClick={() => setShowInactive(v => !v)}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-gray-500 hover:bg-gray-50 transition-colors"
          >
            <span className="transition-transform" style={{ display: 'inline-block', transform: showInactive ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
            Inactive ({entries.filter(e => e.inactive).length})
          </button>
          {showInactive && (
            <table className="border-collapse text-sm w-full border-t border-gray-200">
              <tbody>
                {entries.filter(e => e.inactive).map(entry => (
                  <tr key={entry.id} className="hover:bg-gray-50 group">
                    <td className="border border-gray-200 px-3 py-1.5 text-sm text-gray-400">{entry.name}</td>
                    <td className="border border-gray-200 px-3 py-1.5 text-xs text-gray-400">{entry.group}</td>
                    <td className="border border-gray-200 px-3 py-1.5 text-xs text-gray-400">{entry.note}</td>
                    <td className="border border-gray-200 px-2 py-1 text-center w-20">
                      <button
                        onClick={() => onEntryChange(entry.id, 'inactive', false)}
                        className="opacity-0 group-hover:opacity-100 text-xs text-blue-500 hover:text-blue-700 transition-opacity px-2 py-0.5 rounded border border-blue-300 hover:border-blue-500"
                      >
                        Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Plans Tab ────────────────────────────────────────────────────────────────
// Library of weekly offseason plan templates. Each template has 7 days; each
// day cell is two lines (top: miles or Rest or short note; bottom: workout
// segments or a free-text fallback). The Roster tab assigns one template per
// athlete; offseason athletes see their week on the athlete card.

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function emptyPlanDay(): PlanDay {
  return { miles: null, isRest: false, notes: '', segments: [], extra: '' }
}

// Plan-template IDs are persisted as Postgres uuid (see offseason_plan_templates
// schema), so the client-side uid() generator (Math.random base-36) won't do —
// crypto.randomUUID is required. Duplicate-row uses this too.
function planTemplateUuid(): string {
  return crypto.randomUUID()
}

function blankPlanTemplate(): PlanTemplate {
  return {
    id: planTemplateUuid(),
    label: '',
    description: '',
    sortOrder: 0,
    weeklyMiles: null,
    tempoMinutes: null,
    days: Array.from({ length: 7 }, emptyPlanDay),
  }
}

// Sum mileage across a template's 7 days. Rest days and notes-only days
// contribute 0; only the numeric `miles` field counts.
function weeklyMilesFromDays(days: PlanDay[]): number {
  let total = 0
  for (const d of days) {
    if (d.isRest) continue
    if (typeof d.miles === 'number' && isFinite(d.miles)) total += d.miles
  }
  return Math.round(total * 10) / 10
}

// Sum tempo minutes for a single day from structured workout segments only.
// A segment counts when pace is "tempo" and unit is "minutes" — contributes
// qty × distance. Free-text extras (e.g. "4x5 tempo") are ignored; the
// coach has to structure the workout for it to count.
function tempoMinutesFromDay(d: PlanDay): number {
  let mins = 0
  for (const seg of d.segments) {
    if (seg.pace !== 'tempo' || seg.unit !== 'minutes') continue
    const qty = parseFloat(seg.qty) || 0
    const dist = parseFloat(seg.distance) || 0
    mins += qty * dist
  }
  return mins
}

function tempoMinutesFromDays(days: PlanDay[]): number {
  return Math.round(days.reduce((sum, d) => sum + tempoMinutesFromDay(d), 0) * 10) / 10
}

function PlansTab({ templates, onChange }: { templates: PlanTemplate[]; onChange: (t: PlanTemplate[]) => void }) {
  const [editing, setEditing] = useState<{ templateId: string; dayIndex: number } | null>(null)
  const [clipboard, setClipboard] = useState<PlanDay | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; templateId: string; dayIndex: number } | null>(null)
  // Row-level context menu (right-click on the grab bar). Separate from
  // `ctxMenu` which targets a single day cell.
  const [rowCtxMenu, setRowCtxMenu] = useState<{ x: number; y: number; templateId: string } | null>(null)

  // Dismiss either context menu on any outside left-click. Menus stopPropagation
  // on inner clicks. Right-clicking a different cell/row updates the relevant
  // state to replace the menu in place.
  useEffect(() => {
    if (!ctxMenu && !rowCtxMenu) return
    const close = () => { setCtxMenu(null); setRowCtxMenu(null) }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [ctxMenu, rowCtxMenu])
  // Drag state for row reorder. dragId = the row being picked up; dragOverId = the row hovered.
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  // Reorder so the moved template lands just before `targetId`. saveplanTemplates
  // writes array index as sort_order, so the new order persists across sessions.
  const reorderTemplate = (fromId: string, targetId: string) => {
    if (fromId === targetId) return
    const from = templates.findIndex(t => t.id === fromId)
    const to = templates.findIndex(t => t.id === targetId)
    if (from === -1 || to === -1) return
    const next = [...templates]
    const [moved] = next.splice(from, 1)
    // If we removed an item earlier in the array, the target index has shifted left by one
    const insertAt = from < to ? to - 1 : to
    next.splice(insertAt, 0, moved)
    onChange(next)
  }

  const copyCell = (day: PlanDay) => setClipboard(JSON.parse(JSON.stringify(day)))
  const pasteCell = (templateId: string, dayIndex: number) => {
    if (!clipboard) return
    const fresh: PlanDay = { ...clipboard, segments: clipboard.segments.map(s => ({ ...s, id: segUid() })) }
    updateDay(templateId, dayIndex, fresh)
  }

  const update = (id: string, patch: Partial<PlanTemplate>) => {
    onChange(templates.map(t => t.id === id ? { ...t, ...patch } : t))
  }
  const updateDay = (id: string, dayIndex: number, patch: Partial<PlanDay>) => {
    onChange(templates.map(t => {
      if (t.id !== id) return t
      const days = t.days.map((d, i) => i === dayIndex ? { ...d, ...patch } : d)
      // Auto-recompute weekly + tempo totals so OffseasonCard and any other
      // consumer that reads the stored numbers stays in sync with the grid.
      const wm = weeklyMilesFromDays(days)
      const tm = tempoMinutesFromDays(days)
      return {
        ...t,
        days,
        weeklyMiles: wm > 0 ? wm : null,
        tempoMinutes: tm > 0 ? tm : null,
      }
    }))
  }
  const addTemplate = () => onChange([...templates, blankPlanTemplate()])
  const removeTemplate = (id: string) => {
    if (!confirm('Delete this plan template? Athletes assigned to it will lose their plan.')) return
    onChange(templates.filter(t => t.id !== id))
  }
  const duplicateTemplate = (id: string) => {
    const t = templates.find(x => x.id === id)
    if (!t) return
    const copy: PlanTemplate = { ...t, id: planTemplateUuid(), label: `${t.label} (copy)`, days: t.days.map(d => ({ ...d, segments: d.segments.map(s => ({ ...s, id: segUid() })) })) }
    onChange([...templates, copy])
  }

  const editingTemplate = editing ? templates.find(t => t.id === editing.templateId) : null
  const editingDay = editing && editingTemplate ? editingTemplate.days[editing.dayIndex] : null

  return (
    <div className="flex-1 overflow-auto p-4 bg-slate-50">
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="border-collapse text-xs w-full">
          <thead>
            <tr className="bg-gray-100 border-b-2 border-gray-300">
              <th className="border border-gray-200 w-6" title="Drag to reorder"></th>
              <th className="border border-gray-200 px-2 py-1.5 text-xs font-semibold text-gray-600 text-left w-32">Label</th>
              {DAY_LABELS.map(d => (
                <th key={d} className="border border-gray-200 px-2 py-1.5 text-xs font-semibold text-gray-600 text-left">{d}</th>
              ))}
              <th className="border border-gray-200 px-2 py-1.5 text-xs font-semibold text-gray-600 text-right w-16">Total</th>
              <th className="border border-gray-200 px-2 py-1.5 text-xs font-semibold text-gray-600 text-right w-16">Tempo</th>
              <th className="border border-gray-200 w-12"></th>
            </tr>
          </thead>
          <tbody>
            {templates.map(t => (
              <tr
                key={t.id}
                onDragOver={e => {
                  // Only act on plan-row drags so cell text drags don't trigger reorder
                  if (Array.from(e.dataTransfer.types).includes('plan-row-id')) {
                    e.preventDefault()
                    setDragOverId(t.id)
                  }
                }}
                onDragLeave={e => {
                  // Only clear if leaving this row entirely (not a child element)
                  if (e.currentTarget === e.target) setDragOverId(null)
                }}
                onDrop={e => {
                  const fromId = e.dataTransfer.getData('plan-row-id')
                  if (fromId) {
                    e.preventDefault()
                    reorderTemplate(fromId, t.id)
                  }
                  setDragId(null)
                  setDragOverId(null)
                }}
                className={`group align-top transition-colors ${
                  dragOverId === t.id && dragId !== t.id ? 'bg-blue-100'
                  : dragId === t.id ? 'opacity-40'
                  : 'hover:bg-blue-50/20'
                }`}
              >
                <td
                  draggable
                  onDragStart={e => {
                    e.dataTransfer.setData('plan-row-id', t.id)
                    e.dataTransfer.effectAllowed = 'move'
                    setDragId(t.id)
                  }}
                  onDragEnd={() => { setDragId(null); setDragOverId(null) }}
                  onContextMenu={e => { e.preventDefault(); setRowCtxMenu({ x: e.clientX, y: e.clientY, templateId: t.id }) }}
                  className="border border-gray-200 w-6 text-center align-middle cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-600 select-none"
                  title="Drag to reorder · right-click for menu"
                >
                  ⋮⋮
                </td>
                <td className="border border-gray-200 p-0 align-top">
                  <div className="flex flex-col">
                    <input
                      value={t.label}
                      placeholder="Label (e.g. 20A)"
                      onChange={e => update(t.id, { label: e.target.value })}
                      className="bg-transparent border-0 outline-none focus:bg-blue-50 px-2 py-1 text-sm font-semibold"
                    />
                    <input
                      value={t.description}
                      placeholder="Description"
                      onChange={e => update(t.id, { description: e.target.value })}
                      className="bg-transparent border-0 outline-none focus:bg-blue-50 px-2 py-0.5 text-[10px] text-gray-500"
                    />
                  </div>
                </td>
                {t.days.map((d, i) => (
                  <td
                    key={i}
                    onClick={() => setEditing({ templateId: t.id, dayIndex: i })}
                    onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, templateId: t.id, dayIndex: i }) }}
                    className="border border-gray-200 px-1.5 py-1 align-top cursor-pointer hover:bg-blue-50 min-w-[100px]"
                  >
                    <div className="font-mono text-xs text-navy-900 leading-tight">
                      {d.isRest ? <span className="text-gray-400">Rest</span>
                        : d.miles != null ? <span>{d.miles}</span>
                        : d.notes ? <span className="text-gray-700">{d.notes}</span>
                        : <span className="text-gray-300">·</span>}
                    </div>
                    <div className="text-[10px] text-blue-700 leading-tight mt-0.5 truncate">
                      {d.segments.length > 0
                        ? d.segments.map(s => `${s.qty}×${s.distance}${s.unit === 'minutes' ? 'min' : s.unit === 'miles' ? 'mi' : 'm'} @ ${s.pace}`).join(' · ')
                        : d.extra
                          ? <span className="text-gray-500">{d.extra}</span>
                          : null}
                    </div>
                  </td>
                ))}
                <td className="border border-gray-200 px-2 py-1 text-xs text-right font-mono text-gray-700 align-top" title="Sum of day miles">
                  {(() => { const m = weeklyMilesFromDays(t.days); return m > 0 ? m : <span className="text-gray-300">—</span> })()}
                </td>
                <td className="border border-gray-200 px-2 py-1 text-xs text-right font-mono text-gray-700 align-top" title="Sum of tempo minutes from each day (structured segments + free-text)">
                  {(() => { const m = tempoMinutesFromDays(t.days); return m > 0 ? m : <span className="text-gray-300">—</span> })()}
                </td>
                <td className="border border-gray-200 align-top">
                  <div className="flex flex-col gap-0.5 px-1 py-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => duplicateTemplate(t.id)} title="Duplicate" className="text-[10px] text-gray-400 hover:text-gray-700">⧉</button>
                    <button onClick={() => removeTemplate(t.id)} title="Delete" className="text-[10px] text-gray-300 hover:text-red-500">✕</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="px-3 py-2 border-t border-gray-200">
          <button onClick={addTemplate} className="text-sm text-gray-400 hover:text-gray-600">+ Add weekly plan</button>
        </div>
      </div>

      {editing && editingTemplate && editingDay && (
        <PlanDayEditor
          template={editingTemplate}
          dayIndex={editing.dayIndex}
          day={editingDay}
          onChange={patch => updateDay(editing.templateId, editing.dayIndex, patch)}
          onClose={() => setEditing(null)}
        />
      )}

      {ctxMenu && (
        <div
          style={{ position: 'fixed', top: ctxMenu.y, left: ctxMenu.x, zIndex: 9999 }}
          className="bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[130px]"
          onClick={e => e.stopPropagation()}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={() => { copyCell(templates.find(t => t.id === ctxMenu.templateId)!.days[ctxMenu.dayIndex]); setCtxMenu(null) }}
          >Copy cell</button>
          <button
            className={`w-full text-left px-3 py-1.5 text-sm ${clipboard ? 'hover:bg-gray-50' : 'text-gray-300 cursor-default'}`}
            onClick={() => { if (clipboard) { pasteCell(ctxMenu.templateId, ctxMenu.dayIndex); setCtxMenu(null) } }}
          >Paste cell</button>
          <div className="border-t border-gray-100 my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={() => { setEditing({ templateId: ctxMenu.templateId, dayIndex: ctxMenu.dayIndex }); setCtxMenu(null) }}
          >Edit…</button>
        </div>
      )}

      {rowCtxMenu && (
        <div
          style={{ position: 'fixed', top: rowCtxMenu.y, left: rowCtxMenu.x, zIndex: 9999 }}
          className="bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[150px]"
          onClick={e => e.stopPropagation()}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={() => { duplicateTemplate(rowCtxMenu.templateId); setRowCtxMenu(null) }}
          >Duplicate row</button>
          <div className="border-t border-gray-100 my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
            onClick={() => { removeTemplate(rowCtxMenu.templateId); setRowCtxMenu(null) }}
          >Delete row…</button>
        </div>
      )}
    </div>
  )
}

function PlanDayEditor({
  template, dayIndex, day, onChange, onClose,
}: {
  template: PlanTemplate
  dayIndex: number
  day: PlanDay
  onChange: (patch: Partial<PlanDay>) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-[520px] max-w-[95vw] bg-white rounded-xl shadow-xl border border-gray-200 p-5 max-h-[90vh] overflow-auto">
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <div className="text-xs text-gray-500">{template.label || '(template)'}</div>
            <div className="text-base font-semibold text-gray-900">{DAY_LABELS[dayIndex]}</div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-sm">close</button>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <label className="text-xs text-gray-500 w-20">Miles</label>
            <input
              type="number"
              step="0.1"
              value={day.miles ?? ''}
              disabled={day.isRest}
              onChange={e => onChange({ miles: e.target.value === '' ? null : Number(e.target.value) })}
              className="flex-1 max-w-[8rem] border border-gray-300 rounded px-2 py-1 text-sm font-mono disabled:bg-gray-50 disabled:text-gray-400"
            />
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              <input type="checkbox" checked={day.isRest} onChange={e => onChange({ isRest: e.target.checked, miles: e.target.checked ? null : day.miles })} className="w-4 h-4 cursor-pointer" />
              Rest
            </label>
          </div>

          <div className="flex items-start gap-3">
            <label className="text-xs text-gray-500 w-20 pt-1.5">Top note</label>
            <input
              value={day.notes}
              onChange={e => onChange({ notes: e.target.value })}
              placeholder="(optional — overrides Miles label, e.g. '30 min 4 run 1 walk')"
              className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm"
            />
          </div>

          <div className="pt-2 border-t border-gray-100">
            <div className="text-xs text-gray-500 mb-1">Workout segments</div>
            {day.segments.map((seg, si) => {
              const upd = (patch: Partial<WorkoutSegment>) => onChange({ segments: day.segments.map((s, i) => i === si ? { ...s, ...patch } : s) })
              return (
                <div key={seg.id} className="bg-blue-50 border border-blue-100 rounded-lg p-1.5 flex items-center gap-1 flex-wrap mb-1.5">
                  <input value={seg.qty} onChange={e => upd({ qty: e.target.value })} placeholder="4" className="w-7 text-xs text-center border border-gray-200 rounded px-1 py-0.5" />
                  <span className="text-xs text-gray-400">×</span>
                  <input value={seg.distance} onChange={e => upd({ distance: e.target.value })} placeholder="5" className="w-12 text-xs border border-gray-200 rounded px-1 py-0.5" />
                  <select value={seg.unit} onChange={e => upd({ unit: e.target.value as DistanceUnit })} className="text-xs border border-gray-200 rounded px-1 py-0.5 bg-white">
                    {DIST_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                  <span className="text-xs text-gray-400">@</span>
                  <select value={seg.pace} onChange={e => upd({ pace: e.target.value as PaceType })} className="text-xs border border-gray-200 rounded px-1 py-0.5 bg-white text-blue-700 font-medium">
                    {PACE_TYPES.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <input value={seg.restDuration} onChange={e => upd({ restDuration: e.target.value })} placeholder="90s" className="w-12 text-xs border border-gray-200 rounded px-1 py-0.5" />
                  <select value={seg.rest} onChange={e => upd({ rest: e.target.value as RestType })} className="text-xs border border-gray-200 rounded px-1 py-0.5 bg-white">
                    {REST_TYPES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <button onClick={() => onChange({ segments: day.segments.filter((_, i) => i !== si) })} className="text-gray-300 hover:text-red-400 text-sm ml-auto">×</button>
                </div>
              )
            })}
            <button
              onClick={() => onChange({ segments: [...day.segments, { id: segUid(), qty: '1', distance: '', unit: 'minutes', pace: 'tempo', restDuration: '', rest: 'jog' }] })}
              className="text-xs text-blue-500 hover:text-blue-700"
            >+ add segment</button>
          </div>

          <div className="flex items-start gap-3 pt-2 border-t border-gray-100">
            <label className="text-xs text-gray-500 w-20 pt-1.5" title="Used when segments are empty (e.g. legacy data like '2 strides')">Free-text</label>
            <input
              value={day.extra}
              onChange={e => onChange({ extra: e.target.value })}
              placeholder="(optional fallback — e.g. '2 strides')"
              className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────
// Coach-editable team-wide settings. Currently:
//   - Timezone: drives every calendar-day date math (UTC was the wrong default;
//     evening-PT entries landed on the next UTC date — see CLAUDE.md gotchas)
//   - Video of the day: label + URL shown on the athlete card
// Auto-saves through the dashboard's debounced save pipeline.
type SettingsValue = { timezone: string; videoLabel: string; videoUrl: string; coaches: string[] }

// Common zones first, then everything `Intl` reports. Most coaches won't need
// to scroll past the top group; the full list is there for future generic
// deployments outside the US.
const COMMON_TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
]
function allTimezones(): string[] {
  // @ts-expect-error supportedValuesOf is ES2022 / not in older lib targets
  if (typeof Intl.supportedValuesOf === 'function') {
    // @ts-expect-error see above
    return Intl.supportedValuesOf('timeZone') as string[]
  }
  return COMMON_TIMEZONES
}

function SettingsTab({ value, onChange, currentEmail }: { value: SettingsValue; onChange: (v: SettingsValue) => void; currentEmail: string | null }) {
  const all = useMemo(() => allTimezones(), [])
  const rest = useMemo(() => all.filter(z => !COMMON_TIMEZONES.includes(z)).sort(), [all])
  const tzNow = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(undefined, { timeZone: value.timezone, timeStyle: 'medium', dateStyle: 'medium' }).format(new Date())
    } catch { return '(invalid)' }
  }, [value.timezone])
  const patch = (p: Partial<SettingsValue>) => onChange({ ...value, ...p })

  const [newCoach, setNewCoach] = useState('')
  const currentLower = (currentEmail ?? '').trim().toLowerCase()
  const envList = useMemo(() => envCoaches(), [])
  // DB coaches that aren't already granted via the env var (those are shown
  // separately, read-only, so we don't list them twice).
  const dbOnly = value.coaches.filter(c => !envList.includes(c.toLowerCase()))
  const addCoach = () => {
    const email = newCoach.trim().toLowerCase()
    if (!email || !email.includes('@')) return
    if (envList.includes(email) || value.coaches.some(c => c.toLowerCase() === email)) { setNewCoach(''); return }
    patch({ coaches: [...value.coaches, email] })
    setNewCoach('')
  }
  const removeCoach = (email: string) => {
    patch({ coaches: value.coaches.filter(c => c.toLowerCase() !== email.toLowerCase()) })
  }

  return (
    <div className="flex-1 overflow-auto p-6 bg-slate-50">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Coaches */}
        <section className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900">Coaches</h3>
          <p className="text-xs text-gray-500 mt-0.5 mb-3">
            Google accounts allowed into the coach dashboard. Add a coach's email below; they sign in with Google to get access.
          </p>
          {envList.length > 0 && (
            <div className="mb-3">
              <p className="text-xs font-medium text-gray-500 mb-1">From environment config (read-only)</p>
              <div className="space-y-2">
                {envList.map(email => (
                  <div key={email} className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-slate-50 px-3 py-2">
                    <span className="text-sm text-gray-600 font-mono truncate">{email}{email === currentLower && <span className="ml-2 text-xs text-gray-400">(you)</span>}</span>
                    <span className="text-xs text-gray-400">env var</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-2">
            {dbOnly.length === 0 ? (
              <p className="text-xs text-gray-400 italic">No coaches added here yet.</p>
            ) : dbOnly.map(email => {
              const isSelf = email.toLowerCase() === currentLower
              return (
                <div key={email} className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2">
                  <span className="text-sm text-gray-800 font-mono truncate">{email}{isSelf && <span className="ml-2 text-xs text-gray-400">(you)</span>}</span>
                  <button
                    onClick={() => removeCoach(email)}
                    disabled={isSelf}
                    title={isSelf ? "You can't remove yourself" : 'Remove coach'}
                    className="text-xs text-red-500 hover:text-red-700 disabled:text-gray-300 disabled:cursor-not-allowed"
                  >
                    Remove
                  </button>
                </div>
              )
            })}
          </div>
          <div className="mt-3 flex gap-2">
            <input
              type="email"
              value={newCoach}
              onChange={e => setNewCoach(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCoach() } }}
              placeholder="coach@school.org"
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            <button
              onClick={addCoach}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
            >
              Add
            </button>
          </div>
        </section>

        {/* Timezone */}
        <section className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900">Timezone</h3>
          <p className="text-xs text-gray-500 mt-0.5 mb-3">
            Used for all calendar-day math — manual mileage entries, weekly totals, "today/yesterday" labels.
          </p>
          <select
            value={value.timezone}
            onChange={e => patch({ timezone: e.target.value })}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            <optgroup label="Common">
              {COMMON_TIMEZONES.map(z => <option key={z} value={z}>{z}</option>)}
            </optgroup>
            <optgroup label="All">
              {rest.map(z => <option key={z} value={z}>{z}</option>)}
            </optgroup>
          </select>
          <div className="mt-2 text-xs text-gray-500 font-mono">Current time there: {tzNow}</div>
        </section>

        {/* Video of the day */}
        <section className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-base font-semibold text-gray-900">Video of the day</h3>
          <p className="text-xs text-gray-500 mt-0.5 mb-3">
            Shown at the bottom of the athlete workout card. Paste a YouTube or video link.
          </p>
          <div className="space-y-3">
            <label className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">Label</span>
              <input
                value={value.videoLabel}
                onChange={e => patch({ videoLabel: e.target.value })}
                placeholder='e.g. "Pre-meet hydration"'
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-600 mb-1">URL</span>
              <input
                value={value.videoUrl}
                onChange={e => patch({ videoUrl: e.target.value })}
                placeholder="https://youtu.be/…"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 font-mono"
              />
            </label>
          </div>
        </section>
      </div>
    </div>
  )
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export function CoachDashboard({
  user, data, onBack, onSaved, onSignOut,
}: {
  user: User; data: SheetData; onBack: () => void; onSaved: () => void; onSignOut: () => void
}) {
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(window.location.search).get('tab') as Tab | null
    return (['workouts', 'roster', 'mileage', 'weekly', 'plans', 'settings'] as Tab[]).includes(t as Tab) ? t! : 'workouts'
  })
  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const [workoutDate, setWorkoutDate] = useState<string>(todayStr)
  const isToday = workoutDate === todayStr

  const prevDay = () => setWorkoutDate(d => {
    const dt = new Date(d + 'T12:00:00'); dt.setDate(dt.getDate() - 1); return dt.toISOString().slice(0, 10)
  })
  const nextDay = () => setWorkoutDate(d => {
    const dt = new Date(d + 'T12:00:00'); dt.setDate(dt.getDate() + 1); return dt.toISOString().slice(0, 10)
  })
  const fmtWorkoutDate = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  const [mileageRefreshKey, setMileageRefreshKey] = useState(0)

  const navigateTab = (t: Tab) => {
    const params = new URLSearchParams(window.location.search)
    params.set('view', 'coach-dashboard')
    params.set('tab', t)
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
    setTab(t)
  }

  const [workoutRows, setWorkoutRows] = useState<EditableWorkoutRow[]>(
    data.workoutRows.map(r => ({ ...r, id: (r as any).id ?? uid() }))
  )
  const [roster, setRoster] = useState<EditableRosterEntry[]>(
    data.roster.map(r => ({ ...r, id: (r as any).id ?? uid() }))
  )
  const [planTemplates, setPlanTemplates] = useState<PlanTemplate[]>(data.planTemplates)
  // Coach-editable settings (Settings tab). Other settings fields like
  // pre/post-run routine and publishStatus are preserved as-is from data.
  const [settings, setSettings] = useState({
    timezone: data.timezone || 'America/Los_Angeles',
    videoLabel: data.videoLabel ?? '',
    videoUrl: data.videoUrl ?? '',
    coaches: data.coaches ?? [],
  })

  // Custom athlete order (persisted in localStorage)
  const [customOrder, setCustomOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('xctf-athlete-order')
      return saved ? JSON.parse(saved) : []
    } catch { return [] }
  })
  const applyOrder = useCallback((entries: EditableRosterEntry[]) => {
    if (customOrder.length === 0) {
      // Default: VDOT descending (fastest first). Falls back to the roster
      // override; athletes with no VDOT sort to the bottom, alphabetical.
      return [...entries].sort((a, b) => {
        const av = a.vdot ?? -Infinity
        const bv = b.vdot ?? -Infinity
        if (av !== bv) return bv - av
        return a.name.localeCompare(b.name)
      })
    }
    return [...entries].sort((a, b) => {
      const ai = customOrder.indexOf(a.name)
      const bi = customOrder.indexOf(b.name)
      if (ai === -1 && bi === -1) return 0
      if (ai === -1) return 1
      if (bi === -1) return -1
      return ai - bi
    })
  }, [customOrder])
  const reorderAthlete = useCallback((fromName: string, toName: string) => {
    const names = applyOrder(roster).map(r => r.name)
    const fromIdx = names.indexOf(fromName)
    const toIdx = names.indexOf(toName)
    if (fromIdx === -1 || toIdx === -1) return
    names.splice(fromIdx, 1)
    names.splice(toIdx, 0, fromName)
    setCustomOrder(names)
    try { localStorage.setItem('xctf-athlete-order', JSON.stringify(names)) } catch {}
  }, [roster, applyOrder])

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [stravaSync, setStravaSync] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle')
  const [stravaSyncMsg, setStravaSyncMsg] = useState('')

  const handleStravaSync = async () => {
    setStravaSync('syncing')
    setStravaSyncMsg('')
    try {
      const r = await fetch('/api/strava/team-sync', { method: 'POST' })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error ?? 'Sync failed')
      const errCount = data.errors?.length ?? 0
      setStravaSyncMsg(`${data.synced} activities · ${data.athletes} athletes${errCount ? ` · ${errCount} errors` : ''}`)
      setStravaSync('done')
      setMileageRefreshKey(k => k + 1)
    } catch (err: any) {
      setStravaSyncMsg(err.message)
      setStravaSync('error')
    }
  }

  const [teamMileage, setTeamMileage] = useState<Record<string, { currentWeek: number; lastWeek: number }>>({})
  useEffect(() => {
    fetch('/api/team-mileage').then(r => r.json()).then(setTeamMileage).catch(() => {})
  }, [])

  // Auto-save refs
  const workoutRowsRef = useRef(workoutRows)
  workoutRowsRef.current = workoutRows
  const rosterRef = useRef(roster)
  rosterRef.current = roster
  const planTemplatesRef = useRef(planTemplates)
  planTemplatesRef.current = planTemplates
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(false)
  // Snapshot of each slice as last persisted. Auto-save only writes slices that
  // actually changed — without this, editing a plan template (or anything) would
  // trigger a full destructive saveRoster from possibly-stale in-memory state,
  // clobbering plan assignments this tab doesn't know about (see saveRoster).
  const savedSnapshot = useRef<{ workouts: string; roster: string; plans: string; settings: string } | null>(null)
  // The roster as last loaded/saved — the baseline saveRoster diffs against so
  // it only writes rows that actually changed (see saveRoster).
  const savedRoster = useRef<EditableRosterEntry[]>(roster)

  const handleWorkoutChange = (id: string, k: keyof WorkoutRow, v: string | WorkoutSegment[]) =>
    setWorkoutRows(rows => rows.map(r => r.id === id ? { ...r, [k]: v } : r))

  const handleReorderGroups = (fromId: string, toId: string) => {
    setWorkoutRows(rows => {
      const from = rows.findIndex(r => r.id === fromId)
      const to = rows.findIndex(r => r.id === toId)
      if (from < 0 || to < 0) return rows
      const next = [...rows]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  const handleAddWorkoutFromForm = (row: Omit<EditableWorkoutRow, 'id' | 'athletesRaw'>) => {
    setWorkoutRows(rows => [...rows, { id: uid(), athletesRaw: '', ...row }])
  }

  const handleDeleteGroup = (id: string) => {
    // Unassign athletes in that group before deleting
    const row = workoutRows.find(r => r.id === id)
    if (row) {
      const names = row.athletesRaw.split('\n').map(n => n.trim()).filter(Boolean)
      setRoster(entries => entries.map(e => names.includes(e.name.trim()) ? { ...e, group: '' } : e))
    }
    setWorkoutRows(rows => rows.filter(r => r.id !== id))
  }

  const handleDuplicateGroup = (id: string) => {
    const src = workoutRows.find(r => r.id === id)
    if (!src) return

    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const suffixMatch = src.focus.match(/^(.*) ([A-Z])$/)
    const baseName = suffixMatch ? suffixMatch[1] : src.focus
    const currentLetter = suffixMatch ? suffixMatch[2] : null

    // Find next unused letter for this base name
    const usedLetters = workoutRows
      .map(r => r.focus.match(new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ([A-Z])$`))?.[1])
      .filter(Boolean) as string[]

    const startIdx = currentLetter ? letters.indexOf(currentLetter) + 1 : 1 // if no suffix, new gets B (idx 1)
    const nextLetter = letters.split('').slice(startIdx).find(l => !usedLetters.includes(l)) ?? letters[startIdx]

    setWorkoutRows(rows => {
      const updated = rows.map(r => {
        if (r.id !== id) return r
        return currentLetter ? r : { ...r, focus: `${baseName} A` }
      })
      const idx = updated.findIndex(r => r.id === id)
      const newGroup = { ...src, id: uid(), focus: `${baseName} ${nextLetter}`, athletesRaw: '' }
      updated.splice(idx + 1, 0, newGroup)
      return updated
    })
  }

  const handleRosterAdd = (name: string) =>
    setRoster(entries => [...entries, { id: uid(), name, group: '', target: '', note: '', checkout: '' }])

  // Assign an athlete to a workout group (or unassign if focus is null)
  const handleAssign = (athleteName: string, toGroupFocus: string | null) => {
    // Remove athlete from all workout rows, add to target
    setWorkoutRows(rows => rows.map(row => {
      const names = row.athletesRaw.split('\n').map(n => n.trim()).filter(Boolean)
      const withoutAthlete = names.filter(n => n !== athleteName)
      if (toGroupFocus !== null && row.focus === toGroupFocus) {
        return { ...row, athletesRaw: [...withoutAthlete, athleteName].join('\n') }
      }
      return { ...row, athletesRaw: withoutAthlete.join('\n') }
    }))
    // Update roster group field
    setRoster(entries => entries.map(e =>
      e.name.trim() === athleteName
        ? { ...e, group: toGroupFocus ?? '' }
        : e
    ))
  }

  const handleSetOffseason = (athleteName: string, value: boolean) => {
    setRoster(entries => entries.map(e =>
      e.name.trim() === athleteName ? { ...e, offseason: value } : e
    ))
  }

  const handleSave = useCallback(async () => {
    setSaving(true)
    setSaveError(null)
    // Only persist slices that changed since the last save/load. saveRoster and
    // saveWorkoutRows are full destructive replaces, so saving an unchanged
    // slice from this tab's (possibly stale) state would revert edits made
    // elsewhere — e.g. a plan-template edit must not rewrite the roster.
    const cur = {
      workouts: JSON.stringify(workoutRowsRef.current),
      roster: JSON.stringify(rosterRef.current),
      plans: JSON.stringify(planTemplatesRef.current),
      settings: JSON.stringify(settingsRef.current),
    }
    const snap = savedSnapshot.current
    const workoutsChanged = !snap || cur.workouts !== snap.workouts
    const rosterChanged = !snap || cur.roster !== snap.roster
    const plansChanged = !snap || cur.plans !== snap.plans
    const settingsChanged = !snap || cur.settings !== snap.settings
    try {
      const ops: Promise<unknown>[] = []
      if (workoutsChanged) ops.push(saveWorkoutRows(workoutRowsRef.current))
      if (rosterChanged) ops.push(saveRoster(rosterRef.current, savedRoster.current))
      // workout_history is derived from both workouts and roster.
      if (workoutsChanged || rosterChanged) ops.push(saveWorkoutHistory(workoutRowsRef.current, rosterRef.current))
      if (plansChanged) ops.push(savePlanTemplates(planTemplatesRef.current))
      if (settingsChanged) ops.push(saveSettings({
        // Preserve hidden fields from the initial data load (we don't expose
        // these in any tab, but we mustn't clobber them on every save).
        preRunRoutine: data.preRunRoutine,
        postRunRoutine: data.postRunRoutine,
        publishStatus: data.publishStatus,
        timezone: settingsRef.current.timezone,
        videoLabel: settingsRef.current.videoLabel,
        videoUrl: settingsRef.current.videoUrl,
        coaches: settingsRef.current.coaches,
      }))
      await Promise.all(ops)
      savedSnapshot.current = cur
      // Advance the roster baseline so the next diff is against what's now persisted.
      if (rosterChanged) savedRoster.current = rosterRef.current
      setSavedAt(new Date())
      onSaved()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [onSaved, data.preRunRoutine, data.postRunRoutine, data.publishStatus])

  // Auto-save: debounce 1.5s after any change
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      // Baseline snapshot = the freshly-loaded state, so the first edit only
      // saves the slice the coach actually touched.
      savedSnapshot.current = {
        workouts: JSON.stringify(workoutRowsRef.current),
        roster: JSON.stringify(rosterRef.current),
        plans: JSON.stringify(planTemplatesRef.current),
        settings: JSON.stringify(settingsRef.current),
      }
      return
    }
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = setTimeout(() => { handleSave() }, 1500)
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current) }
  }, [workoutRows, roster, planTemplates, settings, handleSave])

  return (
    <div className="h-screen flex flex-col bg-white">
      {/* Toolbar */}
      <header className="bg-navy-900 text-white px-4 py-2 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="p-1.5 hover:bg-navy-800 rounded transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="font-semibold text-sm">Coach Dashboard</span>
          <span className="text-navy-400 text-xs">{user.email}</span>
          <button
            onClick={onSignOut}
            className="text-xs text-navy-400 hover:text-white transition-colors"
          >
            Sign out
          </button>
        </div>
        <div className="flex items-center gap-3">
          {/* Strava sync */}
          <button
            onClick={handleStravaSync}
            disabled={stravaSync === 'syncing'}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50"
            style={{ backgroundColor: '#FC4C02', color: 'white' }}
            title="Sync Strava for all connected athletes"
          >
            {stravaSync === 'syncing' ? (
              <span className="animate-pulse">Syncing…</span>
            ) : (
              'Sync Strava'
            )}
          </button>
          {stravaSyncMsg && (
            <span className={`text-xs ${stravaSync === 'error' ? 'text-red-400' : 'text-green-400'}`}>
              {stravaSyncMsg}
            </span>
          )}
          {/* Save status */}
          {saving && <span className="text-xs text-navy-300 animate-pulse">Saving…</span>}
          {!saving && savedAt && !saveError && (
            <span className="text-xs text-green-400">Saved {savedAt.toLocaleTimeString()}</span>
          )}
          {saveError && (
            <span className="text-xs text-red-400 cursor-pointer" onClick={handleSave} title="Click to retry">{saveError} — retry</span>
          )}
        </div>
      </header>

      {/* Sheet content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === 'workouts' && (
          <div className="shrink-0 bg-white border-b border-gray-200 px-4 py-2 flex items-center gap-2">
            <button onClick={prevDay} className="text-gray-400 hover:text-gray-700 text-lg leading-none px-1 py-0.5">‹</button>
            <span className="text-sm font-semibold text-gray-700 min-w-[200px] text-center">
              {isToday ? 'Today — ' : ''}{fmtWorkoutDate(workoutDate)}
            </span>
            <button onClick={nextDay} className="text-gray-400 hover:text-gray-700 text-lg leading-none px-1 py-0.5">›</button>
            {!isToday && (
              <button onClick={() => setWorkoutDate(todayStr)}
                className="ml-2 px-2 py-0.5 text-xs text-blue-500 border border-blue-300 rounded hover:bg-blue-50">
                Today
              </button>
            )}
          </div>
        )}
        {tab === 'settings' ? (
          <SettingsTab
            value={settings}
            onChange={setSettings}
            currentEmail={user.email ?? null}
          />
        ) : tab === 'plans' ? (
          <PlansTab
            templates={planTemplates}
            onChange={setPlanTemplates}
          />
        ) : tab === 'roster' ? (
          <RosterSheet
            entries={applyOrder(roster)}
            onEntryAdd={handleRosterAdd}
            onEntryChange={(id, k, v) => {
              setRoster(entries => entries.map(e => {
                if (e.id !== id) return e
                // Assigning a plan with weeklyMiles also overwrites the athlete's
                // mileage target — saves having to keep two numbers in sync by hand.
                if (k === 'planTemplateId') {
                  const tpl = planTemplates.find(t => t.id === v)
                  if (tpl) {
                    // null weeklyMiles (e.g. "Rest" template) → target 0.
                    const wm = tpl.weeklyMiles ?? 0
                    return { ...e, planTemplateId: v as string | null, target: String(wm) }
                  }
                }
                return { ...e, [k]: v }
              }))
            }}
            teamMileage={teamMileage}
            planTemplates={planTemplates}
          />
        ) : tab === 'weekly' ? (
          <WeeklyMilesTab
            roster={applyOrder(roster)}
            onTargetChange={(id, target) =>
              setRoster(entries => entries.map(e => e.id === id ? { ...e, target } : e))
            }
            onPlanChange={(id, planTemplateId) => {
              const tpl = planTemplates.find(t => t.id === planTemplateId)
              // Picking a plan → sync target. Rest plans (weeklyMiles null/0)
              // explicitly set target to "0". Clearing the plan (no tpl) leaves
              // target alone.
              const newTarget = tpl ? String(tpl.weeklyMiles ?? 0) : null
              setRoster(entries => entries.map(e =>
                e.id === id
                  ? { ...e, planTemplateId, ...(newTarget != null ? { target: newTarget } : {}) }
                  : e
              ))
            }}
            onNoteChange={(id, note) =>
              setRoster(entries => entries.map(e => e.id === id ? { ...e, note } : e))
            }
            planTemplates={planTemplates}
            refreshKey={mileageRefreshKey}
            timezone={settings.timezone}
          />
        ) : tab === 'mileage' ? (
          <MileageTab
            roster={applyOrder(roster)}
            onTargetChange={(id, target) =>
              setRoster(entries => entries.map(e => e.id === id ? { ...e, target } : e))
            }
            onReorder={reorderAthlete}
            refreshKey={mileageRefreshKey}
            timezone={settings.timezone}
          />
        ) : isToday ? (
          <AthleteSheet
            roster={roster}
            workoutRows={workoutRows}
            onAssign={handleAssign}
            onSetOffseason={handleSetOffseason}
            onAddGroup={handleAddWorkoutFromForm}
            onWorkoutRowChange={handleWorkoutChange}
            onDeleteGroup={handleDeleteGroup}
            onDuplicateGroup={handleDuplicateGroup}
            onReorderGroups={handleReorderGroups}
          />
        ) : (
          <HistoryDayEditor date={workoutDate} todayRows={workoutRows} />
        )}
      </div>

      {/* Sheet tabs — like Google Sheets */}
      <div className="border-t border-gray-200 bg-gray-50 flex items-center px-2 gap-1 shrink-0">
        {(['workouts', 'roster', 'mileage', 'weekly', 'plans', 'settings'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => navigateTab(t)}
            className={`px-4 py-2 text-sm font-medium border-t-2 transition-colors ${
              tab === t
                ? 'border-blue-500 text-blue-600 bg-white'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-100'
            }`}
          >
            {t === 'workouts' ? 'Workouts' : t === 'roster' ? 'Roster' : t === 'mileage' ? 'Mileage' : t === 'weekly' ? 'Miles by Week' : t === 'plans' ? 'Weekly Planner' : 'Settings'}
          </button>
        ))}
      </div>
    </div>
  )
}
