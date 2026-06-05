import { useEffect, useMemo, useState } from 'react'
import type { RosterEntry, PlanTemplate, PlanDay } from '../lib/types.ts'
import { SCHOOL_LOGO } from '../config.ts'
import { useAthleticNetPRs } from '../hooks/useAthleticNetPRs.ts'
import { effectivePaces, computeTempoPace } from '../lib/vdot.ts'
import { ManualMileagePanel } from './ManualMileagePanel.tsx'
import { StravaConnectButton } from './StravaConnectButton.tsx'

// Date math in the team's configured timezone. UTC slicing made evening
// entries land on the wrong calendar day for week-boundary comparisons.
const localDateFmt = (tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })

function getMondayStr(tz: string): string {
  // Compute "today" in tz and step back to Monday using that weekday.
  const todayStr = localDateFmt(tz).format(new Date())
  const d = new Date(todayStr + 'T12:00:00') // noon avoids DST edges
  const dow = d.getDay()
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1))
  return localDateFmt(tz).format(d)
}

function normName(s: string) {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

// Standalone progress panel — used both as the body of OffseasonCard
// (when there's no workout) and as a banner above WorkoutCard (when an
// offseason athlete has been assigned to a workout group).
export function OffseasonProgressPanel({
  athleteName, rosterEntry, hasWorkout = false, timezone = 'America/Los_Angeles',
}: {
  athleteName: string
  rosterEntry: RosterEntry | null
  hasWorkout?: boolean
  timezone?: string
}) {
  const [thisWeekMiles, setThisWeekMiles] = useState<number | null>(null)
  const [last7Miles, setLast7Miles] = useState<number | null>(null)
  const [longestRun21d, setLongestRun21d] = useState<number | null>(null)
  const { prs } = useAthleticNetPRs(athleteName)
  const paces = useMemo(() => effectivePaces(rosterEntry?.vdot, prs), [rosterEntry?.vdot, prs])

  useEffect(() => {
    let cancelled = false
    fetch('/api/mileage')
      .then(r => r.json())
      .then((data: {
        daily?: Record<string, Record<string, { miles: number }>>
        longestRun21d?: Record<string, number>
      }) => {
        if (cancelled) return
        const daily = data.daily ?? {}
        const key = Object.keys(daily).find(k => normName(k) === normName(athleteName))
        const days = key ? daily[key] : {}
        const monday = getMondayStr(timezone)
        const sevenAgoStr = localDateFmt(timezone).format(new Date(Date.now() - 6 * 86400_000))
        let week = 0
        let last7 = 0
        for (const [date, entry] of Object.entries(days)) {
          if (date >= monday) week += entry.miles
          if (date >= sevenAgoStr) last7 += entry.miles
        }
        setThisWeekMiles(week)
        setLast7Miles(last7)

        const longestMap = data.longestRun21d ?? {}
        const longestKey = Object.keys(longestMap).find(k => normName(k) === normName(athleteName))
        setLongestRun21d(longestKey ? longestMap[longestKey] : 0)
      })
      .catch(() => {
        if (!cancelled) { setThisWeekMiles(0); setLast7Miles(0); setLongestRun21d(0) }
      })
    return () => { cancelled = true }
  }, [athleteName])

  const targetNum = parseFloat(rosterEntry?.target ?? '')
  const hasTarget = isFinite(targetNum) && targetNum > 0
  const pct = hasTarget && thisWeekMiles != null
    ? Math.min(100, (thisWeekMiles / targetNum) * 100)
    : 0
  const overTarget = hasTarget && thisWeekMiles != null && thisWeekMiles > targetNum

  return (
    <div className="bg-white rounded-2xl border border-amber-200 shadow-sm overflow-hidden">
      <div className="bg-amber-50 border-b border-amber-200 px-5 py-3">
        <div className="text-xs uppercase tracking-wide text-amber-700 font-semibold">Offseason</div>
        {hasWorkout && (
          <div className="text-sm text-amber-900 mt-0.5">
            Plus a suggested workout below — keep building your weekly base.
          </div>
        )}
      </div>

      <div className="px-5 py-6">
        {hasTarget ? (
          <>
            <div className="flex items-baseline justify-between mb-2">
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wide">Weekly target</div>
                <div className="text-3xl font-bold text-navy-900 tabular-nums">{targetNum} <span className="text-base font-medium text-gray-500">mi</span></div>
              </div>
              <div className="text-right">
                <div className="text-xs text-gray-500 uppercase tracking-wide">This week</div>
                <div className={`text-3xl font-bold tabular-nums ${overTarget ? 'text-emerald-600' : 'text-navy-900'}`}>
                  {thisWeekMiles == null ? '—' : thisWeekMiles.toFixed(1)}
                </div>
              </div>
            </div>

            <div className="mt-4">
              <div className="h-4 bg-gray-100 rounded-full overflow-hidden border border-gray-200">
                <div
                  className={`h-full transition-all ${overTarget ? 'bg-emerald-500' : 'bg-amber-500'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-gray-500 mt-1.5">
                <span>{pct.toFixed(0)}% of target</span>
                <span>{thisWeekMiles != null ? `${Math.max(0, targetNum - thisWeekMiles).toFixed(1)} mi to go` : ''}</span>
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-gray-100 space-y-1.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-gray-500">Last 7 days</span>
                <span className="font-mono text-navy-900 tabular-nums">
                  {last7Miles == null ? '—' : `${last7Miles.toFixed(1)} mi`}
                </span>
              </div>
              {longestRun21d != null && (
                <div className="flex items-center justify-between">
                  <span className="text-gray-500" title="max(3, 1 + your longest single run in the past 21 days)">
                    Max long run
                  </span>
                  <span className="font-mono text-navy-900 tabular-nums">
                    {Math.max(3, 1 + longestRun21d).toFixed(1)} mi
                  </span>
                </div>
              )}
              {longestRun21d != null && longestRun21d > 0 && (
                <div className="flex items-center justify-between text-xs text-gray-400">
                  <span>(longest in last 21 days: {longestRun21d.toFixed(1)} mi)</span>
                </div>
              )}
              {paces && (
                <div className="pt-3 mt-2 border-t border-gray-100">
                  <div className="text-xs uppercase tracking-wide text-gray-500 font-semibold mb-2">Suggested Paces</div>
                  <div className="flex items-center justify-between mb-2" title="Easy pace from your VDOT (Jack Daniels)">
                    <span className="text-gray-500">Easy</span>
                    <span className="font-mono text-navy-900 tabular-nums">
                      {paces.easyFast}–{paces.easySlow} <span className="text-xs text-gray-400">/mi</span>
                    </span>
                  </div>
                  <div className="text-[11px] text-gray-400 mb-1">Tempo (faster → slower as duration grows)</div>
                  <div className="grid grid-cols-3 gap-2">
                    {[4, 8, 12].map(mins => {
                      const t = computeTempoPace(paces.vdot, mins)
                      return (
                        <div key={mins} className="bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 text-center">
                          <div className="text-[10px] uppercase tracking-wide text-amber-700">{mins} min</div>
                          <div className="font-mono text-sm font-semibold text-navy-900 tabular-nums">{t.mile}</div>
                          <div className="text-[10px] text-gray-400">/mi</div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="text-center py-6">
            <div className="text-sm text-gray-500">No mileage target set.</div>
            <div className="text-xs text-gray-400 mt-1">Ask your coach to add one in the roster.</div>
          </div>
        )}
      </div>
    </div>
  )
}

interface Props {
  athleteName: string
  rosterEntry: RosterEntry | null
  onSwitchAthlete: () => void
  onPrevAthlete?: () => void
  onNextAthlete?: () => void
  isAuthenticated: boolean
  canEditMileage: boolean
  signedInAs?: string | null
  onSignIn?: () => void
  planTemplates: PlanTemplate[]
  timezone: string
}

// Read-only view of the assigned weekly plan. Shows a 7-day grid with the
// same two-line cell shape as the Plans tab editor.
const PLAN_DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
export function WeeklyPlanPanel({ template }: { template: PlanTemplate }) {
  // Top line: rest > miles (+ notes if both) > notes alone > placeholder.
  // Both can coexist when a coach wants "4 mi · 4x8 seconds hill sprints".
  const renderDay = (d: PlanDay) => {
    if (d.isRest) return <span className="text-gray-400">Rest</span>
    return (
      <>
        {d.miles != null && <span className="font-bold">{d.miles}</span>}
        {d.notes && (
          <span className="block text-gray-700 break-words">{d.notes}</span>
        )}
        {d.miles == null && !d.notes && <span className="text-gray-300">·</span>}
      </>
    )
  }
  // Bottom line: structured segments AND any free-text `extra` (both render).
  const renderExtras = (d: PlanDay) => {
    const segLine = d.segments.length > 0
      ? d.segments.map(s => `${s.qty}×${s.distance}${s.unit === 'minutes' ? 'min' : s.unit === 'miles' ? 'mi' : 'm'} @ ${s.pace}`).join(' · ')
      : ''
    return (
      <>
        {segLine && <div>{segLine}</div>}
        {d.extra && <div className={segLine ? 'text-gray-500 mt-0.5' : ''}>{d.extra}</div>}
      </>
    )
  }
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="bg-amber-50 border-b border-amber-200 px-5 py-3 flex items-baseline justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-amber-700 font-semibold">This week&apos;s plan</div>
          <div className="text-sm text-amber-900 mt-0.5">
            {template.label}{template.description && <span className="text-amber-700/80"> · {template.description}</span>}
          </div>
        </div>
        <div className="text-right text-xs text-amber-700/80">
          {template.weeklyMiles != null && <div>{template.weeklyMiles} mi</div>}
          {template.tempoMinutes != null && template.tempoMinutes > 0 && <div>{template.tempoMinutes} tempo mins total</div>}
        </div>
      </div>
      <div className="grid grid-cols-7 gap-px bg-gray-100 text-xs">
        {PLAN_DAY_LABELS.map(l => (
          <div key={l} className="bg-gray-50 px-1.5 py-1 text-[10px] uppercase tracking-wide text-gray-500 text-center">{l}</div>
        ))}
        {template.days.map((d, i) => (
          <div key={i} className="bg-white px-1.5 py-2 min-h-[64px] flex flex-col gap-1">
            <div className="text-sm text-navy-900 leading-tight text-center">{renderDay(d)}</div>
            <div className="text-[10px] text-blue-700 leading-tight text-center break-words">
              {renderExtras(d)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function OffseasonCard({
  athleteName, rosterEntry, onSwitchAthlete, onPrevAthlete, onNextAthlete,
  isAuthenticated, canEditMileage, signedInAs, onSignIn, planTemplates, timezone,
}: Props) {
  const assignedTemplate = rosterEntry?.planTemplateId
    ? planTemplates.find(t => t.id === rosterEntry.planTemplateId) ?? null
    : null
  // Viewer is this athlete (their email is bound to this roster row) — only
  // they may connect Strava, since the token is stored under their name.
  const isSelf = !!signedInAs && !!rosterEntry?.email
    && rosterEntry.email.toLowerCase() === signedInAs.toLowerCase()

  // Whether this athlete already has Strava connected (WorkoutCard gets this for
  // free from its mileage widget; the offseason card has no widget, so check it
  // directly to decide whether to show the connect prompt).
  const [stravaConnected, setStravaConnected] = useState<boolean | null>(null)
  const [stravaLimitFull, setStravaLimitFull] = useState(false)
  useEffect(() => {
    if (!isSelf) return
    let cancelled = false
    fetch(`/api/strava/athlete-mileage?athlete=${encodeURIComponent(athleteName)}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        setStravaConnected(!(d.connected === false || d.error || d.miles === undefined))
        setStravaLimitFull(!!d.limitFull)
      })
      .catch(() => { if (!cancelled) setStravaConnected(false) })
    return () => { cancelled = true }
  }, [athleteName, isSelf])

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-navy-900 text-white px-4 py-4 flex items-center justify-between">
        <button onClick={onSwitchAthlete} className="flex items-center gap-3 hover:opacity-80">
          <img src={SCHOOL_LOGO || '/team-logo.png'} alt="" className="h-8 w-8 rounded-full" />
          <span className="text-lg font-bold">{athleteName}</span>
        </button>
        <div className="flex items-center gap-2">
          {onPrevAthlete && (
            <button onClick={onPrevAthlete} className="px-2 py-1.5 text-sm bg-navy-700 rounded-lg hover:bg-navy-600">‹</button>
          )}
          {onNextAthlete && (
            <button onClick={onNextAthlete} className="px-2 py-1.5 text-sm bg-navy-700 rounded-lg hover:bg-navy-600">›</button>
          )}
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        {rosterEntry?.manualMileage && (
          <ManualMileagePanel
            athleteName={athleteName}
            canEdit={canEditMileage}
            isAuthenticated={isAuthenticated}
            signedInAs={signedInAs}
            onSignIn={onSignIn}
            timezone={timezone}
          />
        )}

        {assignedTemplate && <WeeklyPlanPanel template={assignedTemplate} />}

        {rosterEntry?.note && (
          <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-700 whitespace-pre-wrap">
            {rosterEntry.note}
          </div>
        )}

        <OffseasonProgressPanel athleteName={athleteName} rosterEntry={rosterEntry} timezone={timezone} />

        {/* Connect Strava — at the bottom so it stays out of the way until needed. */}
        {isAuthenticated && isSelf && stravaConnected === false && (
          <div className="bg-white rounded-xl p-4">
            <StravaConnectButton athleteName={athleteName} limitFull={stravaLimitFull} />
          </div>
        )}
      </main>
    </div>
  )
}
