import { useState, useCallback, useEffect, useRef } from 'react'
import { useSupabaseData } from './hooks/useSupabaseData.ts'
import { useAuth } from './hooks/useAuth.ts'
import { findWorkoutForAthlete, findRosterEntry, findGroupMates } from './lib/sheets.ts'
import { isAuthorizedCoach } from './lib/coaches.ts'
import { AthletePicker } from './components/AthletePicker.tsx'
import { WorkoutCard } from './components/WorkoutCard.tsx'
import { OffseasonCard } from './components/OffseasonCard.tsx'
import { PrintView } from './components/PrintView.tsx'
import { AuthGate } from './components/AuthGate.tsx'
import { LoadingSpinner, ErrorDisplay } from './components/LoadingSpinner.tsx'
import { HelpPage } from './components/HelpPage.tsx'
import { BioPage } from './components/BioPage.tsx'
import { TEAM_NAME, SCHOOL_LOGO } from './config.ts'

type View = 'athlete' | 'coach-dashboard' | 'print'

// Detect if we're returning from a Strava per-athlete OAuth
const _searchParams = new URLSearchParams(window.location.search)
const _urlAthlete = _searchParams.get('athlete')

// Detect if returning from Google OAuth (Supabase sets access_token in hash)
const _isGoogleReturn = window.location.hash.includes('access_token=')

function readAthleteFromStorage(): string | null {
  try {
    const item = localStorage.getItem('xctf-selected-athlete')
    return item ? JSON.parse(item) : null
  } catch { return null }
}
function saveAthleteToStorage(name: string | null) {
  try { localStorage.setItem('xctf-selected-athlete', JSON.stringify(name)) } catch {}
}

function BiosRoute() {
  const { data, loading } = useSupabaseData()
  const { user } = useAuth()
  if (loading && !data) return <div className="min-h-screen flex items-center justify-center"><p className="text-gray-400">Loading…</p></div>
  return (
    <BioPage
      roster={data?.roster ?? []}
      user={user}
      onBack={() => { window.history.back() }}
    />
  )
}

function HamburgerMenu({ onRefresh, onEdit, onPrint, user, onSignIn, onSignOut, authLoading }: {
  onRefresh: () => void
  onEdit: () => void
  onPrint: () => void
  user: ReturnType<typeof useAuth>['user']
  onSignIn: () => void
  onSignOut: () => void
  authLoading: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="p-2 rounded-lg hover:bg-navy-800 active:bg-navy-700 transition-colors"
        title="Menu"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-44 bg-white rounded-xl shadow-lg border border-gray-100 py-1 z-50 text-sm text-gray-800">
          <button onClick={() => { onRefresh(); setOpen(false) }} className="w-full text-left px-4 py-2.5 hover:bg-gray-50 flex items-center gap-3">
            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
          <button onClick={() => { onEdit(); setOpen(false) }} className="w-full text-left px-4 py-2.5 hover:bg-gray-50 flex items-center gap-3">
            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Edit
          </button>
          <button onClick={() => { onPrint(); setOpen(false) }} className="w-full text-left px-4 py-2.5 hover:bg-gray-50 flex items-center gap-3">
            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
            Print
          </button>
          {!authLoading && (
            <>
              <div className="border-t border-gray-100 my-1" />
              {user ? (
                <button onClick={() => { onSignOut(); setOpen(false) }} className="w-full text-left px-4 py-2.5 hover:bg-gray-50 flex items-center gap-3 text-gray-500">
                  <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                  </svg>
                  Sign out
                </button>
              ) : (
                <button onClick={() => { onSignIn(); setOpen(false) }} className="w-full text-left px-4 py-2.5 hover:bg-gray-50 flex items-center gap-3">
                  <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                  </svg>
                  Sign in
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default function App() {
  if (window.location.pathname === '/help') return <HelpPage />
  if (window.location.pathname === '/bios') {
    // Bio page needs roster — render after data loads
    return <BiosRoute />
  }
  const { data, loading, error, refresh, invalidate } = useSupabaseData()
  const { user, loading: authLoading, signIn, signOut } = useAuth()

  // Auto-bind athlete email on first sign-in: when the signed-in user's Google
  // display name matches a roster entry whose email is still null, write the
  // email server-side. Validated by /api/bind-athlete-email (domain check +
  // atomic NULL-only PATCH). One-shot per user; safe to fire repeatedly because
  // the API returns alreadyBound for matches and 409 for conflicts.
  const autoBoundRef = useRef(false)
  useEffect(() => {
    if (autoBoundRef.current) return
    if (!user || !data?.roster) return
    const userName = user.user_metadata?.full_name ?? user.user_metadata?.name ?? ''
    const userEmail = user.email
    if (!userName || !userEmail) return
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
    const match = data.roster.find(r => norm(r.name) === norm(userName))
    if (!match) return
    if (match.email && match.email.toLowerCase() === userEmail.toLowerCase()) {
      autoBoundRef.current = true
      return
    }
    if (match.email) return // already bound to someone else; coach must fix
    autoBoundRef.current = true
    fetch('/api/bind-athlete-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: userName, email: userEmail }),
    })
      .then(r => r.json())
      .then(j => { if (j?.bound) invalidate() })
      .catch(() => {})
  }, [user, data?.roster, invalidate])

  // URL ?athlete= takes priority over localStorage
  const [selectedAthlete, setSelectedAthlete] = useState<string | null>(() =>
    _urlAthlete ? decodeURIComponent(_urlAthlete) : readAthleteFromStorage()
  )

  // Keep a ref so popstate can access latest setter without stale closure
  const setAthleteRef = useRef(setSelectedAthlete)
  setAthleteRef.current = setSelectedAthlete

  // Restore view from sessionStorage (saved before OAuth redirect by AuthGate)
  const [view, setView] = useState<View>(() => {
    const saved = sessionStorage.getItem('xctf-return-view') as View | null
    if (saved) {
      sessionStorage.removeItem('xctf-return-view')
      return saved
    }
    const urlView = new URLSearchParams(window.location.search).get('view') as View | null
    if (urlView && ['coach-dashboard', 'print'].includes(urlView)) return urlView
    return 'athlete'
  })

  // Push history entry on view change so browser back button works
  const navigateTo = useCallback((next: View) => {
    const url = next === 'athlete'
      ? window.location.pathname
      : `${window.location.pathname}?view=${next}`
    window.history.pushState({ view: next }, '', url)
    setView(next)
  }, [])

  // Also push when athlete is selected/deselected
  const selectAthlete = useCallback((name: string | null) => {
    const url = name
      ? `${window.location.pathname}?athlete=${encodeURIComponent(name)}`
      : window.location.pathname
    window.history.pushState({ view: 'athlete', athlete: name }, '', url)
    setSelectedAthlete(name)
    saveAthleteToStorage(name)
  }, [])

  // Handle browser back/forward
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const state = e.state as { view?: View; athlete?: string | null } | null
      const params = new URLSearchParams(window.location.search)
      if (state?.view) setView(state.view)
      else {
        const urlView = params.get('view') as View | null
        setView(urlView && ['coach-dashboard', 'print'].includes(urlView) ? urlView : 'athlete')
      }
      if ('athlete' in (state ?? {})) {
        setAthleteRef.current(state!.athlete ?? null)
      } else {
        const p = params.get('athlete')
        setAthleteRef.current(p ? decodeURIComponent(p) : null)
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const closePrint = useCallback(() => navigateTo('athlete'), [navigateTo])

  // When returning from Google OAuth, auto-select athlete if their name matches roster
  useEffect(() => {
    if (!_isGoogleReturn || !user || !data) return
    const googleName = (user.user_metadata?.full_name ?? user.user_metadata?.name) as string | undefined
    if (!googleName) return
    const match = data.roster.find(r => r.name === googleName)
    if (match) {
      selectAthlete(match.name)
      window.history.replaceState(null, '', `${window.location.pathname}?athlete=${encodeURIComponent(match.name)}`)
      fetch('/api/athlete-ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ athlete: match.name }),
      }).catch(() => {})
    }
  }, [user?.id, data?.roster])

  if (loading && !data) {
    return <LoadingSpinner message="Loading workouts..." />
  }

  if (error && !data) {
    return <ErrorDisplay message={error} onRetry={refresh} />
  }

  if (!data) {
    return <ErrorDisplay message="No data available" onRetry={refresh} />
  }

  if (view === 'print') {
    return <PrintView data={data} onClose={closePrint} />
  }

  if (view === 'coach-dashboard') {
    return (
      <AuthGate
        data={data}
        onBack={() => navigateTo('athlete')}
        onSaved={invalidate}
      />
    )
  }

  // Athlete picker
  if (!selectedAthlete) {
    return (
      <div className="min-h-screen bg-slate-50">
        <header className="bg-navy-900 text-white px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={SCHOOL_LOGO || '/team-logo.png'} alt="" className="h-8 w-8 rounded-full" />
            <h1 className="text-lg font-bold">{TEAM_NAME}</h1>
          </div>
          <div className="flex items-center gap-2">
            {user ? (
              <a
                href="/bios"
                className="px-3 py-1.5 text-sm bg-navy-700 rounded-lg hover:bg-navy-600 active:bg-navy-500 transition-colors"
              >
                Bios
              </a>
            ) : (
              <button
                onClick={signIn}
                disabled={authLoading}
                className="px-3 py-1.5 text-sm font-medium bg-amber-500 text-white rounded-lg hover:bg-amber-600 active:bg-amber-700 transition-colors disabled:opacity-50"
              >
                Sign in
              </button>
            )}
            <HamburgerMenu
              onRefresh={refresh}
              onEdit={() => navigateTo('coach-dashboard')}
              onPrint={() => navigateTo('print')}
              user={user}
              onSignIn={signIn}
              onSignOut={signOut}
              authLoading={authLoading}
            />
          </div>
        </header>
        <AthletePicker
          roster={data.roster}
          onSelect={selectAthlete}
        />
      </div>
    )
  }

  // Workout card
  const workout = findWorkoutForAthlete(selectedAthlete, data.workoutRows)
  const rosterEntry = findRosterEntry(selectedAthlete, data.roster)
  const groupMates = workout ? findGroupMates(selectedAthlete, workout, data.roster) : []

  const activeRoster = data.roster.filter(r => !r.inactive)
  const currentIdx = activeRoster.findIndex(r => r.name === selectedAthlete)
  const prevAthlete = currentIdx > 0 ? activeRoster[currentIdx - 1].name : null
  const nextAthlete = currentIdx >= 0 && currentIdx < activeRoster.length - 1 ? activeRoster[currentIdx + 1].name : null

  // Mileage edit auth: isSelf when the signed-in email matches the roster row's
  // email (preferred — explicit binding); isCoach when email is authorized
  // (VITE_AUTHORIZED_COACHES or the Settings-tab coach list). Either grants
  // edit. We deliberately do NOT fall back to display-name matching here: the
  // auto-bind effect above writes matching names' emails on first sign-in, so
  // this stays tight.
  const userEmailLower = user?.email?.toLowerCase() ?? ''
  const isSelf = !!userEmailLower
    && !!rosterEntry?.email
    && rosterEntry.email.toLowerCase() === userEmailLower
  const isCoach = !!user && isAuthorizedCoach(user.email, data.coaches)
  const canEditMileage = isSelf || isCoach
  const signedInAs = user?.email ?? null

  // Offseason mode: progress card always shown.
  //   - No workout assignment → standalone OffseasonCard (target + progress).
  //   - Has a workout assignment → WorkoutCard with the offseason panel banner above.
  if (rosterEntry?.offseason && !workout) {
    return (
      <OffseasonCard
        athleteName={selectedAthlete}
        rosterEntry={rosterEntry}
        onSwitchAthlete={() => selectAthlete(null)}
        onPrevAthlete={prevAthlete ? () => selectAthlete(prevAthlete) : undefined}
        onNextAthlete={nextAthlete ? () => selectAthlete(nextAthlete) : undefined}
        isAuthenticated={!!user}
        canEditMileage={canEditMileage}
        signedInAs={signedInAs}
        onSignIn={signIn}
        planTemplates={data.planTemplates}
        timezone={data.timezone}
      />
    )
  }

  return (
    <WorkoutCard
      athleteName={selectedAthlete}
      workout={workout}
      groupMates={groupMates}
      rosterEntry={rosterEntry}
      preRunRoutine={data.preRunRoutine}
      postRunRoutine={data.postRunRoutine}
      videoLabel={data.videoLabel}
      videoUrl={data.videoUrl}
      isAuthenticated={!!user}
      onSwitchAthlete={() => selectAthlete(null)}
      onPrevAthlete={prevAthlete ? () => selectAthlete(prevAthlete) : undefined}
      onNextAthlete={nextAthlete ? () => selectAthlete(nextAthlete) : undefined}
      onRefresh={refresh}
      showOffseasonPanel={!!rosterEntry?.offseason}
      onSignIn={signIn}
      canEditMileage={canEditMileage}
      signedInAs={signedInAs}
      planTemplates={data.planTemplates}
      timezone={data.timezone}
    />
  )
}
