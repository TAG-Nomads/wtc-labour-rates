# wtc-labour-rates — setup

## What this is

Internal tool for Work + Travel Co. staff to work out the award pay rate for a role
(base + penalties/overtime, casual-loaded where applicable), then build a client
charge rate on top: on-costs (super/payroll tax/WorkCover, floored at 22.7%) + a
variable margin (default 15%). Saves quotes and produces a printable summary.

Pay data source: the Fair Work Commission's Modern Awards Pay Database, pulled from its
API on 2026-11-08 (156 awards) with `scripts/fetch_map_api.py` + `scripts/build_seed_api.py`
(see "Refreshing the award data" below). Before that it was a manual spreadsheet export
snapshotted 2026-08-13 (`scripts/build_seed.py`, kept for reference). Casual loading
percentages for the ~96 awards without an official casual pay table in that export
were extracted 2026-08-13 by fetching each award's own casual-employment clause from
awards.fairwork.gov.au — see `scripts/casual_loading_data.py` for the per-award figures,
clause references, and confidence flags. **Neither of these is a substitute for legal
advice — the award is the controlling instrument.**

## Local dev (already working)

```
npm install --no-save wrangler   # or use npx as below
```

1. `.dev.vars` needs `SESSION_SECRET=<random string>` (already created locally, not committed).
2. `npx wrangler d1 execute wtc-labour-rates --local --file=migrations/0001_init.sql`
   then `0002_casual_loading.sql`, then `0003_casual_rate_source.sql`.
3. Load the award data: run each file in `seed/` in order (`01_awards.sql` ..
   `06_casual_loading.sql`) with `npx wrangler d1 execute wtc-labour-rates --local --file=seed/<name>`.
4. Bootstrap a staff account: `node scripts/create-admin.mjs "you@email" "Your Name" admin`
   — prints a `wrangler d1 execute --local` command, run it.
5. `npx wrangler dev --local --port 8789` (or use the Claude Code preview: `wtc-labour-rates`
   launch config in the hostelworld-scraper repo's `.claude/launch.json`).

## Deploying (not done yet — needs you)

1. `npx wrangler d1 create wtc-labour-rates` — creates the real D1 database, prints
   a `database_id`. Paste that into `wrangler.jsonc` (`REPLACE_WITH_D1_DATABASE_ID`).
2. Run the same migration + seed files against `--remote` instead of `--local`.
3. `npx wrangler secret put SESSION_SECRET` — pick a new random value, don't reuse the local one.
4. Bootstrap the first real admin the same way as local dev, but against `--remote`.
5. `npx wrangler deploy`.
6. Once deployed, use the in-app "Staff accounts" panel (admin only) to add everyone else —
   each gets emailed... no, currently the temp password is only shown once in the UI, so
   whoever creates the account needs to relay it to the new staff member securely.

## Known data gaps / things to sanity-check before relying on this for real quotes

- **Casual loading fallback**: for the ~96 awards without an explicit casual pay table
  in the MAP export, the tool applies a flat casual-loading % (mostly 25%, sourced from
  each award's own clause — see `casual_loading_data.py`) on top of the permanent rates.
  A few awards have a non-standard/complex loading (day-dependent, split by duty type,
  or genuinely uncertain) — those are flagged `complex`/`uncertain`/`not_found` in the
  data and the app shows a warning banner; confirm those manually before quoting.
- Awards with **zero penalty-rate rows at all** in the source export (e.g. some salaried
  professional awards like Medical Practitioners) can't be rostered by this tool — it'll
  return "no rate categories found."
- On-cost floor (22.7%) and default margin (15%) are enforced/defaulted in
  `worker/calc.js` — change there if the business changes these figures.
- Everything is a **snapshot dated 2026-11-08**. Awards get updated at least annually
  (1 July wage review) and occasionally mid-year — refresh periodically (below).

## Refreshing the award data

Needs an API key for the Fair Work Modern Awards API (https://developer.fwc.gov.au),
in `FWC_API_KEY` or the first line of `scripts/.fwc_api_key` (gitignored — never commit it).

1. `python scripts/fetch_map_api.py` — pulls current rows for every award into `scripts/.api_cache/`
   (gitignored; delete it first to force a full refetch; ~15 min). The API's paging is unstable
   (rows repeat/vanish), so the script repeats each pass with different page sizes until stable.
2. `python scripts/build_seed_api.py` — writes staged SQL to `seed_api/` (picks the newest version when the
   API leaves two open, prefers the hourly rate row, repairs the API's mojibake text).
3. `python scripts/compare_seeds.py` — diff of staged vs `seed/`: rate changes, new/removed classifications,
   allowances. Read it before going on; existing hourly rates should show 0% change except real updates.
4. Apply to local, run `node scripts/test_roster_engine.mjs`, then to remote one table at a time:
   `npx wrangler d1 execute wtc-labour-rates --remote --yes --file=seed_api/<file>.sql` for
   `apply_awards` (an upsert, so the casual-loading columns on `awards` survive), then
   `02_classifications`, `03_penalty_rates`, `04_wage_allowances`, `05_expense_allowances`.
5. Copy `seed_api/0[1-5]*.sql` over `seed/` and commit.

Known gaps in API data: penalty rows have no clause reference (`clauses` is NULL; the UI falls back to the
clause description), and a new award has no casual-loading entry until added to `casual_loading_data.py`
(MA000037 Quarrying currently has none).

## Future: labour hire agreement generation

Tom plans to supply a labour hire agreement template that should get the role,
pay rates, and charge rate built into a document sent back to the client/supplier.
Not built yet — flagged here for the next round of work.
