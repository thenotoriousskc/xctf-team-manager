# Demo seed scripts

The `demo` branch ships with sample data so a freshly-deployed instance immediately shows what the app looks like with a real-ish team.

This branch is identical to `main` except for:
- This `seeds/` folder with two scripts
- `public/prs.json` pre-populated with synthetic PRs matching the seed roster

## Files

- **`seed-demo.mjs`** — populates Supabase with 20 athletes, 4 weekly plan templates, today's workout, and 14 days of mileage entries
- **`generate-demo-prs.mjs`** — writes synthetic Athletic.net-style PRs to `public/prs.json` for VDOT pace calculations (already committed; only re-run if you change the roster)

## Setting up a demo deployment

1. **Create a separate Supabase project** named e.g. `xctf-demo`. Don't reuse a production project — the seed wipes data.

2. **Apply migrations** in the new project's SQL editor in order: `001_initial_schema.sql` → `005_rls_policies.sql`.

3. **Point a local `.env.local` at the demo Supabase**:
   ```
   SUPABASE_URL=https://<demo-project>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
   ```

4. **Seed the data**:
   ```bash
   node seeds/seed-demo.mjs --apply          # populate
   node seeds/seed-demo.mjs --apply --wipe   # or wipe-then-populate
   ```

5. **Deploy the `demo` branch on Vercel**:
   - Either a separate Vercel project entirely (cleanest URL), or
   - Configure the existing project to also deploy the `demo` branch to a preview URL
   - Add env vars in the Vercel project pointing at the demo Supabase
   - Set `VITE_AUTHORIZED_COACHES` to your own email so you can poke around the coach dashboard

## The data

The seed includes:
- **20 athletes** with realistic American names, mixed across Distance / Mid / Sprint / Field groups
- **VDOTs ranging 39.7 → 58.7** so paces are plausible across the team
- **Flags exercised**: a few `offseason`, one `manual_mileage`, one `inactive`, plus one with both flags
- **4 plan templates**: Recovery week (12mi), Base 18, Base 28A (with tempo segments), Pre-season 36
- **One workout group** for today: "5×800m at 5k pace · 90s jog recovery"
- **~240 mileage entries**: 14 days × ~17 active athletes, with ~1 rest day per week and ±50% noise on the daily target

## Refreshing the demo

Most days you won't need to. If you want today's workout to be fresh:
```bash
node seeds/seed-demo.mjs --apply --wipe
```
That re-seeds everything, including dates, so the mileage trend is always "the last 14 days."

A cron job hitting this nightly could keep the demo perpetually current, but that's out of scope here.
