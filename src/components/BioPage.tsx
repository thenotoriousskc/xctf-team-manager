import { useState, useEffect, useRef, useCallback } from 'react'
import type { RosterEntry, AthleteBio } from '../lib/types.ts'
import { supabase } from '../lib/supabase.ts'
import type { User } from '@supabase/supabase-js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchBio(name: string): Promise<AthleteBio | null> {
  const r = await fetch(`/api/athlete-bio?name=${encodeURIComponent(name)}`)
  return r.ok ? r.json() : null
}

async function saveBioField(
  athlete_name: string,
  field_name: string,
  new_value: string | null,
  changed_by: string,
) {
  await fetch('/api/athlete-bio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ athlete_name, field_name, new_value, changed_by }),
  })
}

// ─── Editable field ───────────────────────────────────────────────────────────

function EditableField({
  label,
  value,
  onSave,
  multiline = false,
  placeholder,
}: {
  label: string
  value: string | null
  onSave: (val: string | null) => Promise<void>
  multiline?: boolean
  placeholder?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement>(null)

  useEffect(() => { setDraft(value ?? '') }, [value])
  useEffect(() => { if (editing) ref.current?.focus() }, [editing])

  const commit = useCallback(async () => {
    setSaving(true)
    await onSave(draft.trim() || null)
    setSaving(false)
    setEditing(false)
  }, [draft, onSave])

  const handleKey = (e: React.KeyboardEvent) => {
    if (!multiline && e.key === 'Enter') { e.preventDefault(); commit() }
    if (e.key === 'Escape') { setDraft(value ?? ''); setEditing(false) }
  }

  const displayText = value || <span className="text-gray-400 italic">None</span>

  if (!editing) {
    return (
      <div className="group">
        <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-0.5">{label}</div>
        <div
          className="text-gray-800 whitespace-pre-wrap cursor-pointer rounded px-2 py-1 -mx-2 hover:bg-gray-100 transition-colors"
          onClick={() => setEditing(true)}
        >
          {displayText}
          <span className="ml-2 text-xs text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity">edit</span>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-0.5">{label}</div>
      {multiline ? (
        <textarea
          ref={ref as React.RefObject<HTMLTextAreaElement>}
          rows={3}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={handleKey}
          onBlur={commit}
          placeholder={placeholder}
          className="w-full border border-blue-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none"
        />
      ) : (
        <input
          ref={ref as React.RefObject<HTMLInputElement>}
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={handleKey}
          onBlur={commit}
          placeholder={placeholder}
          className="w-full border border-blue-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
        />
      )}
      {saving && <p className="text-xs text-gray-400 mt-0.5">Saving…</p>}
    </div>
  )
}

// ─── Photo uploader ───────────────────────────────────────────────────────────

function PhotoUploader({
  athleteName,
  photoUrl,
  onUploaded,
  changedBy,
}: {
  athleteName: string
  photoUrl: string | null
  onUploaded: (url: string) => void
  changedBy: string
}) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError(null)

    const ext = file.name.split('.').pop()
    const path = `${athleteName.replace(/\s+/g, '_')}.${ext}`

    const { error: upErr } = await supabase.storage
      .from('athlete-photos')
      .upload(path, file, { upsert: true, contentType: file.type })

    if (upErr) { setError(upErr.message); setUploading(false); return }

    const { data } = supabase.storage.from('athlete-photos').getPublicUrl(path)
    const url = data.publicUrl

    await saveBioField(athleteName, 'photo_url', url, changedBy)
    onUploaded(url)
    setUploading(false)
  }

  return (
    <div className="relative group">
      <div className="w-40 h-40 sm:w-48 sm:h-48 rounded-full overflow-hidden bg-gray-200 flex items-center justify-center mx-auto">
        {photoUrl
          ? <img src={photoUrl} alt={athleteName} className="w-full h-full object-cover" />
          : <span className="text-4xl text-gray-400 select-none">{athleteName[0]}</span>
        }
      </div>
      <label className="absolute inset-0 rounded-full flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer">
        <span className="text-white text-xs font-medium">{uploading ? 'Uploading…' : 'Change photo'}</span>
        <input type="file" accept="image/*" className="sr-only" onChange={handleFile} disabled={uploading} />
      </label>
      {error && <p className="text-xs text-red-500 text-center mt-1">{error}</p>}
    </div>
  )
}

// ─── Season history ───────────────────────────────────────────────────────────

interface PrEntry { event: string; mark: string; date?: string | null; meet?: string | null }
interface HistEntry { event: string; mark: string; date?: string | null; meet?: string | null; is_pb: boolean }

function parseMark(mark: string): number | null {
  if (mark.includes(':')) {
    const parts = mark.replace(/h$/, '').split(':')
    if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1])
  }
  // Feet-inches with quotes: 17' 7", 13' 4.25"
  const quoteField = mark.match(/^(\d+)'\s*(\d+(?:\.\d+)?)"$/)
  if (quoteField) return parseFloat(quoteField[1]) * 12 + parseFloat(quoteField[2])
  const n = parseFloat(mark.replace(/h$/, ''))
  return isNaN(n) ? null : n
}

function isFieldMark(mark: string): boolean {
  return /^\d+'/.test(mark)
}

function abbrevDate(d: string | null | undefined): string {
  if (!d) return ''
  const m = d.match(/^(\w+ \d+)/)
  return m ? m[1] : d
}

function ProgressionChart({ entries }: { event: string; entries: HistEntry[] }) {
  const [hovered, setHovered] = useState<number | null>(null)

  const isField = entries.length > 0 && isFieldMark(entries[0].mark)

  // One point per meet: if an athlete ran A and B relays (or multiple heats)
  // at the same meet, take the BEST mark. Keeps the progression line readable
  // — without this the line zig-zagged between A-relay and B-relay times.
  // Group key is (date | meet) so distinct meets on the same day stay separate.
  const byMeet = new Map<string, HistEntry>()
  for (const e of entries) {
    const key = `${e.date ?? ''}|${e.meet ?? ''}`
    const cur = byMeet.get(key)
    if (!cur) { byMeet.set(key, e); continue }
    const curVal = parseMark(cur.mark)
    const newVal = parseMark(e.mark)
    if (curVal == null) { byMeet.set(key, e); continue }
    if (newVal == null) continue
    // For times: smaller = better; for field: larger = better.
    const newIsBetter = isField ? newVal > curVal : newVal < curVal
    if (newIsBetter) byMeet.set(key, e)
  }

  // Sort oldest→newest so left=old, right=recent
  const sorted = [...byMeet.values()].sort((a, b) => {
    if (!a.date && !b.date) return 0
    if (!a.date) return -1
    if (!b.date) return 1
    return new Date(a.date).getTime() - new Date(b.date).getTime()
  })

  const vals = sorted.map(e => parseMark(e.mark))
  const validVals = vals.filter((v): v is number => v !== null)
  if (validVals.length < 2) return null

  const minVal = Math.min(...validVals)
  const maxVal = Math.max(...validVals)
  const range = maxVal - minVal || 1

  const W = 400, H = 110
  const PAD = { left: 42, right: 8, top: 18, bottom: 18 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const n = sorted.length

  const getX = (i: number) => PAD.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const getY = (val: number) => {
    const norm = (val - minVal) / range
    // Low val → bottom, high val → top (time: slow=top/fast=bottom; field: far=top/near=bottom)
    const yFrac = 1 - norm
    return PAD.top + yFrac * plotH
  }

  const pts = sorted.map((e, i) => ({
    x: getX(i), y: vals[i] !== null ? getY(vals[i]!) : null, e,
  })).filter(p => p.y !== null) as { x: number; y: number; e: HistEntry }[]

  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')

  // Y-axis labels: time → top=slow, bottom=fast; field → top=far, bottom=near
  const topMark = isField ? sorted[vals.indexOf(maxVal)]?.mark : sorted[vals.indexOf(maxVal)]?.mark
  const bottomMark = isField ? sorted[vals.indexOf(minVal)]?.mark : sorted[vals.indexOf(minVal)]?.mark

  const hoveredPt = hovered !== null ? pts[hovered] : null

  return (
    <div className="mt-2 -mx-6 bg-slate-50 border-t border-b border-gray-100">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: 110 }}
        onMouseLeave={() => setHovered(null)}
      >
        {/* Y-axis labels */}
        <text x={PAD.left - 4} y={PAD.top + 3} textAnchor="end" fontSize="9" fill="#94a3b8">{topMark}</text>
        <text x={PAD.left - 4} y={PAD.top + plotH + 3} textAnchor="end" fontSize="9" fill="#94a3b8">{bottomMark}</text>
        {/* Y-axis line */}
        <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + plotH} stroke="#e2e8f0" strokeWidth="1" />

        {/* Data line */}
        <path d={linePath} fill="none" stroke="#94a3b8" strokeWidth="1.5" />

        {/* Dots */}
        {pts.map((p, i) => (
          <g key={i}>
            {p.e.is_pb && (
              <text x={p.x} y={p.y - 7} textAnchor="middle" fontSize="9" fill="#1e3a5f" fontWeight="bold">
                {p.e.mark}
              </text>
            )}
            <circle
              cx={p.x} cy={p.y}
              r={p.e.is_pb ? 4 : 3}
              fill={i === hovered ? '#3b82f6' : p.e.is_pb ? '#1e3a5f' : '#cbd5e1'}
            />
            {/* Large invisible hit area */}
            <circle
              cx={p.x} cy={p.y} r={12} fill="transparent"
              onMouseEnter={() => setHovered(i)}
              onTouchStart={() => setHovered(i === hovered ? null : i)}
            />
          </g>
        ))}

        {/* X-axis: first and last dates */}
        {pts[0]?.e.date && (
          <text x={pts[0].x} y={H - 3} textAnchor="middle" fontSize="8" fill="#9ca3af">
            {abbrevDate(pts[0].e.date)}
          </text>
        )}
        {pts.length > 1 && pts[pts.length - 1]?.e.date && (
          <text x={pts[pts.length - 1].x} y={H - 3} textAnchor="middle" fontSize="8" fill="#9ca3af">
            {abbrevDate(pts[pts.length - 1].e.date)}
          </text>
        )}
      </svg>

      {/* Hover info strip */}
      <div className="px-4 pb-2 min-h-[1.5rem] text-xs text-center text-gray-500">
        {hoveredPt ? (
          <>
            <span className="font-semibold text-navy-800">{hoveredPt.e.mark}</span>
            {hoveredPt.e.date && <span className="ml-1">· {hoveredPt.e.date}</span>}
            {hoveredPt.e.meet && <span className="ml-1">· {hoveredPt.e.meet}</span>}
          </>
        ) : (
          <span className="text-gray-300">hover a point</span>
        )}
      </div>
    </div>
  )
}

function SeasonHistory({ athleteName, athleticNetId }: { athleteName: string; athleticNetId?: string }) {
  const [seasons, setSeasons] = useState<string[]>([])
  const [prs, setPrs] = useState<PrEntry[]>([])
  const [history, setHistory] = useState<HistEntry[]>([])
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null)

  useEffect(() => {
    setSelectedEvent(null)
    fetch('/prs.json')
      .then(r => r.json())
      .then((data: Record<string, { name: string; seasons?: string[]; prs?: PrEntry[]; history?: HistEntry[] }>) => {
        const entry = Object.values(data).find(a => a.name === athleteName)
        if (entry?.seasons) setSeasons(entry.seasons)
        if (entry?.prs) setPrs(entry.prs)
        if (entry?.history) setHistory(entry.history)
      })
      .catch(() => {})
  }, [athleteName])

  if (seasons.length === 0 && prs.length === 0) return null

  const seasonUrl = (label: string) => {
    if (!athleticNetId) return null
    const year = label.match(/^(\d{4})/)?.[1]
    if (!year) return null
    return `https://www.athletic.net/athlete/${athleticNetId}/track-and-field/${year}`
  }

  return (
    <div className="mt-4 pt-4 border-t border-gray-100 space-y-3">
      {prs.length > 0 && (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">PRs</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {prs.map(pr => {
              const eventHistory = history.filter(h => h.event === pr.event)
              const hasChart = eventHistory.length >= 2
              const isSelected = selectedEvent === pr.event
              return (
                <div key={pr.event} className="col-span-2 sm:col-span-1">
                  <button
                    onClick={() => setSelectedEvent(isSelected ? null : pr.event)}
                    className={`w-full flex justify-between items-center text-sm px-1.5 py-0.5 rounded transition-colors text-left ${hasChart ? 'hover:bg-gray-50 cursor-pointer' : 'cursor-default'} ${isSelected ? 'bg-gray-50' : ''}`}
                    disabled={!hasChart}
                  >
                    <span className="text-gray-500 truncate">{pr.event}</span>
                    <span className="font-semibold text-navy-800 ml-2 shrink-0">{pr.mark}</span>
                  </button>
                  {isSelected && (
                    <div className="col-span-2">
                      {(pr.meet || pr.date) && (
                        <p className="text-xs text-center pt-1 pb-0.5 text-gray-500">
                          PR set at {[pr.meet, pr.date].filter(Boolean).join(' · ')}
                        </p>
                      )}
                      <ProgressionChart event={pr.event} entries={eventHistory} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
      {seasons.length > 0 && (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">Seasons</div>
          <div className="flex flex-wrap gap-1.5">
            {seasons.map(s => {
              const url = seasonUrl(s)
              return url ? (
                <a key={s} href={url} target="_blank" rel="noopener noreferrer"
                  className="text-xs bg-navy-50 text-navy-600 border border-navy-200 px-2 py-0.5 rounded-full hover:bg-navy-100 transition-colors">
                  {s}
                </a>
              ) : (
                <span key={s} className="text-xs bg-navy-50 text-navy-600 border border-navy-200 px-2 py-0.5 rounded-full">{s}</span>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Inline nickname in name ──────────────────────────────────────────────────

function NameWithNickname({ fullName, nickname, canEdit, onSave }: {
  fullName: string
  nickname: string | null
  canEdit: boolean
  onSave: (v: string | null) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(nickname ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setDraft(nickname ?? '') }, [nickname])
  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])

  const commit = async () => {
    setEditing(false)
    const val = draft.trim() || null
    if (val !== nickname) await onSave(val)
  }

  const parts = fullName.split(' ')
  const first = parts[0]
  const rest = parts.slice(1).join(' ')

  if (editing) {
    return (
      <div className="flex items-center justify-center gap-1 flex-wrap">
        <span className="text-2xl font-bold text-gray-900">{first}</span>
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(nickname ?? ''); setEditing(false) } }}
          placeholder="nickname"
          className="text-2xl font-normal italic text-gray-500 w-32 text-center border-b border-gray-400 outline-none bg-transparent"
        />
        {rest && <span className="text-2xl font-bold text-gray-900">{rest}</span>}
      </div>
    )
  }

  if (nickname) {
    return (
      <h1 className="text-2xl font-bold text-gray-900">
        {first}{' '}
        <span
          onClick={canEdit ? () => setEditing(true) : undefined}
          className={canEdit ? 'font-normal italic text-gray-500 cursor-pointer hover:text-gray-700 hover:underline underline-offset-2' : 'font-normal italic text-gray-500'}
          title={canEdit ? 'Click to edit nickname' : undefined}
        >
          "{nickname}"
        </span>
        {rest ? ` ${rest}` : ''}
      </h1>
    )
  }

  // No nickname
  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">{fullName}</h1>
      {canEdit && (
        <button
          onClick={() => setEditing(true)}
          className="mt-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
        >
          + Add nickname
        </button>
      )}
    </div>
  )
}

// ─── Roster list ─────────────────────────────────────────────────────────────

function RosterList({ athletes, currentIndex, onSelect }: {
  athletes: RosterEntry[]
  currentIndex: number
  onSelect: (i: number) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="shrink-0 bg-white border-t border-gray-100">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
      >
        <span>Roster ({athletes.length})</span>
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1 px-3 pb-3">
          {athletes.map((a, i) => (
            <button
              key={a.name}
              onClick={() => { onSelect(i); setOpen(false) }}
              className={`text-left px-3 py-1.5 rounded-lg text-sm transition-colors truncate ${
                i === currentIndex
                  ? 'bg-navy-100 text-navy-800 font-semibold'
                  : 'hover:bg-gray-100 text-gray-700'
              }`}
            >
              {a.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main BioPage ─────────────────────────────────────────────────────────────

export function BioPage({
  roster,
  user,
  onBack,
}: {
  roster: RosterEntry[]
  user: User | null
  onBack: () => void
}) {
  const athletes = roster.filter(r => !r.inactive)

  // Initialize index from URL ?name= param (spaces encoded as hyphens)
  const [index, setIndex] = useState(() => {
    const raw = new URLSearchParams(window.location.search).get('name')
    if (raw) {
      const name = raw.replace(/_/g, ' ')
      const i = athletes.findIndex(a => a.name === name)
      if (i >= 0) return i
    }
    return 0
  })

  const [bio, setBio] = useState<AthleteBio | null>(null)
  const [loading, setLoading] = useState(true)

  const athlete = athletes[index]

  // Sync URL when index changes
  useEffect(() => {
    if (!athlete) return
    const url = `/bios?name=${athlete.name.replace(/ /g, '_')}`
    window.history.replaceState({}, '', url)
  }, [athlete?.name])

  // Load bio when athlete changes
  useEffect(() => {
    if (!athlete) return
    setLoading(true)
    setBio(null)
    fetchBio(athlete.name).then(b => { setBio(b); setLoading(false) })
  }, [athlete?.name])


  // Touch swipe
  const touchStartX = useRef<number | null>(null)
  const onTouchStart = (e: React.TouchEvent) => { touchStartX.current = e.touches[0].clientX }
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return
    const dx = e.changedTouches[0].clientX - touchStartX.current
    if (dx > 50) setIndex(i => Math.max(0, i - 1))
    if (dx < -50) setIndex(i => Math.min(athletes.length - 1, i + 1))
    touchStartX.current = null
  }

  const save = useCallback(async (field: string, value: string | null) => {
    if (!athlete || !user?.email) return
    await saveBioField(athlete.name, field, value, user.email)
    setBio(prev => prev ? { ...prev, [field]: value } : { athlete_name: athlete.name, nickname: null, likes: null, dislikes: null, fun_facts: null, cheer: null, photo_url: null, updated_at: null, [field]: value })
  }, [athlete, user])

  if (athletes.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-400">No athletes found.</p>
      </div>
    )
  }

  const photoUrl = bio?.photo_url ?? null
  const allowedCoaches = (import.meta.env.VITE_AUTHORIZED_COACHES ?? '').split(',').map((e: string) => e.trim().toLowerCase()).filter(Boolean)
  const isCoach = allowedCoaches.length === 0 || allowedCoaches.includes(user?.email?.toLowerCase() ?? '')
  const userName = user?.user_metadata?.full_name ?? user?.user_metadata?.name ?? ''
  const isSelf = !!user && !!athlete && athlete.name === userName
  const loggedInEntry = roster.find(r => r.name === userName)
  const canEditAll = !!user && (isCoach || !!loggedInEntry?.bioEdit)
  const canEdit = isSelf || canEditAll

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <header className="bg-navy-900 text-white px-4 py-3 flex items-center justify-between shrink-0">
        <button onClick={onBack} className="p-1.5 hover:bg-navy-800 rounded transition-colors">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="font-semibold text-sm">Athlete Bios</span>
        <span className="text-xs text-navy-300">{index + 1} / {athletes.length}</span>
      </header>

      {/* Card */}
      <div
        className="flex-1 flex items-start justify-center p-4"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div className="w-full max-w-lg bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
          {/* Photo */}
          <div className="flex justify-center mb-4">
            {canEdit ? (
              <PhotoUploader
                athleteName={athlete.name}
                photoUrl={photoUrl}
                changedBy={user.email!}
                onUploaded={url => setBio(prev => prev ? { ...prev, photo_url: url } : { athlete_name: athlete.name, nickname: null, likes: null, dislikes: null, fun_facts: null, cheer: null, photo_url: url, updated_at: null })}
              />
            ) : (
              <div className="w-40 h-40 sm:w-48 sm:h-48 rounded-full overflow-hidden bg-gray-200 flex items-center justify-center">
                {photoUrl
                  ? <img src={photoUrl} alt={athlete.name} className="w-full h-full object-cover" />
                  : <span className="text-5xl text-gray-400 select-none">{athlete.name[0]}</span>
                }
              </div>
            )}
          </div>

          {/* Name + nickname */}
          <div className="text-center mb-4">
            {loading ? (
              <h1 className="text-2xl font-bold text-gray-900">{athlete.name}</h1>
            ) : (
              <NameWithNickname
                fullName={athlete.name}
                nickname={bio?.nickname ?? null}
                canEdit={canEdit}
                onSave={v => save('nickname', v)}
              />
            )}
          </div>

          {/* Bio fields */}
          {loading ? null : (
            <div className="space-y-4">
              {canEdit ? (
                <>
                  <EditableField label="How to cheer for me" value={bio?.cheer ?? null} onSave={v => save('cheer', v)} multiline placeholder="How should the crowd cheer?" />
                  <EditableField label="Likes" value={bio?.likes ?? null} onSave={v => save('likes', v)} multiline placeholder="What does this athlete like?" />
                  <EditableField label="Dislikes" value={bio?.dislikes ?? null} onSave={v => save('dislikes', v)} multiline placeholder="What do they dislike?" />
                  <EditableField label="Fun Facts" value={bio?.fun_facts ?? null} onSave={v => save('fun_facts', v)} multiline placeholder="Any fun facts?" />
                </>
              ) : (
                <>
                  {bio?.cheer && (
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-0.5">How to cheer for me</div>
                      <p className="text-gray-800 whitespace-pre-wrap">{bio.cheer}</p>
                    </div>
                  )}
                  {bio?.likes && (
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-0.5">Likes</div>
                      <p className="text-gray-800 whitespace-pre-wrap">{bio.likes}</p>
                    </div>
                  )}
                  {bio?.dislikes && (
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-0.5">Dislikes</div>
                      <p className="text-gray-800 whitespace-pre-wrap">{bio.dislikes}</p>
                    </div>
                  )}
                  {bio?.fun_facts && (
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-0.5">Fun Facts</div>
                      <p className="text-gray-800 whitespace-pre-wrap">{bio.fun_facts}</p>
                    </div>
                  )}
                  {!bio?.likes && !bio?.dislikes && !bio?.fun_facts && !bio?.cheer && (
                    <p className="text-gray-400 italic text-sm text-center py-4">No bio yet.</p>
                  )}
                </>
              )}

              <SeasonHistory athleteName={athlete.name} athleticNetId={athlete.athleticNetId} />
            </div>
          )}
        </div>
      </div>

      {/* Navigation arrows */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 bg-white border-t border-gray-100">
        <button
          onClick={() => setIndex(i => Math.max(0, i - 1))}
          disabled={index === 0}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-30 disabled:pointer-events-none transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          {index > 0 ? athletes[index - 1].name : ''}
        </button>

        <button
          onClick={() => setIndex(i => Math.min(athletes.length - 1, i + 1))}
          disabled={index === athletes.length - 1}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-30 disabled:pointer-events-none transition-colors"
        >
          {index < athletes.length - 1 ? athletes[index + 1].name : ''}
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Collapsible roster list */}
      <RosterList athletes={athletes} currentIndex={index} onSelect={setIndex} />

      {canEdit && (
        <div className="text-center text-xs text-gray-400 pb-2">
          Editing as {user.email} · Click any field to edit
        </div>
      )}
    </div>
  )
}
