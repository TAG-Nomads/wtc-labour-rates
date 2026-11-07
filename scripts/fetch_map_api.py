"""
Pulls the Fair Work Modern Awards Pay Database (MAAPI v1) into a local JSON cache,
one file per award per dataset, so build_seed_api.py can turn it into seed SQL.

Key: environment variable FWC_API_KEY, or the first line of scripts/.fwc_api_key
(gitignored). Never commit the key.

Run:   python scripts/fetch_map_api.py            (all awards)
       python scripts/fetch_map_api.py MA000009   (one award, for testing)
Cache: scripts/.api_cache/<award>/<dataset>.json   (gitignored; delete to force a refetch)

Only rows currently in force (operative_to is null, or in the future) are kept.
"""
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = "https://api.fwc.gov.au/api/v1"
HERE = Path(__file__).resolve().parent
CACHE = HERE / ".api_cache"
DATASETS = ["classifications", "pay-rates", "penalties", "wage-allowances", "expense-allowances"]
TODAY = datetime.date.today().isoformat()


def api_key():
    k = os.environ.get("FWC_API_KEY")
    if not k and (HERE / ".fwc_api_key").exists():
        k = (HERE / ".fwc_api_key").read_text().strip().splitlines()[0]
    if not k:
        sys.exit("No API key: set FWC_API_KEY or put it in scripts/.fwc_api_key")
    return k.strip()


KEY = api_key()


def get(url, tries=8):
    for attempt in range(tries):
        req = urllib.request.Request(url, headers={"Ocp-Apim-Subscription-Key": KEY})
        try:
            time.sleep(0.2)  # be gentle: the gateway answers bursts with 403 Access Denied
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # 403 is the gateway throttling a burst (the key itself still works); back off and retry
            if e.code in (403, 429, 500, 502, 503, 504) and attempt < tries - 1:
                wait = int(e.headers.get("Retry-After", "0") or 0) or min(120, 5 * 2 ** attempt)
                time.sleep(wait)
                continue
            raise RuntimeError(f"{url} -> HTTP {e.code}: {e.read()[:200]!r}")
        except (urllib.error.URLError, TimeoutError):
            if attempt < tries - 1:
                time.sleep(2 ** attempt)
                continue
            raise


def fetch_all(path):
    """All pages of a list endpoint (max page size is 100)."""
    rows, page = [], 1
    while True:
        sep = "&" if "?" in path else "?"
        d = get(f"{BASE}{path}{sep}limit=100&page={page}")
        rows.extend(d["results"])
        if not d["_meta"]["has_more_results"]:
            return rows
        page += 1


def current(row):
    ot = row.get("operative_to")
    return ot is None or ot >= TODAY


SORT = {
    "classifications": "operative_to,classification_fixed_id,clause_fixed_id",
    "pay-rates": "operative_to,classification_fixed_id,employee_rate_type_code",
    "penalties": "operative_to,clause_fixed_id,classification_level,penalty_description,employee_rate_type_code",
    "wage-allowances": "operative_to",
    "expense-allowances": "operative_to",
}
PASS_LIMITS = [100, 93, 77, 61, 50]


def one_pass(path, sort, limit):
    """Current rows only. Sorting by operative_to lists open-ended (current) rows first, so stop
    at the first page with none - history is skipped entirely."""
    rows, page = [], 1
    while True:
        d = get(f"{BASE}{path}?sort={sort}&limit={limit}&page={page}")
        cur = [r for r in d["results"] if current(r)]
        rows.extend(cur)
        if not cur or not d["_meta"]["has_more_results"]:
            return rows
        page += 1


def fetch_current(path, ds):
    """The API's paging is unstable when sort keys tie (rows repeat on one page and vanish from
    another), so repeat the pass with different page sizes and union by full-row identity until
    two passes in a row add nothing."""
    seen, stable = {}, 0
    for limit in PASS_LIMITS:
        before = len(seen)
        for r in one_pass(path, SORT[ds], limit):
            seen.setdefault(json.dumps(r, sort_keys=True), r)
        stable = stable + 1 if len(seen) == before and before else 0
        if stable >= 2:
            break
    else:
        print(f"  WARNING {path}: still gaining rows on the last pass ({len(seen)})", flush=True)
    return list(seen.values())


def fetch_award_dataset(code, ds):
    out = CACHE / code / f"{ds}.json"
    if out.exists():
        return
    rows = fetch_current(f"/awards/{code}/{ds}", ds)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows), encoding="utf-8")


def main():
    CACHE.mkdir(exist_ok=True)
    awards_path = CACHE / "awards.json"
    if len(sys.argv) > 1:
        codes = sys.argv[1:]
    else:
        awards = fetch_all("/awards")
        awards_path.write_text(json.dumps(awards), encoding="utf-8")
        codes = sorted({a["code"] for a in awards})
    print(f"{len(codes)} award(s), key ...{KEY[-4:]}")
    jobs = [(c, ds) for c in codes for ds in DATASETS]
    done = 0

    def run(job):
        nonlocal done
        fetch_award_dataset(*job)
        done += 1
        if done % 25 == 0 or done == len(jobs):
            print(f"  {done}/{len(jobs)}", flush=True)

    with ThreadPoolExecutor(max_workers=2) as ex:
        list(ex.map(run, jobs))
    print("done")


if __name__ == "__main__":
    main()
