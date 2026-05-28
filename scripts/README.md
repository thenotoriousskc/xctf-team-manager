# scripts/

Local-only helper scripts. None of these run on Vercel — they're for one-off data imports and ongoing data refreshes you run from your laptop. All read `.env.local` (the same file `vercel env pull` writes) for credentials.

## Two main scripts

| Script | What it does | How often you run it |
|---|---|---|
| **`scrape_tf_results.py`** | Pulls every athlete's race results from athletic.net into `public/prs.json` so the app can compute VDOTs and personalized paces | After each meet, or when a new athlete joins |
| **`scrape-strava-feed.mjs`** | Walks your Strava home feed and upserts roster athletes' runs into `strava_activities` so they show up on the Mileage tab | Whenever you want a fresh sync (no automation) |

The rest are one-off setup helpers — see "Other scripts" at the bottom.

---

## `scrape_tf_results.py` — Athletic.net race scraper

Track & Field results live on athletic.net behind Cloudflare. The scraper drives a real Chrome window via [undetected-chromedriver](https://github.com/ultrafunkamsterdam/undetected-chromedriver) so it can get past the bot check, then extracts each athlete's per-event history with dates, meet names, and PB flags.

Output lands in `public/prs.json`, which the app reads at runtime for VDOT calculations (the Roster tab "VDOT" column, the Bio page progression charts, and the personalized paces on each athlete's workout card).

### Prerequisites

- Python 3.10+ and `pip`
- A modern Google Chrome installed (the driver matches your Chrome version)

```bash
pip install -r scripts/requirements.txt
```

If Chrome and the driver's `version_main` (currently `147` in `scrape_tf_results.py:36`) disagree, the driver throws on startup. Open Chrome → menu → Help → About Google Chrome to see your version, then bump the constant.

### Finding your team_id

On athletic.net, navigate to your school's track team page. The URL is like:

```
https://www.athletic.net/TrackAndField/School.aspx?SchoolID=1031&S=2026
```

`SchoolID` is your `--team_id`. `S` is the season year (2026 = spring 2026 outdoor).

### Usage

Full team scrape (the common case):

```bash
python scripts/scrape_tf_results.py \
  --team_id 1031 \
  --year 2026 \
  --out public/prs.json
```

This opens a real Chrome window, walks the team roster page to find every athlete ID, then visits each athlete's profile in turn. Expect **15–25 minutes** for a 40-athlete team — the script waits 5–30 seconds between athletes so Cloudflare doesn't get suspicious. Leave the window open and don't touch it.

Single athlete (for testing or onboarding one new runner):

```bash
python scripts/scrape_tf_results.py \
  --team_id 1031 \
  --year 2026 \
  --athlete_id 21058688 \
  --out /tmp/one.json
```

Headless (skip the browser window — but Cloudflare blocks this more often):

```bash
python scripts/scrape_tf_results.py --team_id 1031 --year 2026 --headless ...
```

### Output shape

`public/prs.json` is a dict keyed by athletic.net athlete ID:

```json
{
  "26371811": {
    "name": "Jane Doe",
    "prs": [
      { "event": "1600 Meters", "mark": "4:32.15", "date": "Apr 12, 2026", "meet": "BCL Championship" }
    ],
    "history": [
      { "event": "1600 Meters", "mark": "4:32.15", "date": "Apr 12, 2026", "meet": "...", "is_pb": true },
      { "event": "1600 Meters", "mark": "4:38.20", "date": "Mar 25, 2026", "meet": "...", "is_pb": false }
    ],
    "seasons": ["2026 Outdoor", "2025 Outdoor"]
  }
}
```

`prs` is best-per-event, `history` is every race, `seasons` is the list of season labels athletic.net shows for that athlete.

### After scraping

```bash
git add public/prs.json
git commit -m "Refresh PRs from athletic.net (May 2026 results)"
git push
```

The file ships with the app bundle — there's no DB upload — so a Vercel rebuild is what makes the new data visible.

### Field events

The script handles times (e.g. `4:32.15`, `58.39`) and feet-inches field marks (e.g. `17' 7"`, `13' 4.25"`). Pure integers are filtered out (place numbers, wind, etc.). If a new event format appears that confuses the parser, edit the `mark_pattern` regex in `get_athlete_prs`.

---

## `scrape-strava-feed.mjs` — Strava home-feed scraper

Strava's public API doesn't expose other athletes' activities — only the authenticated user's. But your **home feed** does include everyone you follow. This script walks your home feed, identifies which activities are by roster athletes (matching on name), and upserts them into `strava_activities`.

That covers the common case: the coach follows every athlete on Strava, athletes don't need to do per-athlete OAuth, runs show up on the Mileage tab automatically.

### One-time setup

The script authenticates by replaying your Strava session cookie. To grab it:

1. Log in to [strava.com](https://www.strava.com) in a browser.
2. Open DevTools → **Application** → **Cookies** → `https://www.strava.com`.
3. Find the row where Name = `_strava4_session` and copy the Value (long opaque string).
4. Visit your own profile — the URL has your numeric athlete ID: `/athletes/<ID>`.
5. Add both to `.env.local`:

   ```bash
   STRAVA_SESSION_COOKIE=<the _strava4_session value>
   STRAVA_MY_ATHLETE_ID=<your numeric athlete id>
   ```

The cookie expires periodically (weeks to a month). When the script errors with *"session cookie likely expired"*, repeat steps 2–3 to get a fresh value.

### Usage

```bash
node scripts/scrape-strava-feed.mjs            # scrape last 30 days (default)
node scripts/scrape-strava-feed.mjs 14         # last 14 days
node scripts/scrape-strava-feed.mjs --inspect  # dump first page of feed JSON to strava-feed-page1.json and exit
node scripts/scrape-strava-feed.mjs --reset    # ignore saved cursor; start from page 1
```

The script paginates the feed in ~5–10s intervals and stops on Strava's `597` throttle response. Expect **3–6 pages** before throttling on most accounts. If you need more depth, run it again later — see "Resuming."

### Output

Each run prints something like:

```
Roster: 45 athletes
  Page 1: 30 entries, 32 activities, +24 new (total 24), oldest=2026-05-22
  Page 2: 30 entries, 33 activities, +9  new (total 33), oldest=2026-05-19
  Page 3: 30 entries, 30 activities, +5  new (total 38), oldest=2026-05-16
  Strava reports no more pages — done.

Collected 38 records. Skips: {"not-on-roster":54,"not-run":31}
Upserted 38/38.
```

Skips:
- `not-on-roster` — activity by someone not in the `roster` table (teammate's parent, your dog, etc.)
- `not-run` — non-running activity types (ride, swim, hike, weight training)

### Resuming

The scraper writes `.strava-feed-state.json` after every page (and on throttle). If Strava cuts you off at page 4, re-running within 24h picks up at the saved cursor instead of re-burning page 1. To start fresh: `--reset`.

State file is gitignored — don't commit it.

### Conflicts with manual entries

The Mileage tab shows manual entries and Strava entries side-by-side. If a coach hand-entered miles for an athlete and that same day later syncs from Strava, the cell turns **amber** to flag the conflict; click it for a Keep Manual / Keep Strava resolution dialog. The athlete-facing manual mileage panel locks Strava days to prevent creating new conflicts from that side.

### What the scraper captures

For each run (Strava `sport_type` ∈ Run / TrailRun / VirtualRun / Treadmill):

- Distance, moving time (computed from feed pace string when not present directly), average speed, start date+time in athlete's local timezone, Strava activity ID

GPS data, heart rate, splits, etc. are not captured — the feed JSON doesn't include them.

---

## Other scripts

These are setup/maintenance helpers, typically run once.

- **`bootstrap.mjs`** — prints the order in which to apply files from `migrations/` to your Supabase project. Supabase blocks arbitrary SQL via REST for security, so the script just gives instructions; you still paste each migration in the SQL Editor manually (or use `supabase db push` if you've linked the CLI).
- **`seed-offseason-plans.mjs <path-to.ods> [--apply]`** — bulk-import weekly plan templates from a LibreOffice/Excel sheet into `offseason_plan_templates`. Idempotent on label, so re-runs update in place.
- **`backfill-vdot.mjs [--apply]`** — compute VDOT from each athlete's PRs (`public/prs.json`) and write to `roster.vdot` for any row where it's null. Useful one-time after a fresh `scrape_tf_results.py` run.
- **`fix-mileage-dates.mjs [--apply]`** — one-off cleanup for the old UTC-vs-Pacific timezone bug. Shouldn't be needed on fresh installs.
- **`resolve-conflicts-strava-wins.mjs [--apply]`** — for every (athlete, date) where both manual and Strava entries exist, delete the manual entry. Use sparingly; the dashboard's per-cell conflict dialog is usually better.
- **`import-mileage.mjs`** — one-off import from the original Google Sheets mileage log (Bay-specific; new deploys won't need this).

All `--apply` scripts run as dry-runs by default so you can preview what they'd do.
