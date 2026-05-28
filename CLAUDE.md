# CLAUDE.md — xctf-team-manager

## What This Is

A cross country / track & field team management web app. Coaches enter daily
workouts; athletes look up their personalized workout card. Generic per-team
configuration via env vars (school name, logo, brand colors, timezone).

Deployed on Vercel — `main` branch auto-deploys to production.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + TypeScript + Vite + Tailwind CSS v4 |
| Backend | Vercel serverless functions (`api/` directory) |
| Database | Supabase (PostgreSQL) — accessed via REST API with service role key |
| Auth | Supabase Google OAuth (for coaches) |
| Data source | Google Sheets (workouts + roster) via CSV export |
| Strava | Per-athlete OAuth tokens stored in Supabase; team sync via nightly cron |

---

## Key Data Sources

All data lives in Supabase (see `migrations/` for the schema). Core tables:

- **`settings`** — singleton row (id=1) with timezone, pre/post-run routines, video of the day, Strava team-OAuth tokens
- **`roster`** — athletes (name, group, target, vdot, plan_template_id, email, offseason/manual_mileage/inactive flags)
- **`workout_rows`** — today's workouts (one row per group)
- **`workout_history`** — per-athlete daily snapshots (immutable record of what they ran)
- **`offseason_plan_templates`** — weekly plan library (Mon..Sun cells with miles + structured segments)
- **`strava_activities`** — all run data, Strava-synced AND manually entered
  - `strava_id` is `text` to support synthetic manual IDs (`manual_{name}_{date}`)
  - Manual rows have `athlete_strava_id = 'manual'`
- **`athlete_strava_tokens`** — per-athlete OAuth tokens for Strava sync
- **`athlete_bios`** + **`athlete_bio_audit`** — bio page fields with full change history

A legacy Google Sheets read path still exists in `src/lib/sheets.ts` for teams
migrating from the original sheet-based version, but new deploys leave the
`VITE_SHEET_*` env vars blank.

---

## Repo Structure

```
api/
  mileage.ts              # GET daily/weekly mileage + POST manual entry
  team-mileage.ts         # (legacy or aggregate)
  athlete-ping.ts         # Records last-login timestamp
  athletic-net.ts         # Scrapes Athletic.net PR data
  strava/
    athlete-auth.ts       # Initiates per-athlete Strava OAuth
    athlete-callback.ts   # Handles Strava OAuth callback
    athlete-mileage.ts    # Per-athlete mileage
    team-sync.ts          # Syncs all athletes' Strava activities (cron + manual)

src/
  App.tsx                 # Root: view routing (athlete / coach-read / coach-dashboard / print)
  config.ts               # Sheet IDs, school branding (VITE_ env vars)
  lib/
    types.ts              # WorkoutRow, WorkoutSegment, RosterEntry, etc.
    vdot.ts               # Jack Daniels VDOT formula → training paces
    sheets.ts             # Helpers: findWorkoutForAthlete, findRosterEntry, etc.
    supabase.ts           # Supabase client
    db.ts                 # DB query helpers
  hooks/
    useSupabaseData.ts    # Fetches workout + roster data (5-min TTL cache)
    useAuth.ts            # Supabase Google OAuth
    useLocalStorage.ts    # Persists selected athlete
    useSheetData.ts       # (alternate sheet fetcher)
    useAthleticNetPRs.ts  # Fetches PR data from Athletic.net API
  components/
    WorkoutCard.tsx       # Athlete-facing workout display with personalized paces
    AthletePicker.tsx     # Name grid on home screen
    CoachDashboard.tsx    # Coach editing UI (workouts, roster, mileage, weekly miles)
    CoachView.tsx         # Read-only coach view (all groups at once)
    PrintView.tsx         # Print layout (3 pages)
    AuthGate.tsx          # Wraps CoachDashboard with auth check
    AthleticNetPRs.tsx    # Displays PR table
    RoutineBar.tsx        # Pre/post run routine display
    VideoEmbed.tsx        # Embedded workout video
    MileageInfo.tsx       # Mileage summary widget
    HelpPage.tsx          # /help route

scripts/
  import-mileage.mjs     # One-time import: Google Sheets mileage log → strava_activities
```

---

## Views / Navigation

- **Athlete view** (`/`): pick athlete → see workout card with personalized paces
- **Coach read** (`?view=coach-read`): all groups, read-only
- **Coach dashboard** (`?view=coach-dashboard`): requires Google auth; tabs:
  - **Workouts**: edit today's workout per group
  - **Roster**: manage athletes, groups, targets
  - **Mileage**: 30 past days + today + 7 future; sticky Name/Target/Total/L7/CW columns
  - **Miles by Week**: 16-week trend view for load monitoring
- **Print view**: 3-page printout (portrait page 1 sorted by Focus)

---

## Workout Paces (Jack Daniels VDOT)

`src/lib/vdot.ts` computes training paces from the athlete's best PR.
- **Tempo**: duration-adjusted; displayed as a range (`fast–fast+10s /mi`)
- **Easy**: range (`easyFast–easySlow /mi`)
- **800 / 1600 / 5K**: proportional PR time for the segment distance
- **Threshold**: single pace

---

## Mileage Tracking

- `GET /api/mileage` — daily miles per athlete, last 30 days + all-time totals
- `GET /api/mileage?weekly=1` — weekly totals, last 16 weeks + all-time totals
- `POST /api/mileage` — upsert/delete a manual entry (coach dashboard)
- Source tracking: orange = Strava, blue = manual, purple = mixed

### Strava Team Sync
- `POST /api/strava/team-sync` — syncs last 35 days for all athletes with stored tokens
- Triggered: manual button in coach dashboard header + nightly cron at 07:00 UTC (`vercel.json`)
- Athletes without Strava tokens require manual mileage entry

### Historical Import
- `scripts/import-mileage.mjs` — one-time import from Google Sheets mileage log
- Season: Aug 2025 – May 2026 (month ≥ 8 → 2025, month < 8 → 2026)
- Run with: `node scripts/import-mileage.mjs`

---

## Environment Variables

See `.env.example` for the canonical, commented list. Brief summary:

### Server-side (`api/`)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — required
- `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` — only if Strava integration is used
- `CRON_SECRET` — protects the nightly cron endpoint
- `ALLOWED_EMAIL_DOMAIN` — gates athlete email auto-bind; blank disables it

### Client-side (`VITE_` prefix)
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — required
- `VITE_TEAM_NAME`, `VITE_SHORT_NAME`, `VITE_SCHOOL_NAME` — branding
- `VITE_SCHOOL_LOGO` — optional URL override (falls back to `/team-logo.png`)
- `VITE_BRAND_PRIMARY`, `VITE_BRAND_ACCENT` — header / accent colors
- `VITE_AUTHORIZED_COACHES` — comma-separated email allowlist for the dashboard
- `VITE_SHEET_ID`, `VITE_WORKOUT_GID`, `VITE_ROSTER_GID` — legacy Sheets path, blank for new deploys

Local dev: `.env.local` (gitignored)

---

## Development

```bash
npm run dev      # Vite dev server (frontend only)
npm run build    # TypeScript + Vite build
```

API functions require Vercel CLI (`vercel dev`) to run locally with env vars.

Deploy: push to `main` → Vercel auto-deploys to production.

---

## Important Decisions / Gotchas

- `strava_id` column is `text` (not bigint) — changed to support manual entry IDs
- Week boundaries are Monday-based throughout
- Strava Club API does not return activity dates — per-athlete token refresh is used instead
- Unassigned group chips are alphabetized; group chips sorted fastest → slowest by VDOT
- Tempo pace shows a range (calculated pace to +10s slower), not a single number
- All imports must be at the top of TSX files (HMR breaks with mid-file imports)
- **Always typecheck with `npx tsc -b`** before pushing — `tsc --noEmit` misses unused-import errors that the Vercel build's `tsc -b` catches, breaking deploys silently
- **All calendar-day date math uses the team's configured timezone** (Settings tab → `settings.timezone`), not `toISOString().slice(0, 10)` — UTC slicing makes evening-PT entries land on the wrong day. Use `Intl.DateTimeFormat` with `timeZone: <value from settings>`. Applies to the scraper, `ManualMileagePanel`, `OffseasonCard`
- **Pre-run and post-run routine bars are intentionally hidden** in `WorkoutCard.tsx` via `{false && ...}` — flip to `true` to bring back, don't remove the code
- **Manual mileage panel locks Strava-synced days** — athlete can't overwrite a Strava day from their card; coaches resolve conflicts in the dashboard
- **Plans tab uses inline segments per cell** (not a shared workout library) — explicit choice for simplicity. If `4×5 tempo` repetition becomes painful to maintain, that's the model to revisit
- **Strava feed scraper pacing**: 5–10s between pages, max ~20 pages before throttle. Cookie expires periodically; refresh `STRAVA_SESSION_COOKIE` in `.env.local` when the scraper errors with "session cookie likely expired"
