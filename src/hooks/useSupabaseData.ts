import { useState, useEffect, useCallback, useRef } from 'react'
import type { SheetData } from '../lib/types.ts'
import { fetchSheetData } from '../lib/db.ts'

const CACHE_KEY = 'xctf-supabase-cache'
const CACHE_TTL = 5 * 60 * 1000 // 5 min

interface CacheEntry {
  data: SheetData
  timestamp: number
}

function loadCache(): SheetData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const entry: CacheEntry = JSON.parse(raw)
    if (Date.now() - entry.timestamp > CACHE_TTL) return null
    return entry.data
  } catch {
    return null
  }
}

function saveCache(data: SheetData) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }))
  } catch {}
}

export function useSupabaseData() {
  const [data, setData] = useState<SheetData | null>(() => loadCache())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  // Generation counter: a fetch only applies its result if it's still the latest fetch
  const fetchGenRef = useRef(0)

  const load = useCallback(async (force = false) => {
    if (!force) {
      const cached = loadCache()
      if (cached) {
        setData(cached)
        setLoading(false)
        // Revalidate in background — but only apply if no newer fetch has been initiated
        const myGen = ++fetchGenRef.current
        fetchSheetData().then(fresh => {
          if (!mountedRef.current || fetchGenRef.current !== myGen) return
          setData(fresh)
          saveCache(fresh)
        }).catch(() => {})
        return
      }
    }
    const myGen = ++fetchGenRef.current
    setLoading(true)
    try {
      const fresh = await fetchSheetData()
      if (!mountedRef.current || fetchGenRef.current !== myGen) return
      setData(fresh)
      saveCache(fresh)
      setError(null)
    } catch (err) {
      if (!mountedRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load data')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    load()
    return () => { mountedRef.current = false }
  }, [load])

  const refresh = useCallback(() => load(true), [load])

  // Expose a way for the dashboard to invalidate cache after saving
  const invalidate = useCallback(() => {
    localStorage.removeItem(CACHE_KEY)
    load(true)
  }, [load])

  return { data, loading, error, refresh, invalidate }
}
