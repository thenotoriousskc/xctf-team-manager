# xctf-team-manager

A cross-country / track & field team management web app. Coaches manage daily workouts, weekly mileage, offseason training plans, and athlete bios. Athletes look up their personalized workout card with VDOT-based pace targets, see their assigned weekly plan, and (optionally) self-log miles.

Built for [The Bay School Breakers](https://www.instagram.com/bayxctf/), now generalized so any team can deploy their own copy.

## Features

- **Per-athlete workout cards** with VDOT-derived training paces from Athletic.net PRs
- **Mileage tracking** — daily, weekly trend, and per-athlete history. Strava scraper in scripts or manual entry by coach or athlete.
- **Offseason planner** — a library of weekly plan templates assignable to athletes building base mileage
- **Athlete bios** — photos, nicknames, fun facts, team cheers
- **Coach dashboard** — Google sign-in, full edit of roster / workouts / mileage / plans
- **iOS Add-to-Home-Screen ready** — PWA icons, status-bar styling

## Tech stack

| Layer | What |
|---|---|
| Frontend | React 19 + TypeScript + Vite + Tailwind CSS v4 |
| Backend | Vercel serverless functions in `api/` |
| Database | Supabase (Postgres + Google OAuth) |
| Hosting | Vercel (push to `main` deploys) |

## Setup

### 1. Fork + clone

Click "Use this template" on GitHub, or:

```bash
git clone https://github.com/YOUR-USERNAME/xctf-team-manager.git
cd xctf-team-manager
npm install
```

### 2. Create a Supabase project

1. Sign up at [supabase.com](https://supabase.com) (free tier is plenty)
2. New project → pick a region near your team
3. **Authentication → Providers → Google**: enable, add your Google OAuth client ID/secret (use [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → Create OAuth client → Web application)
4. **SQL Editor**: paste each file from `migrations/` in order:
   - `001_initial_schema.sql`
   - `002_strava.sql`
   - `003_athlete_bios.sql`
   - `004_offseason_plans.sql`
   - `005_rls_policies.sql`
5. Settings → API: copy the `URL`, `anon` key, and `service_role` key

### 3. Configure env vars

```bash
cp .env.example .env.local
```

Fill in `.env.local`:
- **Required:** `SUPABASE_*`, `VITE_SUPABASE_*`, `VITE_TEAM_NAME`, `VITE_SHORT_NAME`, `VITE_AUTHORIZED_COACHES`
- **Optional:** Strava, Athletic.net domain, brand colors, logo

### 4. Replace the placeholder logo

The default `public/team-logo.png` is a "TEAM XC/TF" placeholder. Replace it with your school badge, plus the iOS/PWA icons:

```bash
# from your 512×512 source image
sips -s format png -z 180 180 your-logo.png --out public/apple-touch-icon-180x180.png
sips -s format png -z 192 192 your-logo.png --out public/pwa-192x192.png
sips -s format png -z 512 512 your-logo.png --out public/pwa-512x512.png
sips -s format png -z 64  64  your-logo.png --out public/favicon.png
cp your-logo.png public/team-logo.png
```

### 5. Deploy

Push to GitHub, then [import the repo on Vercel](https://vercel.com/new). Add the same env vars in **Settings → Environment Variables**.

### 6. Sign in as a coach

Visit your deployed URL, tap **Sign in** in the top-right, choose a Google account whose email is in `VITE_AUTHORIZED_COACHES`. The Coach Dashboard appears in the hamburger menu.

## Local development

```bash
npm run dev          # Vite only (frontend, port 5173)
vercel dev           # Full stack including api/, port 3000
npm run build        # Production build
npx tsc -b           # Strict typecheck (matches Vercel's build)
```

## Optional: data import scripts

In `scripts/`:

- `scrape_tf_results.py --team_id <athletic.net id> --year 2026 --out public/prs.json` — pull every athlete's race results from Athletic.net for VDOT calculations (needs `pip install -r requirements.txt`)
- `seed-offseason-plans.mjs <path-to.ods> --apply` — bulk-import weekly plans from a LibreOffice/Excel sheet
- `scrape-strava-feed.mjs` — pull recent Strava activities into the mileage tab (uses your personal Strava session cookie; runs locally only)

See each script's header comments for details.

## Architecture notes

- **All calendar-day date math is in the team's timezone** (Settings tab → Timezone). Never use `toISOString().slice(0, 10)` — that's UTC and shifts evening entries to the next day.
- **Manual mileage panel locks Strava-synced days** — athletes can't overwrite a Strava day from their card; coaches resolve conflicts in the dashboard.
- **Plans tab uses inline segments per cell** (not a shared workout library). Same workout repeated across templates is duplicated by design — simpler model.
- **Always typecheck with `npx tsc -b` before pushing** — the project's strict flags catch unused imports that `tsc --noEmit` misses. Two Vercel builds have failed this way.

See `CLAUDE.md` for the full project-specific guidance.

## License

MIT
