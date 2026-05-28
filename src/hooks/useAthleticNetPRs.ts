import { useState, useEffect } from 'react'
import type { AthleticNetPR } from '../lib/types.ts'

interface PRState {
  prs: AthleticNetPR[]
  athleteId: string | null
  loading: boolean
  error: string | null
}

export type PRsFile = Record<string, { name: string; prs: AthleticNetPR[] }>

let prsFileCache: PRsFile | null = null

export async function loadPRsFile(): Promise<PRsFile> {
  if (prsFileCache) return prsFileCache
  const res = await fetch('/prs.json')
  if (!res.ok) throw new Error(`prs.json not found (HTTP ${res.status})`)
  prsFileCache = await res.json()
  return prsFileCache!
}

export function normalize(name: string) {
  return name.toLowerCase().replace(/[^a-z]/g, '')
}

export function findAthleteId(file: PRsFile, athleteName: string): string | null {
  const target = normalize(athleteName)
  for (const [id, entry] of Object.entries(file)) {
    if (normalize(entry.name) === target) return id
  }
  for (const [id, entry] of Object.entries(file)) {
    const n = normalize(entry.name)
    if (n.includes(target) || target.includes(n)) return id
  }
  return null
}

function findByName(file: PRsFile, athleteName: string): { prs: AthleticNetPR[]; athleteId: string | null } {
  const athleteId = findAthleteId(file, athleteName)
  if (!athleteId) return { prs: [], athleteId: null }
  return { prs: file[athleteId].prs, athleteId }
}

export function useAthleticNetPRs(athleteName: string | undefined): PRState {
  const [state, setState] = useState<PRState>({ prs: [], athleteId: null, loading: false, error: null })

  useEffect(() => {
    if (!athleteName) {
      setState({ prs: [], athleteId: null, loading: false, error: null })
      return
    }

    setState({ prs: [], athleteId: null, loading: true, error: null })

    loadPRsFile()
      .then(file => {
        const { prs, athleteId } = findByName(file, athleteName)
        setState({ prs, athleteId, loading: false, error: null })
      })
      .catch(err => {
        setState({ prs: [], athleteId: null, loading: false, error: err.message })
      })
  }, [athleteName])

  return state
}
