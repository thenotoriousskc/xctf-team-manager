import { useState } from 'react'

function getYouTubeId(url: string): string | null {
  const patterns = [
    /youtu\.be\/([^?&]+)/,
    /youtube\.com\/watch\?v=([^&]+)/,
    /youtube\.com\/embed\/([^?&]+)/,
    /youtube\.com\/shorts\/([^?&]+)/,
  ]
  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match) return match[1]
  }
  return null
}

export function VideoEmbed({ url, label }: { url: string; label?: string }) {
  const [open, setOpen] = useState(true)

  if (!url) return null

  const title = label || 'Video of the Day'
  const youtubeId = getYouTubeId(url)

  return (
    <div className="bg-white rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 active:bg-navy-50"
      >
        <span className="text-sm font-semibold text-navy-700">{title}</span>
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
        <div className="border-t border-navy-100">
          {youtubeId ? (
            <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
              <iframe
                className="absolute inset-0 w-full h-full"
                src={`https://www.youtube.com/embed/${youtubeId}`}
                title={title}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          ) : (
            <div className="px-4 py-3">
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-navy-500 underline text-sm break-all"
              >
                {url}
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
