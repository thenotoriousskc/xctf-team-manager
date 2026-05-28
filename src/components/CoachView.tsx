import type { SheetData } from '../lib/types.ts'
import { SCHOOL_LOGO, TEAM_NAME } from '../config.ts'
import { RoutineBar } from './RoutineBar.tsx'
import { VideoEmbed } from './VideoEmbed.tsx'
import { buildOffseasonWorkoutRow, OFFSEASON_FOCUS } from '../lib/sheets.ts'

export function CoachView({
  data,
  onBack,
  onRefresh,
  onPrint,
}: {
  data: SheetData
  onBack: () => void
  onRefresh: () => void
  onPrint: () => void
}) {
  // Build the synthetic offseason group (if any) and append it to the list.
  const offseasonRow = buildOffseasonWorkoutRow(data.roster, data.workoutRows)
  const allRows = offseasonRow ? [...data.workoutRows, offseasonRow] : data.workoutRows

  // Group workout rows by coach
  const byCoach = new Map<string, typeof allRows>()
  for (const row of allRows) {
    const coach = row.focus === OFFSEASON_FOCUS ? OFFSEASON_FOCUS : (row.coach || 'Unassigned')
    if (!byCoach.has(coach)) byCoach.set(coach, [])
    byCoach.get(coach)!.push(row)
  }

  function parseAthletes(raw: string): string[] {
    return raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
  }

  // Per-athlete roster notes for a workout row
  function rosterNotes(row: { athletesRaw: string }) {
    const rawLower = row.athletesRaw.toLowerCase()
    return data.roster
      .filter(r => r.note && rawLower.includes(r.name.toLowerCase()))
      .map(r => ({ name: r.name, note: r.note }))
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-navy-900 text-white px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src={SCHOOL_LOGO || '/team-logo.png'} alt="" className="h-8 w-8 rounded-full" />
          <div>
            <h1 className="text-lg font-bold">{TEAM_NAME}</h1>
            <p className="text-navy-300 text-xs">Coach&apos;s View</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onPrint}
            className="p-2 rounded-lg hover:bg-navy-800 active:bg-navy-700 transition-colors"
            title="Print"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
          </button>
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
            onClick={onBack}
            className="px-3 py-1.5 text-sm bg-navy-700 rounded-lg hover:bg-navy-600 active:bg-navy-500 transition-colors"
          >
            Athletes
          </button>
        </div>
      </header>

      <div className="p-4 space-y-3 max-w-2xl mx-auto">
        <RoutineBar label="Pre-Run Routine" content={data.preRunRoutine} />

        {[...byCoach.entries()].map(([coach, rows]) => (
          <div key={coach} className="bg-white rounded-xl overflow-hidden">
            <div className="bg-navy-50 px-4 py-2 border-b border-navy-100">
              <h2 className="text-sm font-bold text-navy-700">{coach}</h2>
            </div>

            <div className="p-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {rows.map((row, i) => {
                const athletes = parseAthletes(row.athletesRaw)
                const notes = rosterNotes(row)
                return (
                  <div key={i} className="bg-slate-50 rounded-lg p-3 space-y-2">
                    {/* Focus tag + workout */}
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-navy-800 font-medium text-sm whitespace-pre-wrap leading-snug">{row.workout}</p>
                      {row.focus && (
                        <span className="shrink-0 inline-block px-2 py-0.5 bg-navy-100 text-navy-700 rounded-full text-xs font-semibold">
                          {row.focus}
                        </span>
                      )}
                    </div>

                    {/* Athletes with pace */}
                    <div className="space-y-0.5">
                      {athletes.map((name, j) => (
                        <div key={j} className="flex items-baseline justify-between gap-2">
                          <span className="font-semibold text-navy-900 text-sm">{name}</span>
                          {row.paceEffort && (
                            <span className="text-xs text-blue-600 font-medium shrink-0">{row.paceEffort}</span>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Workout notes */}
                    {row.notes && (
                      <p className="text-xs text-navy-600 whitespace-pre-wrap border-t border-slate-200 pt-1.5">{row.notes}</p>
                    )}

                    {/* Per-athlete roster notes */}
                    {notes.length > 0 && (
                      <div className="space-y-0.5 border-t border-slate-200 pt-1.5">
                        {notes.map((n, j) => (
                          <p key={j} className="text-xs text-amber-700"><span className="font-semibold">{n.name}:</span> {n.note}</p>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}

        <RoutineBar label="Post-Run Routine" content={data.postRunRoutine} />

        <VideoEmbed url={data.videoUrl} label={data.videoLabel} />
      </div>
    </div>
  )
}
