# wtc-labour-rates

Labour hire pay rate + client charge rate calculator for **Work + Travel Co.** Staff pick an award, classification and roster; the tool works out the award pay rate (including casual loading and penalty/overtime rates) and builds a charge rate on top (on-costs floored at 22.7%, plus a variable margin, default 15%). Saves quotes and produces a printable summary.

## Stack

Cloudflare Worker + D1, plain JS, no build step, no framework — matches the house style of `nomads-compendium` / `MeetMe.loop`. Static app served via the Workers `assets` binding.

## Structure

- `worker/index.js` — entry point, routes `/api/staff/*` to the handlers below, else serves static assets.
- `worker/auth.js` — staff password hashing + session cookie.
- `worker/routes/staff.js` — login/logout/password/staff account management.
- `worker/routes/awards.js` — award/classification/rate-category lookups.
- `worker/routes/quotes.js` — quote calculation, save, history.
- `worker/rates.js` — the casual/permanent rate-category split (single source of truth, used by both the lookup route and the quote calculator so a loading can never be applied twice).
- `worker/calc.js` — pure rate build-up math (blend roster hours × category rates → on-costs → margin).
- `migrations/` — D1 schema. `seed/` — generated award data (see below), not hand-written.
- `scripts/fetch_map_api.py`, `scripts/build_seed_api.py`, `scripts/compare_seeds.py` — pull the Fair Work Modern Awards API, build/compare the seed SQL (see `SETUP.md`, "Refreshing the award data").
- `scripts/build_seed.py` — the earlier route: converts manually downloaded MAP spreadsheet exports into `seed/*.sql`.
- `scripts/casual_loading_data.py` — per-award casual loading % + source clause, for awards with no official casual pay table in the export.
- `public/` — login page, main app (award picker, roster, calculator, quote history, admin accounts), printable quote page.

## Data source

Fair Work Modern Awards Pay Database via the Commission's API, pulled 2026-11-08 (156 awards). See `SETUP.md` for the known gaps in this data (non-standard casual loadings, awards with no penalty-rate rows at all) before relying on this for real quotes.

## Local dev

```bash
npx wrangler d1 execute wtc-labour-rates --local --file=migrations/0001_init.sql
npx wrangler d1 execute wtc-labour-rates --local --file=migrations/0002_casual_loading.sql
npx wrangler d1 execute wtc-labour-rates --local --file=migrations/0003_casual_rate_source.sql
# then each file in seed/, in order, the same way
node scripts/create-admin.mjs "you@example.com" "Your Name" admin   # then run the printed command with --local
npx wrangler dev --local
```

First-time production setup (creating the real D1 database, secrets, deploy): see `SETUP.md`.
