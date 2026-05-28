import { useState } from 'react'

export function RoutineBar({
  label,
  content,
}: {
  label: string
  content: string
}) {
  const [open, setOpen] = useState(true)

  if (!content) return null

  return (
    <div className="bg-white rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 active:bg-navy-50"
      >
        <span className="text-sm font-semibold text-navy-700">{label}</span>
        <svg
          className={`w-4 h-4 text-navy-400 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="px-4 pb-3 text-sm text-navy-600 whitespace-pre-wrap border-t border-navy-100">
          <div className="pt-3">{content}</div>
        </div>
      )}
    </div>
  )
}
