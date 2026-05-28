import { useEffect, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'

// Service-worker update prompt.
//
// vite-plugin-pwa is configured with registerType: 'autoUpdate' which downloads
// the new bundle in the background as soon as it's available. By default the
// new bundle activates only on the NEXT full app launch — on an installed iOS
// PWA that can be hours or days. This subscribes to the update event so we can
// (a) silently swap on focus return, and (b) show a small "Reload" toast as a
// fallback in case focus events don't fire.
export function UpdatePrompt() {
  const [needsUpdate, setNeedsUpdate] = useState(false)
  const [reload, setReload] = useState<(() => Promise<void>) | null>(null)

  useEffect(() => {
    // registerSW returns the function that activates the waiting SW + reloads.
    const updateSW = registerSW({
      onNeedRefresh() { setNeedsUpdate(true) },
      // onOfflineReady / onRegisteredSW left as no-ops; we don't surface those.
    })
    setReload(() => () => updateSW(true))
  }, [])

  // Auto-reload when the tab regains focus and an update is pending. This is
  // the "invisible" path — most athletes never see the toast because they
  // background the app between sessions and the swap happens silently.
  useEffect(() => {
    if (!needsUpdate || !reload) return
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [needsUpdate, reload])

  if (!needsUpdate || !reload) return null

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-navy-900 text-white rounded-full shadow-lg px-4 py-2 flex items-center gap-3 text-sm">
      <span>New version available</span>
      <button
        onClick={() => reload()}
        className="bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white text-xs font-semibold rounded-full px-3 py-1 transition-colors"
      >
        Reload
      </button>
      <button
        onClick={() => setNeedsUpdate(false)}
        title="Dismiss"
        className="text-navy-300 hover:text-white text-xs px-1"
      >
        ✕
      </button>
    </div>
  )
}
