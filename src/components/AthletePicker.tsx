import { useState, useMemo } from 'react'
import type { RosterEntry } from '../lib/types.ts'

export function AthletePicker({
  roster,
  onSelect,
}: {
  roster: RosterEntry[]
  onSelect: (name: string) => void
}) {
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    const active = roster.filter(r => !r.inactive)
    if (!q) return active
    return active.filter(r => r.name.toLowerCase().includes(q))
  }, [roster, search])

  // Group by roster group
  const grouped = useMemo(() => {
    const groups = new Map<string, RosterEntry[]>()
    for (const entry of filtered) {
      const key = entry.group || 'Other'
      const list = groups.get(key) ?? []
      list.push(entry)
      groups.set(key, list)
    }
    return groups
  }, [filtered])

  return (
    <div className="flex flex-col min-h-[80vh]">
      <div className="px-4 pt-6 pb-3">
        <h2 className="text-xl font-bold text-navy-900 mb-1">Select Your Name</h2>
        <p className="text-sm text-navy-500 mb-4">
          Pick your name to see today&apos;s workout
        </p>
        <input
          type="search"
          placeholder="Search athletes..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full px-4 py-3 rounded-xl border border-navy-200 bg-white text-base
                     placeholder:text-navy-300 focus:outline-none focus:ring-2 focus:ring-navy-400"
          autoFocus
        />
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        {filtered.length === 0 ? (
          <p className="text-center text-navy-400 mt-8 text-sm">No athletes found</p>
        ) : (
          Array.from(grouped.entries()).map(([group, entries]) => (
            <div key={group} className="mb-4">
              <h3 className="text-xs font-semibold text-navy-400 uppercase tracking-wider mb-2 px-1">
                {group}
              </h3>
              <div className="space-y-1">
                {entries.map(entry => (
                  <button
                    key={entry.name}
                    onClick={() => onSelect(entry.name)}
                    className="w-full text-left px-4 py-3 rounded-xl bg-white
                               hover:bg-navy-50 active:bg-navy-100
                               transition-colors text-navy-900 text-base"
                  >
                    {entry.name}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
