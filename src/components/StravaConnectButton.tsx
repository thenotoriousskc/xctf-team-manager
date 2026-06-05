import { useEffect, useState } from 'react'

// Shared Connect-Strava button + redirect-status message. Callers decide WHEN
// to show it (athlete viewing their own card, not yet connected); this renders
// the button and surfaces limit/error status from the OAuth redirect
// (?strava_athlete=...), clearing the param afterward.
//
// When `limitFull` (the team's Strava slots are all used) the button is hidden
// and only the explanation shows — clicking would just bounce back as a limit
// error, so there's no point offering it.
export function StravaConnectButton({ athleteName, limitFull = false }: { athleteName: string; limitFull?: boolean }) {
  const [msg] = useState<'error' | 'limit' | null>(() => {
    const p = new URLSearchParams(window.location.search).get('strava_athlete')
    return p === 'error' || p === 'limit' ? p : null
  })
  useEffect(() => {
    if (!msg) return
    const params = new URLSearchParams(window.location.search)
    params.delete('strava_athlete')
    window.history.replaceState(null, '', `${window.location.pathname}${params.toString() ? `?${params}` : ''}`)
  }, [msg])

  const showLimit = limitFull || msg === 'limit'

  return (
    <div className="flex flex-col items-center gap-2">
      {showLimit ? (
        <p className="text-xs text-center text-amber-600">
          The team's Strava connection limit is full. Ask your coach — log your miles manually for now.
        </p>
      ) : (
        <>
          {msg === 'error' && (
            <p className="text-xs text-center text-red-500">
              Strava couldn't connect. Try again, or log your miles manually.
            </p>
          )}
          <a
            href={`/api/strava/athlete-auth?athlete=${encodeURIComponent(athleteName)}`}
            className="block mx-auto w-fit"
          >
            <img src="/btn-strava-connect.svg" alt="Connect with Strava" className="h-12" />
          </a>
        </>
      )}
    </div>
  )
}
