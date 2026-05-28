// Legacy Google Sheets data source (optional — set VITE_SHEET_ID to use).
// Blank by default; new deploys read everything from Supabase.
export const SHEET_ID = import.meta.env.VITE_SHEET_ID ?? ''
export const WORKOUT_GID = import.meta.env.VITE_WORKOUT_GID ?? '0'
export const ROSTER_GID = import.meta.env.VITE_ROSTER_GID ?? '197184629'
export const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// School branding (override via VITE_* env vars in .env.local / Vercel).
export const SCHOOL_NAME = import.meta.env.VITE_SCHOOL_NAME ?? 'Your School'
export const TEAM_NAME = import.meta.env.VITE_TEAM_NAME ?? 'Team XC/TF'
export const SCHOOL_LOGO = import.meta.env.VITE_SCHOOL_LOGO ?? ''

// Colors (CSS custom properties set in index.css, can be overridden per-school)
export const BRAND_PRIMARY = import.meta.env.VITE_BRAND_PRIMARY ?? '#002776'
export const BRAND_ACCENT = import.meta.env.VITE_BRAND_ACCENT ?? '#2cccd3'

export function sheetCsvUrl(gid: string): string {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`
}
