import { useEffect, useMemo, useState, useCallback } from 'react'
import type { User } from '@supabase/supabase-js'
import type { Course, CourseAssignment, XcResult } from '../lib/types.ts'
import { fetchXcResults, fetchCourses, fetchCourseAssignments, saveCourses } from '../lib/db.ts'
import { raceKey, suggestCourses, type Race } from '../lib/courses.ts'
import { SCHOOL_LOGO } from '../config.ts'

type Tab = 'courses' | 'leaderboards'

function uuid() {
  return crypto.randomUUID()
}

export function StatsView({ user, onBack, onSignOut }: { user: User; onBack: () => void; onSignOut: () => void }) {
  const [tab, setTab] = useState<Tab>('courses')
  const [results, setResults] = useState<XcResult[]>([])
  const [courses, setCourses] = useState<Course[]>([])
  // raceKey -> courseId (null/absent = unassigned)
  const [assign, setAssign] = useState<Record<string, string | null>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    Promise.all([fetchXcResults(), fetchCourses(), fetchCourseAssignments()])
      .then(([res, crs, asg]) => {
        setResults(res)
        setCourses(crs)
        const m: Record<string, string | null> = {}
        for (const a of asg) m[a.raceKey] = a.courseId
        setAssign(m)
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Load failed'))
      .finally(() => setLoading(false))
  }, [])

  // Distinct races across all results: raceKey -> {meet, season, event, count}.
  const races = useMemo(() => {
    const m = new Map<string, Race>()
    for (const r of results) {
      const k = raceKey(r.meet, r.season, r.event)
      const e = m.get(k)
      if (e) e.count++
      else m.set(k, { meet: r.meet, season: r.season, event: r.event, count: 1 })
    }
    return m
  }, [results])

  const unassignedRaces = useMemo(
    () => [...races.entries()].filter(([k]) => !assign[k]).map(([, r]) => r),
    [races, assign],
  )
  const suggestions = useMemo(() => suggestCourses(unassignedRaces), [unassignedRaces])

  const setRaceCourse = (meet: string, season: string, event: string, courseId: string | null) => {
    setAssign(a => ({ ...a, [raceKey(meet, season, event)]: courseId }))
    setDirty(true)
  }
  const updateCourse = (id: string, patch: Partial<Course>) => {
    setCourses(cs => cs.map(c => c.id === id ? { ...c, ...patch } : c))
    setDirty(true)
  }
  const addCourse = (init?: Partial<Course>): string => {
    const id = uuid()
    setCourses(cs => [...cs, { id, name: init?.name ?? '', location: '', distanceLabel: init?.distanceLabel ?? '', notes: '' }])
    setDirty(true)
    return id
  }
  const deleteCourse = (id: string) => {
    if (!confirm('Delete this course? Its races become unassigned.')) return
    setCourses(cs => cs.filter(c => c.id !== id))
    setAssign(a => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v === id ? null : v])))
    setDirty(true)
  }
  // Assign every race in a suggestion to a course (new or existing).
  const assignSuggestion = (raceList: Race[], courseId: string) => {
    setAssign(a => {
      const next = { ...a }
      for (const r of raceList) next[raceKey(r.meet, r.season, r.event)] = courseId
      return next
    })
    setDirty(true)
  }

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const assignments: CourseAssignment[] = []
      for (const [k, r] of races.entries()) {
        const courseId = assign[k]
        if (courseId) assignments.push({ raceKey: k, meet: r.meet, season: r.season, event: r.event, courseId })
      }
      // Drop blank courses (no name) that have no assignments.
      const usedIds = new Set(assignments.map(a => a.courseId))
      const keepCourses = courses.filter(c => c.name.trim() || usedIds.has(c.id))
      await saveCourses(keepCourses, assignments)
      setCourses(keepCourses)
      setSavedAt(new Date())
      setDirty(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [races, assign, courses])

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-navy-900 text-white px-4 py-3 flex items-center justify-between sticky top-0 z-30">
        <button onClick={onBack} className="flex items-center gap-2 hover:opacity-80">
          <img src={SCHOOL_LOGO || '/team-logo.jpg'} alt="" className="h-7 w-7 rounded-full" />
          <span className="font-bold">Stats</span>
        </button>
        <div className="flex items-center gap-3 text-sm">
          {saving ? <span className="text-navy-300">Saving…</span>
            : dirty ? <button onClick={handleSave} className="px-3 py-1.5 bg-blue-600 rounded-lg font-medium hover:bg-blue-700">Save</button>
            : savedAt ? <span className="text-navy-300">Saved</span> : null}
          <span className="text-navy-400 hidden sm:inline">{user.email}</span>
          <button onClick={onSignOut} className="text-navy-300 hover:text-white">Sign out</button>
        </div>
      </header>

      <div className="flex gap-1 px-4 pt-3 bg-navy-900">
        {(['courses', 'leaderboards'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-t-lg text-sm font-medium ${tab === t ? 'bg-slate-50 text-navy-900' : 'text-navy-200 hover:bg-navy-800'}`}
          >
            {t === 'courses' ? 'Courses' : 'Leaderboards'}
          </button>
        ))}
      </div>

      {error && <div className="bg-red-50 text-red-700 text-sm px-4 py-2">{error}</div>}

      {loading ? (
        <div className="p-8 text-center text-gray-400">Loading {results.length ? '' : 'XC results'}…</div>
      ) : tab === 'courses' ? (
        <CoursesTab
          courses={courses}
          suggestions={suggestions}
          races={races}
          assign={assign}
          onAddCourse={addCourse}
          onUpdateCourse={updateCourse}
          onDeleteCourse={deleteCourse}
          onAssignSuggestion={assignSuggestion}
          onSetRaceCourse={setRaceCourse}
        />
      ) : (
        <LeaderboardsTab results={results} courses={courses} assign={assign} />
      )}
    </div>
  )
}

// ─── Courses tab ──────────────────────────────────────────────────────────────
function CoursesTab({
  courses, suggestions, races, assign,
  onAddCourse, onUpdateCourse, onDeleteCourse, onAssignSuggestion, onSetRaceCourse,
}: {
  courses: Course[]
  suggestions: ReturnType<typeof suggestCourses>
  races: Map<string, Race>
  assign: Record<string, string | null>
  onAddCourse: (init?: Partial<Course>) => string
  onUpdateCourse: (id: string, patch: Partial<Course>) => void
  onDeleteCourse: (id: string) => void
  onAssignSuggestion: (races: Race[], courseId: string) => void
  onSetRaceCourse: (meet: string, season: string, event: string, courseId: string | null) => void
}) {
  const assignedCount = Object.values(assign).filter(Boolean).length
  const total = races.size

  // Races assigned to each course, for the per-course review list.
  const racesByCourse = useMemo(() => {
    const m = new Map<string, Race[]>()
    for (const [k, r] of races.entries()) {
      const cid = assign[k]
      if (!cid) continue
      const arr = m.get(cid) ?? []
      arr.push(r)
      m.set(cid, arr)
    }
    return m
  }, [races, assign])

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-6">
      <p className="text-xs text-gray-500">
        {assignedCount} of {total} races assigned to a course · {courses.length} courses
      </p>

      {/* Unassigned races, grouped into suggested courses */}
      <section>
        <h2 className="text-sm font-bold text-gray-700 mb-2">Suggested courses ({suggestions.length})</h2>
        {suggestions.length === 0 ? (
          <p className="text-sm text-gray-400">All races are assigned. 🎉</p>
        ) : (
          <div className="space-y-3">
            {suggestions.map(s => (
              <div key={s.key} className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-gray-900">{s.label}</div>
                    <div className="text-xs text-gray-500">{s.races.length} race{s.races.length > 1 ? 's' : ''} · {s.totalResults} results</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      defaultValue=""
                      onChange={e => {
                        const v = e.target.value
                        e.target.value = ''
                        if (!v) return
                        let cid: string
                        if (v === '__new__') {
                          const suggested = s.label.replace(/ ~.*$/, '')
                          const name = window.prompt('Name this course:', suggested)
                          if (name === null) return // cancelled
                          cid = onAddCourse({ name: name.trim() || suggested, distanceLabel: s.label.match(/~(.+)$/)?.[1] ?? '' })
                        } else {
                          cid = v
                        }
                        onAssignSuggestion(s.races, cid)
                      }}
                      className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
                    >
                      <option value="">Assign to…</option>
                      <option value="__new__">+ New course from this group…</option>
                      {courses.filter(c => c.name.trim()).map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <ul className="mt-2 text-xs text-gray-600 space-y-0.5">
                  {s.races.map(r => (
                    <li key={raceKey(r.meet, r.season, r.event)}>· {r.meet} · {r.season} · {r.event} ({r.count})</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Defined courses */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-bold text-gray-700">Courses</h2>
          <button onClick={() => onAddCourse()} className="text-sm text-blue-600 hover:text-blue-800">+ Add course</button>
        </div>
        <div className="space-y-3">
          {courses.length === 0 && <p className="text-sm text-gray-400">No courses yet — assign a suggestion above to create one.</p>}
          {courses.map(c => {
            const rs = (racesByCourse.get(c.id) ?? []).sort((a, b) => b.season.localeCompare(a.season))
            return (
              <div key={c.id} className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex flex-wrap gap-2 items-center">
                  <input
                    value={c.name}
                    onChange={e => onUpdateCourse(c.id, { name: e.target.value })}
                    placeholder="Course name"
                    className="flex-1 min-w-[10rem] border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-medium"
                  />
                  <input
                    value={c.distanceLabel}
                    onChange={e => onUpdateCourse(c.id, { distanceLabel: e.target.value })}
                    placeholder="Distance (5K)"
                    className="w-24 border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
                  />
                  <input
                    value={c.location}
                    onChange={e => onUpdateCourse(c.id, { location: e.target.value })}
                    placeholder="Location"
                    className="w-40 border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
                  />
                  <button onClick={() => onDeleteCourse(c.id)} className="text-xs text-red-500 hover:text-red-700 px-1">✕</button>
                </div>
                {rs.length > 0 && (
                  <ul className="mt-2 text-xs text-gray-500 space-y-0.5">
                    {rs.map(r => {
                      const k = raceKey(r.meet, r.season, r.event)
                      return (
                        <li key={k} className="flex items-center justify-between">
                          <span>{r.meet} · {r.season} · {r.event}</span>
                          <button onClick={() => onSetRaceCourse(r.meet, r.season, r.event, null)} className="text-gray-300 hover:text-red-500" title="Unassign">unassign</button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

// ─── Leaderboards tab ───────────────────────────────────────────────────────
function LeaderboardsTab({ results, courses, assign }: {
  results: XcResult[]
  courses: Course[]
  assign: Record<string, string | null>
}) {
  const namedCourses = courses.filter(c => c.name.trim())
  const [courseId, setCourseId] = useState<string>(namedCourses[0]?.id ?? '')
  const [gender, setGender] = useState<'all' | 'M' | 'F'>('all')
  const [season, setSeason] = useState<string>('all')

  // Results whose race is assigned to the selected course.
  const courseResults = useMemo(
    () => results.filter(r => assign[raceKey(r.meet, r.season, r.event)] === courseId),
    [results, assign, courseId],
  )
  const seasons = useMemo(
    () => [...new Set(courseResults.map(r => r.season))].sort((a, b) => b.localeCompare(a)),
    [courseResults],
  )

  // Best (lowest seconds) result per athlete, after gender/season filter.
  const leaderboard = useMemo(() => {
    const best = new Map<string, XcResult>()
    for (const r of courseResults) {
      if (gender !== 'all' && r.gender !== gender) continue
      if (season !== 'all' && r.season !== season) continue
      if (r.markSeconds == null) continue
      const cur = best.get(r.athleteId)
      if (!cur || (cur.markSeconds ?? Infinity) > r.markSeconds) best.set(r.athleteId, r)
    }
    return [...best.values()].sort((a, b) => (a.markSeconds ?? 0) - (b.markSeconds ?? 0))
  }, [courseResults, gender, season])

  if (namedCourses.length === 0) {
    return <div className="max-w-4xl mx-auto p-8 text-center text-gray-400 text-sm">Define and assign courses first (Courses tab).</div>
  }

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-4">
      <div className="flex flex-wrap gap-2">
        <select value={courseId} onChange={e => { setCourseId(e.target.value); setSeason('all') }} className="border border-gray-300 rounded-lg px-3 py-2 text-sm font-medium">
          {namedCourses.map(c => <option key={c.id} value={c.id}>{c.name}{c.distanceLabel ? ` (${c.distanceLabel})` : ''}</option>)}
        </select>
        <select value={gender} onChange={e => setGender(e.target.value as 'all' | 'M' | 'F')} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
          <option value="all">All</option>
          <option value="M">Boys</option>
          <option value="F">Girls</option>
        </select>
        <select value={season} onChange={e => setSeason(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
          <option value="all">All seasons</option>
          {seasons.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="px-3 py-2 text-right w-10">#</th>
              <th className="px-3 py-2 text-left">Athlete</th>
              <th className="px-3 py-2 text-right">Time</th>
              <th className="px-3 py-2 text-center w-12">Gr</th>
              <th className="px-3 py-2 text-left">Season</th>
              <th className="px-3 py-2 text-left hidden sm:table-cell">Meet</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {leaderboard.map((r, i) => (
              <tr key={r.athleteId} className="hover:bg-slate-50">
                <td className="px-3 py-1.5 text-right text-gray-400">{i + 1}</td>
                <td className="px-3 py-1.5 font-medium text-gray-800">{r.athleteName}</td>
                <td className="px-3 py-1.5 text-right font-mono">{r.mark}</td>
                <td className="px-3 py-1.5 text-center text-gray-500">{r.grade ?? ''}</td>
                <td className="px-3 py-1.5 text-gray-500">{r.season}</td>
                <td className="px-3 py-1.5 text-gray-500 hidden sm:table-cell truncate max-w-[16rem]">{r.meet}</td>
              </tr>
            ))}
            {leaderboard.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">No results for this filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
