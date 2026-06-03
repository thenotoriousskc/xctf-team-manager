import { useState, useEffect, useMemo, useRef } from 'react'
import type { WorkoutRow, RosterEntry, WorkoutHistoryEntry, WorkoutSegment, AthleticNetPR } from '../lib/types.ts'
import { fetchAthleteHistory } from '../lib/db.ts'
import { useAthleticNetPRs } from '../hooks/useAthleticNetPRs.ts'
import { effectivePaces, computeTempoPace, parseTimeSecs } from '../lib/vdot.ts'
import type { TrainingPaces } from '../lib/vdot.ts'
import { SCHOOL_LOGO } from '../config.ts'
import { RoutineBar } from './RoutineBar.tsx'
import { VideoEmbed } from './VideoEmbed.tsx'
import { AthleticNetPRs } from './AthleticNetPRs.tsx'
import { OffseasonProgressPanel, WeeklyPlanPanel } from './OffseasonCard.tsx'
import type { PlanTemplate } from '../lib/types.ts'
import { ManualMileagePanel } from './ManualMileagePanel.tsx'

const URL_REGEX = /(https?:\/\/[^\s]+)/g

// Matches running paces like 5:30, 7:20, 12:45 (1:xx – 14:59)
const PACE_REGEX = /\b([1-9]|1[0-4]):([0-5]\d)\b/g

function mileToKm(paceStr: string): string {
  const [m, s] = paceStr.split(':').map(Number)
  const kmSecs = (m * 60 + s) / 1.60934
  const km = Math.floor(kmSecs / 60)
  const ks = Math.round(kmSecs % 60)
  return `${km}:${String(ks).padStart(2, '0')}`
}

function PaceEffort({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <p className="text-navy-900 whitespace-pre-wrap">
      {lines.map((line, li) => {
        const parts: React.ReactNode[] = []
        let last = 0
        let m: RegExpExecArray | null
        PACE_REGEX.lastIndex = 0
        while ((m = PACE_REGEX.exec(line)) !== null) {
          if (m.index > last) parts.push(line.slice(last, m.index))
          const km = mileToKm(m[0])
          parts.push(
            <span key={m.index}>
              {m[0]}
              <span className="text-xs text-gray-400 ml-0.5">({km})</span>
            </span>
          )
          last = m.index + m[0].length
        }
        if (last < line.length) parts.push(line.slice(last))
        return <span key={li}>{parts}{li < lines.length - 1 ? '\n' : ''}</span>
      })}
    </p>
  )
}

function Linkify({ text, className }: { text: string; className?: string }) {
  const parts = text.split(URL_REGEX)
  return (
    <p className={className}>
      {parts.map((part, i) =>
        URL_REGEX.test(part) ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="text-navy-500 underline break-all"
          >
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </p>
  )
}
const RACE_PACES_MAP: Partial<Record<string, { meters: number; re: RegExp }>> = {
  '400':  { meters: 400,  re: /^400\b/i },
  '800':  { meters: 800,  re: /^800\b/i },
  '1600': { meters: 1600, re: /1600|mile/i },
  '3200': { meters: 3200, re: /3200|2\s*mile/i },
  '5k':   { meters: 5000, re: /5000|5k/i },
}

function paceToSecs(pace: string): number {
  const [m, s] = pace.split(':').map(Number)
  return m * 60 + s
}
function formatSecs(totalSecs: number): string {
  const m = Math.floor(totalSecs / 60)
  const s = Math.round(totalSecs % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function segmentTarget(seg: WorkoutSegment, prs: AthleticNetPR[], paces: TrainingPaces | null): string | null {
  if (seg.pace === 'easy') {
    if (!paces) return null
    return `${paces.easyFast}–${paces.easySlow}/mi`
  }
  if (seg.pace === 'threshold') {
    if (!paces) return null
    return `${paces.threshold}/mi`
  }
  if (seg.pace === 'tempo') {
    if (!paces) return null
    let durationMins: number
    if (seg.unit === 'minutes') {
      durationMins = parseFloat(seg.distance) || 4
    } else {
      const segM = seg.unit === 'miles'
        ? parseFloat(seg.distance) * 1609.34
        : parseFloat(seg.distance)
      // estimate duration at threshold pace
      const [tm, ts] = paces.threshold.split(':').map(Number)
      const threshMperMin = 1609.34 / (tm * 60 + ts) * 60
      durationMins = segM / threshMperMin
    }
    const p = computeTempoPace(paces.vdot, durationMins)
    const slowSecs = paceToSecs(p.mile) + 10
    const slowMile = formatSecs(slowSecs)
    return `${p.mile}–${slowMile}/mi`
  }
  if (seg.pace === 'fast and relaxed') return null

  const rp = RACE_PACES_MAP[seg.pace]
  if (!rp) return null
  const pr = prs.find(p => rp.re.test(p.event) && !/relay/i.test(p.event))
  if (!pr) return null
  const prSecs = parseTimeSecs(pr.mark)
  if (!prSecs) return null

  if (seg.unit === 'minutes') return null
  const segM = seg.unit === 'miles'
    ? parseFloat(seg.distance) * 1609.34
    : parseFloat(seg.distance)
  const targetSecs = (segM / rp.meters) * prSecs
  const mins = Math.floor(targetSecs / 60)
  const secs = (targetSecs % 60).toFixed(1)
  return mins > 0 ? `${mins}:${secs.padStart(4, '0')}` : `${secs}`
}

export function WorkoutCard({
  athleteName,
  workout,
  groupMates,
  rosterEntry,
  preRunRoutine,
  postRunRoutine,
  videoLabel,
  videoUrl,
  isAuthenticated,
  onSwitchAthlete,
  onPrevAthlete,
  onNextAthlete,
  onRefresh,
  showOffseasonPanel = false,
  onSignIn,
  canEditMileage = false,
  signedInAs,
  planTemplates = [],
  timezone = 'America/Los_Angeles',
}: {
  athleteName: string
  workout: WorkoutRow | null
  groupMates: string[]
  rosterEntry: RosterEntry | null
  preRunRoutine: string
  postRunRoutine: string
  videoLabel: string
  videoUrl: string
  isAuthenticated: boolean
  onSwitchAthlete: () => void
  onPrevAthlete?: () => void
  onNextAthlete?: () => void
  onRefresh: () => void
  showOffseasonPanel?: boolean
  onSignIn?: () => void
  canEditMileage?: boolean
  signedInAs?: string | null
  planTemplates?: PlanTemplate[]
  timezone?: string
}) {
  const [history, setHistory] = useState<WorkoutHistoryEntry[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const { prs } = useAthleticNetPRs(athleteName)
  const paces = useMemo(() => effectivePaces(rosterEntry?.vdot, prs), [rosterEntry?.vdot, prs])

  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), [])
  // Fall back to today's history entry if no live workout assigned
  const todayHistory = history.find(h => h.date === todayStr)
  const effectiveWorkout: WorkoutRow | null = workout ?? (todayHistory ? {
    athletesRaw: '',
    coach: todayHistory.coach,
    focus: todayHistory.focus,
    warmup: todayHistory.warmup,
    workout: todayHistory.workout,
    cooldown: todayHistory.cooldown,
    paceEffort: todayHistory.paceEffort,
    notes: todayHistory.notes,
    segments: todayHistory.segments,
  } : null)
  // Don't show today in "Past Workouts" — it's already at the top
  const pastHistory = history.filter(h => h.date !== todayStr)
  const [stravaMiles, setStravaMiles] = useState<number | null>(null)
  const [stravaLastWeek, setStravaLastWeek] = useState<number | null>(null)
  const [stravaConnected, setStravaConnected] = useState<boolean | null>(null)
  const [stravaLoading, setStravaLoading] = useState(true)

  // This card belongs to the signed-in user (their email is bound to this
  // roster row). Only they may connect Strava — the token is stored under this
  // athlete's name, so a coach viewing someone else's card must not connect.
  const isSelf = !!signedInAs && !!rosterEntry?.email
    && rosterEntry.email.toLowerCase() === signedInAs.toLowerCase()

  // One-time status from the Strava connect redirect (?strava_athlete=...).
  // Read once, then strip from the URL so it doesn't persist on refresh.
  const [stravaConnectMsg] = useState<'connected' | 'error' | 'limit' | null>(() => {
    const p = new URLSearchParams(window.location.search).get('strava_athlete')
    return p === 'connected' || p === 'error' || p === 'limit' ? p : null
  })
  useEffect(() => {
    if (!stravaConnectMsg) return
    const params = new URLSearchParams(window.location.search)
    params.delete('strava_athlete')
    window.history.replaceState(null, '', `${window.location.pathname}${params.toString() ? `?${params}` : ''}`)
  }, [stravaConnectMsg])

  useEffect(() => {
    fetchAthleteHistory(athleteName).then(setHistory).catch(() => {})
  }, [athleteName])

  useEffect(() => {
    setStravaLoading(true)
    fetch(`/api/strava/athlete-mileage?athlete=${encodeURIComponent(athleteName)}`)
      .then(r => r.json())
      .then(data => {
        if (data.connected === false || data.error || data.miles === undefined) {
          setStravaConnected(false)
        } else {
          setStravaConnected(true)
          setStravaMiles(data.miles ?? null)
          setStravaLastWeek(data.lastWeek ?? null)
        }
      })
      .catch(() => setStravaConnected(false))
      .finally(() => setStravaLoading(false))
  }, [athleteName])

  // Swipe detection for mobile
  const touchStartX = useRef<number | null>(null)
  const handleTouchStart = (e: React.TouchEvent) => { touchStartX.current = e.touches[0].clientX }
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return
    const dx = e.changedTouches[0].clientX - touchStartX.current
    if (Math.abs(dx) > 60) {
      if (dx > 0) onPrevAthlete?.()
      else onNextAthlete?.()
    }
    touchStartX.current = null
  }

  return (
    <div className="min-h-screen bg-slate-50" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      {/* Header */}
      <header className="bg-navy-900 text-white px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src={SCHOOL_LOGO || '/team-logo.png'} alt="" className="h-8 w-8 rounded-full" />
          <div>
            <h1 className="text-lg font-bold">{athleteName}</h1>
            <p className="text-navy-300 text-xs">Today&apos;s Workout</p>
          </div>
        </div>
        <div className="flex gap-2 items-center">
          <button
            onClick={onRefresh}
            className="p-2 rounded-lg hover:bg-navy-800 active:bg-navy-700 transition-colors"
            title="Refresh"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          <button
            onClick={onPrevAthlete}
            disabled={!onPrevAthlete}
            className="hidden sm:flex p-1.5 rounded-lg hover:bg-navy-800 active:bg-navy-700 transition-colors disabled:opacity-20 disabled:cursor-default"
            title="Previous athlete"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            onClick={onNextAthlete}
            disabled={!onNextAthlete}
            className="hidden sm:flex p-1.5 rounded-lg hover:bg-navy-800 active:bg-navy-700 transition-colors disabled:opacity-20 disabled:cursor-default"
            title="Next athlete"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <button
            onClick={onSwitchAthlete}
            className="px-3 py-1.5 text-sm bg-navy-700 rounded-lg hover:bg-navy-600 active:bg-navy-500 transition-colors"
          >
            Switch
          </button>
        </div>
      </header>

      <div className="p-4 space-y-3 max-w-lg mx-auto">
        {/* Self-log mileage at the top — athletes log most often for today */}
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

        {/* Weekly plan (when offseason and assigned) — shows above progress + workout */}
        {showOffseasonPanel && rosterEntry?.planTemplateId && (() => {
          const t = planTemplates.find(x => x.id === rosterEntry.planTemplateId)
          return t ? <WeeklyPlanPanel template={t} /> : null
        })()}

        {/* Offseason progress (when athlete has a workout AND is in offseason mode) */}
        {showOffseasonPanel && (
          <OffseasonProgressPanel athleteName={athleteName} rosterEntry={rosterEntry} hasWorkout timezone={timezone} />
        )}

        {/* Pre-run routine — temporarily hidden */}
        {false && <RoutineBar label="Pre-Run Routine" content={preRunRoutine} />}

        {/* Workout */}
        {effectiveWorkout ? (
          <div className="bg-white rounded-xl p-4 space-y-4">
            {effectiveWorkout.focus && (
              <div>
                <span className="inline-block px-2.5 py-1 bg-navy-100 text-navy-700 rounded-full text-xs font-semibold">
                  {effectiveWorkout.focus}
                </span>
              </div>
            )}

            {effectiveWorkout.workout && (
              <div>
                <h3 className="text-sm font-semibold text-navy-400 mb-1">Workout</h3>
                <p className="text-navy-900 text-lg font-medium whitespace-pre-wrap">{effectiveWorkout.workout}</p>
              </div>
            )}

            {(effectiveWorkout.warmup || effectiveWorkout.cooldown) && (
              <div className="flex gap-4">
                {effectiveWorkout.warmup && (
                  <p className="text-sm text-navy-700">
                    <span className="font-semibold text-amber-500">WU</span> {effectiveWorkout.warmup} min
                  </p>
                )}
                {effectiveWorkout.cooldown && (
                  <p className="text-sm text-navy-700">
                    <span className="font-semibold text-green-500">CD</span> {effectiveWorkout.cooldown} min
                  </p>
                )}
              </div>
            )}

            {effectiveWorkout.segments.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-navy-400 mb-2">Workout Segments</h3>
                <div className="space-y-1.5">
                  {effectiveWorkout.segments.map((seg, i) => {
                    const target = segmentTarget(seg, prs, paces)
                    return (
                      <div key={i} className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-sm text-navy-800 font-medium">
                          {seg.qty === '1' ? '' : `${seg.qty}× `}{seg.distance} {seg.unit}
                        </span>
                        <span className="text-xs text-navy-400">@ {seg.pace}</span>
                        {seg.rest === 'full recovery' ? (
                          <span className="text-xs text-gray-400">· full recovery</span>
                        ) : (seg.restDuration && seg.restDuration !== '0') ? (
                          <span className="text-xs text-gray-400">· {seg.restDuration} {seg.rest}</span>
                        ) : null}
                        {target && (
                          <span className="ml-auto text-base font-black text-blue-700">{target}</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {effectiveWorkout.paceEffort && (
              <div>
                <h3 className="text-sm font-semibold text-navy-400 mb-1">Pace / Effort</h3>
                <PaceEffort text={effectiveWorkout.paceEffort} />
              </div>
            )}

            {effectiveWorkout.notes && (
              <div>
                <h3 className="text-sm font-semibold text-navy-400 mb-1">Notes</h3>
                <Linkify text={effectiveWorkout.notes} className="text-navy-700 text-sm whitespace-pre-wrap" />
              </div>
            )}

            {effectiveWorkout.coach && (
              <div className="pt-2 border-t border-navy-100">
                <p className="text-xs text-navy-400">
                  Coach: <span className="text-navy-600">{effectiveWorkout.coach}</span>
                </p>
              </div>
            )}

            {/* Group mates */}
            {groupMates.length > 0 && (
              <div className="pt-2 border-t border-navy-100">
                <p className="text-xs text-navy-400 mb-1">Running with:</p>
                <p className="text-sm text-navy-600">
                  {groupMates.join(', ')}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-xl p-6 text-center">
            <p className="text-navy-500">
              No workout found for <span className="font-semibold">{athleteName}</span> today.
            </p>
            <p className="text-navy-400 text-sm mt-2">
              Check back later or ask your coach.
            </p>
          </div>
        )}

        {/* Coach note for this athlete */}
        {rosterEntry?.note && (
          <div className="bg-white rounded-xl p-4">
            <h3 className="text-sm font-semibold text-navy-700 mb-2">Coach Note</h3>
            <p className="text-navy-600 text-sm whitespace-pre-wrap">{rosterEntry.note}</p>
          </div>
        )}

        {/* Post-run routine — temporarily hidden */}
        {false && <RoutineBar label="Post-Run Routine" content={postRunRoutine} />}


        {/* Mileage — only shown when signed in */}
        {isAuthenticated && (
          <div className="bg-white rounded-xl p-4">
            {stravaLoading ? (
              <div className="text-center text-navy-400 text-sm py-2">…</div>
            ) : stravaConnected ? (
              <div className="flex gap-3">
                <div className="flex-1 bg-orange-50 rounded-xl p-3 text-center">
                  <div className="text-3xl font-black" style={{ color: '#FC4C02' }}>
                    {stravaMiles ?? '—'}
                  </div>
                  <div className="text-xs font-semibold text-orange-400 mt-0.5">This Week</div>
                </div>
                <div className="flex-1 bg-slate-50 rounded-xl p-3 text-center">
                  <div className="text-3xl font-black text-navy-400">
                    {stravaLastWeek ?? '—'}
                  </div>
                  <div className="text-xs font-semibold text-navy-300 mt-0.5">Last Week</div>
                </div>
                {rosterEntry?.target && (
                  <div className="flex-1 bg-slate-50 rounded-xl p-3 text-center">
                    <div className="text-3xl font-black text-navy-700">
                      {rosterEntry.target}
                    </div>
                    <div className="text-xs font-semibold text-navy-400 mt-0.5">Goal</div>
                  </div>
                )}
              </div>
            ) : isSelf ? (
              <div className="flex flex-col items-center gap-2">
                {stravaConnectMsg === 'limit' ? (
                  <p className="text-xs text-center text-amber-600">
                    The team's Strava connection limit is full. Ask your coach — log your miles manually for now.
                  </p>
                ) : stravaConnectMsg === 'error' ? (
                  <p className="text-xs text-center text-red-500">
                    Strava couldn't connect. Try again, or log your miles manually.
                  </p>
                ) : null}
                <a
                  href={`/api/strava/athlete-auth?athlete=${encodeURIComponent(athleteName)}`}
                  className="block mx-auto w-fit"
                >
                  <img src="/btn-strava-connect.svg" alt="Connect with Strava" className="h-12" />
                </a>
              </div>
            ) : null}
          </div>
        )}

        {/* Training paces from VDOT */}
        {paces && (
          <div className="bg-white rounded-xl p-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
              Training Paces <span className="font-normal normal-case text-gray-300">· VDOT {paces.vdot} from {paces.sourcePR.event} {paces.sourcePR.mark}</span>
            </p>
            <div className="flex gap-2">
              <div className="flex-1 text-center">
                <div className="text-base font-bold text-navy-700 leading-tight">{paces.easyFast}–{paces.easySlow}</div>
                <div className="text-xs text-gray-300">{paces.easyFastKm}–{paces.easySlowKm}</div>
                <div className="text-xs text-navy-400 mt-0.5">Easy</div>
              </div>
              <div className="w-px bg-gray-100" />
              <div className="flex-1 text-center">
                <div className="text-lg font-bold text-navy-700">{paces.marathon}</div>
                <div className="text-xs text-gray-300">{paces.marathonKm}</div>
                <div className="text-xs text-navy-400 mt-0.5">Marathon</div>
              </div>
              <div className="w-px bg-gray-100" />
              <div className="flex-1 text-center">
                <div className="text-xl font-black text-blue-600">{paces.threshold}</div>
                <div className="text-xs text-blue-200">{paces.thresholdKm}</div>
                <div className="text-xs font-semibold text-blue-400 mt-0.5">Threshold</div>
              </div>
            </div>
            <div className="flex gap-2 mt-3 pt-3 border-t border-gray-100">
              <div className="flex-1 text-center">
                <div className="text-xl font-black text-purple-600">{paces.tenK}</div>
                <div className="text-xs text-purple-200">{paces.tenKKm}</div>
                <div className="text-xs font-semibold text-purple-400 mt-0.5">10K</div>
              </div>
              <div className="w-px bg-gray-100" />
              <div className="flex-1 text-center">
                <div className="text-xl font-black text-red-500">{paces.fiveK}</div>
                <div className="text-xs text-red-200">{paces.fiveKKm}</div>
                <div className="text-xs font-semibold text-red-400 mt-0.5">5K</div>
              </div>
            </div>
            <p className="text-xs text-gray-300 text-right mt-2">mi / km</p>
          </div>
        )}

        {/* 400m split card — hidden
        {(() => {
          const pr400 = prs.find(p => /^400\b/i.test(p.event) && !/relay/i.test(p.event))
          if (!pr400) return null
          const parts = pr400.mark.trim().split(':')
          const totalSecs = parts.length === 2
            ? parseFloat(parts[0]) * 60 + parseFloat(parts[1])
            : parseFloat(parts[0])
          if (isNaN(totalSecs) || totalSecs <= 0) return null
          const fmt = (s: number) => {
            const m = Math.floor(s / 60)
            const sec = (s % 60).toFixed(2).padStart(5, '0')
            return m > 0 ? `${m}:${sec}` : `${sec}`
          }
          const split300 = fmt(totalSecs * 0.75)
          const split100 = fmt(totalSecs * 0.25)
          return (
            <div className="bg-white rounded-xl p-4">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                Split 400 300/100 <span className="font-normal normal-case text-gray-300">· PR {pr400.mark}</span>
              </p>
              <div className="flex gap-2">
                <div className="flex-1 text-center">
                  <div className="text-2xl font-black text-navy-700">{split300}</div>
                  <div className="text-xs font-semibold text-navy-400 mt-0.5">300m</div>
                </div>
                <div className="w-px bg-gray-100" />
                <div className="flex-1 text-center">
                  <div className="text-2xl font-black text-navy-700">{split100}</div>
                  <div className="text-xs font-semibold text-navy-400 mt-0.5">100m</div>
                </div>
              </div>
              <p className="text-xs text-gray-300 text-right mt-2">at 400m PR pace</p>
            </div>
          )
        })()} */}

        {/* Track & Field PRs from athletic.net */}
        <AthleticNetPRs athleteName={athleteName} wrapperClass="bg-white rounded-xl p-4" />

        {/* Video of the day */}
        <VideoEmbed url={videoUrl} label={videoLabel} />

        {/* Workout history */}
        {pastHistory.length > 0 && (
          <div className="bg-white rounded-xl overflow-hidden">
            <button
              onClick={() => setHistoryOpen(o => !o)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-navy-700 hover:bg-slate-50 transition-colors"
            >
              <span>Past Workouts</span>
              <span className="text-navy-400 text-xs">{historyOpen ? '▲' : '▼'} {pastHistory.length} days</span>
            </button>
            {historyOpen && (
              <div className="divide-y divide-slate-100">
                {pastHistory.map(entry => (
                  <div key={entry.date} className="px-4 py-3">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-semibold text-navy-500">
                        {new Date(entry.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                      </span>
                      {entry.focus && (
                        <span className="text-xs px-2 py-0.5 bg-navy-100 text-navy-600 rounded-full">{entry.focus}</span>
                      )}
                    </div>
                    {entry.warmup && <p className="text-xs text-gray-400 mb-0.5"><span className="text-amber-500">WU</span> {entry.warmup} min</p>}
                    {entry.segments.length > 0 ? (
                      <div className="flex flex-col gap-0.5 mb-0.5">
                        {entry.segments.map((seg, i) => (
                          <p key={i} className="text-xs text-navy-700">
                            <span className="font-medium">{seg.qty}×{seg.distance} {seg.unit}</span>
                            <span className="text-blue-600 ml-1">@ {seg.pace}</span>
                            {seg.rest === 'full recovery' ? (
                              <span className="text-gray-400 ml-1">· full recovery</span>
                            ) : (seg.restDuration && seg.restDuration !== '0') ? (
                              <span className="text-gray-400 ml-1">· {seg.restDuration} {seg.rest}</span>
                            ) : null}
                          </p>
                        ))}
                      </div>
                    ) : entry.workout ? (
                      <p className="text-xs text-navy-700 mb-0.5">{entry.workout}</p>
                    ) : null}
                    {entry.cooldown && <p className="text-xs text-gray-400"><span className="text-green-500">CD</span> {entry.cooldown} min</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
