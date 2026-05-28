import { useEffect, useState } from 'react'

function normName(s: string) {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

// All date math is in the team's configured timezone (Settings tab).
// Previously used toISOString() which is UTC — entries logged in the evening
// Pacific shifted forward one day (e.g. "Today" at 8pm PT saved as tomorrow's
// UTC date).
const localDateFmt = (tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })

// Today first, then yesterday, then day before. Athletes log most often for
// today, so show that input at the top.
function lastNDates(n: number, tz: string): string[] {
  const fmt = localDateFmt(tz)
  const out: string[] = []
  const nowMs = Date.now()
  for (let i = 0; i < n; i++) {
    out.push(fmt.format(new Date(nowMs - i * 86400_000)))
  }
  return out
}

function dayLabel(date: string, tz: string): string {
  const fmt = localDateFmt(tz)
  const todayStr = fmt.format(new Date())
  if (date === todayStr) return 'Today'
  const yesterdayStr = fmt.format(new Date(Date.now() - 86400_000))
  if (date === yesterdayStr) return 'Yesterday'
  return new Date(date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' })
}

// Self-service mileage entry for athletes flagged manualMileage on the roster.
// Editable window: last 3 days. Posts to /api/mileage POST (same endpoint the
// coach dashboard uses). Strava-synced runs are read-only here — they show as
// gray but can't be replaced (the coach dashboard handles conflict resolution).
//
// Auth model (mirrors BioPage.tsx):
//   isSelf  = signed-in user's Google display name matches roster entry name
//   isCoach = signed-in user's email is in VITE_AUTHORIZED_COACHES
//   canEdit = isSelf || isCoach
// Parent computes canEdit and passes it in so this component stays presentational.
export function ManualMileagePanel({
  athleteName, canEdit, isAuthenticated, signedInAs, onSignIn, timezone = 'America/Los_Angeles',
}: {
  athleteName: string
  canEdit: boolean
  isAuthenticated: boolean
  signedInAs?: string | null
  onSignIn?: () => void
  timezone?: string
}) {
  if (!isAuthenticated) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="bg-gray-50 border-b border-gray-200 px-5 py-3">
          <div className="text-xs uppercase tracking-wide text-gray-600 font-semibold">Log your miles</div>
          <div className="text-sm text-gray-700 mt-0.5">Sign in to enter or update your mileage.</div>
        </div>
        <div className="px-5 py-4">
          {onSignIn ? (
            <button
              onClick={onSignIn}
              className="w-full px-4 py-2 bg-navy-700 text-white text-sm font-medium rounded-lg hover:bg-navy-800 active:bg-navy-900 transition-colors"
            >
              Sign in with Google
            </button>
          ) : (
            <div className="text-xs text-gray-500">Open the menu (☰) and choose Sign In.</div>
          )}
        </div>
      </div>
    )
  }
  if (!canEdit) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="bg-gray-50 border-b border-gray-200 px-5 py-3">
          <div className="text-xs uppercase tracking-wide text-gray-600 font-semibold">Log your miles</div>
          <div className="text-sm text-gray-700 mt-0.5">
            You can only log mileage for your own roster entry.
            {signedInAs && <> Signed in as <span className="font-medium">{signedInAs}</span>.</>}
          </div>
        </div>
      </div>
    )
  }
  return <ManualMileagePanelEditor athleteName={athleteName} timezone={timezone} />
}

function ManualMileagePanelEditor({ athleteName, timezone }: { athleteName: string; timezone: string }) {
  const dates = lastNDates(3, timezone)
  const [miles, setMiles] = useState<Record<string, number | null>>({})
  const [sources, setSources] = useState<Record<string, 'manual' | 'strava' | 'mixed' | null>>({})
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState<string | null>(null)

  const load = () => {
    fetch('/api/mileage')
      .then(r => r.json())
      .then((data: { daily?: Record<string, Record<string, { miles: number; source: 'manual' | 'strava' | 'mixed' }>> }) => {
        const daily = data.daily ?? {}
        const key = Object.keys(daily).find(k => normName(k) === normName(athleteName))
        const days = key ? daily[key] : {}
        const m: Record<string, number | null> = {}
        const s: Record<string, 'manual' | 'strava' | 'mixed' | null> = {}
        for (const d of dates) {
          m[d] = days[d]?.miles ?? null
          s[d] = days[d]?.source ?? null
        }
        setMiles(m)
        setSources(s)
      })
      .catch(() => {})
  }

  useEffect(() => { load() }, [athleteName])

  const save = async (date: string) => {
    const value = parseFloat(draft[date] ?? '')
    if (isNaN(value) || value < 0) {
      setDraft(d => ({ ...d, [date]: '' }))
      return
    }
    setSaving(date)
    try {
      await fetch('/api/mileage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ athleteName, date, miles: value }),
      })
      setSavedFlash(date)
      setTimeout(() => setSavedFlash(null), 1200)
      setDraft(d => { const n = { ...d }; delete n[date]; return n })
      load()
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="bg-gray-50 border-b border-gray-200 px-5 py-3">
        <div className="text-xs uppercase tracking-wide text-gray-600 font-semibold">Log your miles</div>
        <div className="text-sm text-gray-700 mt-0.5">Tap a day to enter or update miles. Press Enter to save.</div>
      </div>
      <div className="px-5 py-4 space-y-2">
        {dates.map(date => {
          const isStrava = sources[date] === 'strava'
          const current = miles[date]
          const value = draft[date] !== undefined
            ? draft[date]
            : current != null && current > 0 ? current.toFixed(1) : ''
          return (
            <div key={date} className="flex items-center gap-3">
              <div className="w-24 text-sm text-gray-600">{dayLabel(date, timezone)}</div>
              <div className="flex-1 flex items-center gap-2">
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  inputMode="decimal"
                  placeholder={isStrava ? `${current?.toFixed(1)} (Strava)` : '0.0'}
                  value={value}
                  disabled={isStrava}
                  onChange={e => setDraft(d => ({ ...d, [date]: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') save(date) }}
                  onBlur={() => { if (draft[date] !== undefined) save(date) }}
                  className={`flex-1 max-w-[8rem] px-3 py-1.5 text-sm font-mono tabular-nums border rounded-lg focus:outline-none focus:ring-2 ${
                    isStrava
                      ? 'bg-gray-50 border-gray-200 text-gray-400 cursor-not-allowed'
                      : 'border-gray-300 focus:ring-blue-400'
                  }`}
                />
                <span className="text-xs text-gray-500">mi</span>
                {savedFlash === date && <span className="text-xs text-emerald-600">✓ saved</span>}
                {saving === date && <span className="text-xs text-gray-400">saving…</span>}
                {isStrava && <span className="text-xs text-orange-500" title="Strava-synced — locked">🔒 Strava</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
