import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SheetData, WorkoutSegment } from '../lib/types.ts'
import { loadPRsFile, findAthleteId } from '../hooks/useAthleticNetPRs.ts'
import type { PRsFile } from '../hooks/useAthleticNetPRs.ts'
import { effectivePaces, computeTempoPace, parseTimeSecs } from '../lib/vdot.ts'
import { buildOffseasonWorkoutRow } from '../lib/sheets.ts'

const PORTRAIT_WIDTH = 720
const PORTRAIT_HEIGHT = 960

function useZoomToFit(
  ref: React.RefObject<HTMLDivElement | null>,
  printWidth: number,
  printHeight: number,
  deps: unknown[],
) {
  const [zoom, setZoom] = useState(1)
  useLayoutEffect(() => {
    if (!ref.current) return
    const el = ref.current
    el.style.zoom = '1'
    el.style.width = `${printWidth}px`
    const natural = el.scrollHeight
    if (natural > printHeight) {
      setZoom(printHeight / natural)
    } else {
      setZoom(1)
    }
    el.style.width = ''
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return zoom
}

export function PrintView({
  data,
  onClose,
}: {
  data: SheetData
  onClose: () => void
}) {
  const page1Ref = useRef<HTMLDivElement>(null)
  const page2Ref = useRef<HTMLDivElement>(null)
  const zoom2 = useZoomToFit(page2Ref, PORTRAIT_WIDTH, PORTRAIT_HEIGHT, [data.roster])
  const [prsFile, setPrsFile] = useState<PRsFile | null>(null)
  useEffect(() => { loadPRsFile().then(setPrsFile).catch(() => {}) }, [])

  const [teamMileage, setTeamMileage] = useState<Record<string, { currentWeek: number; lastWeek: number }>>({})
  useEffect(() => { fetch('/api/team-mileage').then(r => r.json()).then(setTeamMileage).catch(() => {}) }, [])

  useEffect(() => {
    const timeout = setTimeout(() => window.print(), 800)
    const handleAfterPrint = () => onClose()
    window.addEventListener('afterprint', handleAfterPrint)
    return () => {
      clearTimeout(timeout)
      window.removeEventListener('afterprint', handleAfterPrint)
    }
  }, [onClose])

  const RACE_PACES_MAP: Partial<Record<string, { meters: number; re: RegExp }>> = {
    '400':  { meters: 400,  re: /^400\b/i },
    '800':  { meters: 800,  re: /^800\b/i },
    '1600': { meters: 1600, re: /1600|mile/i },
    '3200': { meters: 3200, re: /3200|2\s*mile/i },
    '5k':   { meters: 5000, re: /5.?k|3.?mile/i },
  }

  function paceStrToSecs(p: string): number {
    const [m, s] = p.split(':').map(Number)
    return m * 60 + (s || 0)
  }
  function secsToStr(s: number): string {
    return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
  }

  function athletePaceLabels(athleteName: string, segments: WorkoutSegment[]): string[] {
    if (!prsFile) return []
    const id = findAthleteId(prsFile, athleteName)
    if (!id) return []
    const prs = prsFile[id].prs
    const rosterEntry = data.roster.find(r => r.name === athleteName)
    const paces = effectivePaces(rosterEntry?.vdot, prs)

    const parts: string[] = []

    for (const seg of segments) {
      const distLabel = seg.unit === 'meters' ? `${seg.distance}`
        : seg.unit === 'miles' ? `${seg.distance}mi`
        : `${seg.distance}min`

      if (seg.pace === 'easy') {
        if (!paces) continue
        parts.push(`${distLabel} @ ${paces.easyFast}–${paces.easySlow}/mi`)
      } else if (seg.pace === 'threshold') {
        if (!paces) continue
        parts.push(`${distLabel} @ ${paces.threshold}/mi`)
      } else if (seg.pace === 'tempo') {
        if (!paces) continue
        let durationMins = 4
        if (seg.unit === 'minutes') {
          durationMins = parseFloat(seg.distance) || 4
        } else {
          const segM = seg.unit === 'miles' ? parseFloat(seg.distance) * 1609.34 : parseFloat(seg.distance)
          const [tm, ts] = paces.threshold.split(':').map(Number)
          const threshMperMin = 1609.34 / (tm * 60 + (ts || 0)) * 60
          durationMins = segM / threshMperMin
        }
        const tp = computeTempoPace(paces.vdot, durationMins)
        const slowSecs = paceStrToSecs(tp.mile) + 10
        parts.push(`${distLabel} @ ${tp.mile}–${secsToStr(slowSecs)}/mi`)
      } else {
        const rp = RACE_PACES_MAP[seg.pace]
        if (!rp) continue
        const pr = prs.find(p => rp.re.test(p.event) && !/relay/i.test(p.event))
        if (!pr) continue
        const prSecs = parseTimeSecs(pr.mark)
        if (!prSecs) continue
        if (seg.unit === 'minutes') continue
        const segM = seg.unit === 'miles' ? parseFloat(seg.distance) * 1609.34 : parseFloat(seg.distance)
        const targetSecs = (segM / rp.meters) * prSecs
        const mins = Math.floor(targetSecs / 60)
        const secs = (targetSecs % 60).toFixed(1)
        const time = mins > 0 ? `${mins}:${secs.padStart(4, '0')}` : secs
        parts.push(`${distLabel} @ ${time}`)
      }
    }
    return parts
  }

  // Build athlete notes for each workout row
  function athleteNotes(row: { athletesRaw: string; notes: string }) {
    const rawLower = row.athletesRaw.toLowerCase()
    const notes = data.roster
      .filter(r => r.note && rawLower.includes(r.name.toLowerCase()))
      .map(r => `${r.name} - ${r.note}`)
    const parts = [row.notes, ...notes].filter(Boolean)
    return parts.join('\n')
  }

  // Sort workout rows by focus for page 1, skip empty groups, append offseason at the end
  const offseasonRow = buildOffseasonWorkoutRow(data.roster, data.workoutRows)
  const sortedWorkouts = [
    ...[...data.workoutRows]
      .filter(row => row.athletesRaw.split('\n').map(n => n.trim()).some(Boolean))
      .sort((a, b) => a.focus.localeCompare(b.focus)),
    ...(offseasonRow ? [offseasonRow] : []),
  ]

  const sorted = [...data.roster].filter(r => !r.inactive).sort((a, b) => a.name.localeCompare(b.name))
  const half = Math.ceil(sorted.length / 2)
  const col1 = sorted.slice(0, half)
  const col2 = sorted.slice(half)

  return createPortal(
    <div className="print-view bg-white text-black">
      {/* Page 1+: Workouts (portrait) - big fixed fonts, may span multiple pages */}
      <div
        ref={page1Ref}
        className="print-page-portrait p-6"
        style={{ fontSize: 12, lineHeight: 1.4 }}
      >
        <h1 style={{ fontSize: 22, fontWeight: 'bold', marginBottom: 6 }}>
          Today&apos;s Workout — {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
        </h1>

        {data.preRunRoutine && (
          <div style={{ marginBottom: 8 }}>
            <span style={{ fontWeight: 600 }}>Pre-Run:</span> {data.preRunRoutine}
          </div>
        )}

        <table className="w-full border-collapse" style={{ marginBottom: 8 }}>
          <thead>
            <tr className="border-b-2 border-black">
              <th className="text-left" style={{ width: '22%', padding: '6px 12px 6px 0' }}>Athletes</th>
              <th className="text-left" style={{ width: '10%', padding: '6px 8px 6px 0' }}>Focus</th>
              <th className="text-left" style={{ width: '33%', padding: '6px 8px 6px 0' }}>Workout</th>
              <th className="text-left" style={{ width: '7%', padding: '6px 8px 6px 0' }}>Coach</th>
              <th className="text-left" style={{ width: '28%', padding: '6px 0' }}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {sortedWorkouts.map((row, i) => (
              <tr key={i} className="border-b border-gray-300 align-top">
                <td style={{ padding: '6px 12px 6px 0' }}>
                  {row.athletesRaw.split('\n').map(n => n.trim()).filter(Boolean).map(name => {
                    const paces = athletePaceLabels(name, row.segments)
                    return (
                      <div key={name} style={{ marginBottom: 2 }}>
                        <span style={{ fontSize: 16, fontWeight: 'bold' }}>{name}</span>
                        {paces.length > 0 && (
                          <div style={{ fontSize: 11, color: '#555', lineHeight: 1.3 }}>
                            {paces.join(',  ')}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </td>
                <td style={{ padding: '6px 8px 6px 0' }}>{row.focus}</td>
                <td style={{ padding: '6px 8px 6px 0' }}>
                  {row.warmup && <div style={{ fontSize: 11, color: '#777' }}>WU {row.warmup} min</div>}
                  {row.segments.length > 0 ? (
                    <div>
                      {row.segments.map((seg, si) => (
                        <div key={si}>
                          <span style={{ fontWeight: 600 }}>{seg.qty}×{seg.distance} {seg.unit}</span>
                          <span style={{ color: '#555', marginLeft: 4 }}>@ {seg.pace}</span>
                          {seg.rest === 'full recovery' ? (
                            <span style={{ color: '#888', marginLeft: 4 }}>· full recovery</span>
                          ) : (seg.restDuration && seg.restDuration !== '0') ? (
                            <span style={{ color: '#888', marginLeft: 4 }}>· {seg.restDuration} {seg.rest}</span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ whiteSpace: 'pre-wrap' }}>{row.workout}</div>
                  )}
                  {row.cooldown && <div style={{ fontSize: 11, color: '#777' }}>CD {row.cooldown} min</div>}
                </td>
                <td style={{ padding: '6px 8px 6px 0' }}>{row.coach}</td>
                <td style={{ padding: '6px 0', whiteSpace: 'pre-wrap' }}>{athleteNotes(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {data.postRunRoutine && (
          <div>
            <span style={{ fontWeight: 600 }}>Post-Run:</span> {data.postRunRoutine}
          </div>
        )}
      </div>

      {/* Page 2: Roster - portrait, 2 column layout */}
      <div
        ref={page2Ref}
        className="print-page-portrait p-4 text-lg leading-snug"
        style={{ zoom: zoom2 }}
      >
        <h1 className="text-3xl font-bold mb-2">Roster &amp; Mileage</h1>

        <div className="flex gap-4">
          {[col1, col2].map((col, ci) => (
            <table key={ci} className="flex-1 border-collapse">
              <thead>
                <tr className="border-b-2 border-black">
                  <th className="text-left py-1 pr-2">Name</th>
                  <th className="text-left py-1 pr-2 w-24">Miles</th>
                  <th className="text-left py-1 pr-2">Grp</th>
                  <th className="text-right py-1 pr-1">Wk</th>
                  <th className="text-right py-1">Tgt</th>
                </tr>
              </thead>
              <tbody>
                {col.map((entry, i) => (
                  <tr key={i} className="border-b border-gray-200">
                    <td className="py-0.5 pr-2">{entry.name}</td>
                    <td className="py-0.5 pr-2 w-24">
                      <div className="border border-gray-400 h-5 rounded-sm" />
                    </td>
                    <td className="py-0.5 pr-2">{entry.group}</td>
                    <td className="py-0.5 pr-1 text-right">{teamMileage[entry.name]?.currentWeek ?? ''}</td>
                    <td className="py-0.5 text-right">{entry.target}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
      </div>

      <button
        onClick={onClose}
        className="fixed top-4 right-4 bg-navy-900 text-white px-4 py-2 rounded-lg text-sm print:hidden"
      >
        Close
      </button>
    </div>,
    document.body,
  )
}
