import { useState, useEffect, useCallback } from 'react'
import { fetchSheetData } from '../lib/sheets.ts'
import { CACHE_TTL_MS } from '../config.ts'
import type { SheetData } from '../lib/types.ts'

const CACHE_KEY = 'xctf-sheet-data'
const CACHE_TIME_KEY = 'xctf-sheet-data-time'

interface CachedData {
  data: SheetData
  timestamp: number
}

function getCachedData(): CachedData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    const time = localStorage.getItem(CACHE_TIME_KEY)
    if (raw && time) {
      return { data: JSON.parse(raw) as SheetData, timestamp: Number(time) }
    }
  } catch {
    // ignore
  }
  return null
}

function setCachedData(data: SheetData): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data))
    localStorage.setItem(CACHE_TIME_KEY, String(Date.now()))
  } catch {
    // ignore
  }
}

export function useSheetData(): {
  data: SheetData | null
  loading: boolean
  error: string | null
  refresh: () => void
} {
  const [data, setData] = useState<SheetData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (force = false) => {
    if (force) {
      try {
        localStorage.removeItem(CACHE_KEY)
        localStorage.removeItem(CACHE_TIME_KEY)
      } catch { /* ignore */ }
      // Clear service worker cache too
      try {
        const keys = await caches.keys()
        await Promise.all(keys.filter(k => k.includes('sheet-data')).map(k => caches.delete(k)))
      } catch { /* ignore */ }
    }

    // Stale-while-revalidate: serve cache immediately, refresh in background
    const cached = getCachedData()
    if (cached) {
      setData(cached.data)
      setLoading(false)
      const age = Date.now() - cached.timestamp
      if (!force && age < CACHE_TTL_MS) return
    }

    try {
      setLoading(prev => (cached ? false : prev || true))
      const fresh = await fetchSheetData()
      // If coach is updating, keep showing cached data
      if (fresh.publishStatus === 'UPDATING' && cached) {
        setError(null)
        return
      }
      setData(fresh)
      setCachedData(fresh)
      setError(null)
    } catch (err) {
      if (!cached) {
        setError(err instanceof Error ? err.message : 'Failed to load workout data')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const refresh = useCallback(() => {
    load(true)
  }, [load])

  return { data, loading, error, refresh }
}
