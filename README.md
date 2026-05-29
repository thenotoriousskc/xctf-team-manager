# xctf-team-manager

A cross-country / track & field team management web app. Coaches manage daily workouts, weekly mileage, offseason training plans, and athlete bios. Athletes look up their personalized workout card with VDOT-based pace targets, see their assigned weekly plan, and (optionally) self-log miles.

Built for [The Bay School Breakers](https://www.instagram.com/bayxctf/), now generalized so any team can deploy their own copy.

> **Want to see it in action?** Check out the [`demo` branch](https://github.com/thenotoriousskc/xctf-team-manager/tree/demo) — it ships with realistic-but-fake roster, workouts, and mileage data. See [`seeds/README.md`](https://github.com/thenotoriousskc/xctf-team-manager/blob/demo/seeds/README.md) on the demo branch for deploy steps.

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
3. **Authentication → Providers → Google**: enable it and paste your Google OAuth client ID/secret. To get them:
   - [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → **Create credentials → OAuth client ID → Web application** (configure the OAuth consent screen first if prompted — set it to *External* and add yourself under *Test users*).
   - The **Client ID** ends in `.apps.googleusercontent.com`; the secret looks like `GOCSPX-…`. These are issued by Google — you can't make them up, and Supabase rejects blank/placeholder values (which is what surfaces as `provider is not enabled` at login).
   - In the same Google client, add Supabase's callback to **Authorized redirect URIs**: `https://<your-project-ref>.supabase.co/auth/v1/callback` (the ref is in your Supabase project URL).
4. **Authentication → URL Configuration**: the app signs in with `redirectTo: window.location.origin`, and Supabase only honors an origin that's in the allowlist — otherwise it bounces to the Site URL (default `http://localhost:3000`), which shows up as `localhost refused to connect`. Set:
   - **Site URL** → your deployed URL (e.g. `https://your-team.vercel.app`). Use `http://localhost:5173` only while local dev is your main login target, then switch it back before sharing.
   - **Redirect URLs** → add every origin you log in from, e.g. `https://your-team.vercel.app/**` and `http://localhost:5173/**`.
5. **SQL Editor**: paste each file from `migrations/` in order:
   - `001_initial_schema.sql`
   - `002_strava.sql`
   - `003_athlete_bios.sql`
   - `004_offseason_plans.sql`
   - `005_rls_policies.sql`
6. Settings → API: copy the `URL`, `anon` key, and `service_role` key

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
