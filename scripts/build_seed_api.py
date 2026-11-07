"""
Builds seed SQL from the Fair Work MAAPI cache written by fetch_map_api.py.

Same tables/columns as build_seed.py (which reads the manual spreadsheet exports), so
the two sources are interchangeable. Writes to seed_api/ (a staging folder) - compare
it with seed/ (scripts/compare_seeds.py) before copying files across.

Run: python scripts/build_seed_api.py
"""
import csv
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / ".api_cache"
OUT = HERE.parent / "seed_api"
OUT.mkdir(exist_ok=True)
AWARD_INDEX = Path(r"C:\Users\Tom Cooney\Downloads\award-index.csv")  # source_url / consolidated_to (display only)


def fix_text(s):
    """The API serves UTF-8 text that was decoded as cp1252 and re-encoded ('â€”' for an em dash). Undo it."""
    if not isinstance(s, str) or not any(c in s for c in "âÃ"):
        return s
    try:
        raw = bytearray()
        for ch in s:
            try:
                raw += ch.encode("cp1252")
            except UnicodeEncodeError:
                raw += ch.encode("latin-1")  # C1 controls (e.g. U+009D) map to the same byte
        return raw.decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


def sql_str(v):
    if v is None:
        return "NULL"
    return "'" + fix_text(str(v)).replace("'", "''") + "'"


def sql_num(v):
    return "NULL" if v is None or v == "" else str(v)


def load(code, ds):
    return json.loads((CACHE / code / f"{ds}.json").read_text(encoding="utf-8"))


def latest(rows, key):
    """One row per key, keeping the highest version_number (the API can return several current versions)."""
    # The API sometimes leaves an older version open (operative_to null) next to the new one, so the
    # newest operative_from wins, then the highest version.
    rank = lambda r: (r.get("operative_from") or "", r.get("version_number") or 0)
    best = {}
    for r in rows:
        k = key(r)
        if k not in best or rank(r) >= rank(best[k]):
            best[k] = r
    return list(best.values()), best


def write_inserts(name, table, columns, rows, batch=400):
    with open(OUT / name, "w", encoding="utf-8", newline="\n") as f:
        f.write(f"DELETE FROM {table};\n")
        for i in range(0, len(rows), batch):
            f.write(f"INSERT INTO {table} ({', '.join(columns)}) VALUES\n")
            f.write(",\n".join(rows[i : i + batch]))
            f.write(";\n")
    print(f"{table}: {len(rows)}")


meta = {}
if AWARD_INDEX.exists():
    with open(AWARD_INDEX, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            meta[r["award_code"]] = r

awards = json.loads((CACHE / "awards.json").read_text(encoding="utf-8"))
awards, _ = latest(awards, lambda a: a["code"])
awards.sort(key=lambda a: a["code"])
codes = [a["code"] for a in awards if (CACHE / a["code"] / "expense-allowances.json").exists()]
missing = [a["code"] for a in awards if a["code"] not in codes]
if missing:
    raise SystemExit(f"cache incomplete, rerun fetch_map_api.py - missing: {missing[:10]}")

write_inserts(
    "01_awards.sql",
    "awards",
    ["award_code", "name", "operative_from", "source_url", "consolidated_to"],
    [
        "("
        + ", ".join(
            [
                sql_str(a["code"]),
                sql_str((a["name"] or "").strip()),
                sql_str(a["award_operative_from"]),
                sql_str(meta.get(a["code"], {}).get("source_url")),
                sql_str(meta.get(a["code"], {}).get("consolidated_to")),
            ]
        )
        + ")"
        for a in awards
    ],
)

cls_rows, pen_rows, wage_rows, exp_rows = [], [], [], []
for code in codes:
    # --- classifications: payable rows only (they carry a basePayRateID) ---
    pay = [p for p in load(code, "pay-rates") if p["base_pay_rate_id"] and p["classification_level"] is not None and p["employee_rate_type_code"]]
    # The API returns one row per calculated-rate type for weekly/annual-based classifications
    # (Annual + Hourly). The tool needs the hourly figure, so prefer that row; an hourly-based
    # classification has no calculated row at all, so its base rate IS the hourly rate.
    def hourly_rank(p):
        if p["calculated_rate_type"] == "Hourly":
            return 0
        if p["base_rate_type"] == "Hourly":
            return 1
        return 2

    newest = {}
    for p in pay:  # drop superseded versions of the same rate id first
        k = p["base_pay_rate_id"]
        newest[k] = max(newest.get(k, ""), p["operative_from"] or "")
    pay = [p for p in pay if (p["operative_from"] or "") == newest[p["base_pay_rate_id"]]]
    chosen = {}
    for p in sorted(pay, key=hourly_rank):
        chosen.setdefault(p["base_pay_rate_id"], p)
    pay = [chosen[k] for k in dict.fromkeys(p["base_pay_rate_id"] for p in pay)]
    for p in pay:
        if p["calculated_rate_type"] != "Hourly":
            if p["base_rate_type"] == "Hourly":
                p["calculated_rate"], p["calculated_rate_type"] = p["base_rate"], "Hourly"
            else:
                p["calculated_rate"], p["calculated_rate_type"] = None, None  # annual-only: not quotable per hour
    order = {}
    for i, p in enumerate(pay, 1):
        order[p["base_pay_rate_id"]] = i
        cls_rows.append(
            "("
            + ", ".join(
                [
                    sql_str(p["base_pay_rate_id"]),
                    sql_str(code),
                    sql_str(p["employee_rate_type_code"]),
                    sql_str(p["parent_classification_name"]),
                    sql_str(p["classification"]),
                    sql_num(p["classification_level"]),
                    sql_num(p["base_rate"]),
                    sql_str(p["base_rate_type"]),
                    sql_num(p["calculated_rate"]),
                    sql_str(p["calculated_rate_type"]),
                    sql_num(i),
                ]
            )
            + ")"
        )
    by_bpr = {p["base_pay_rate_id"]: p for p in pay}

    # --- penalties: rows tied to a classification's base pay rate ---
    pens = [p for p in load(code, "penalties") if p["base_pay_rate_id"] in by_bpr]
    pens, _ = latest(pens, lambda p: (p["penalty_fixed_id"], p["base_pay_rate_id"]))
    pens.sort(key=lambda p: (order[p["base_pay_rate_id"]], p["clause_fixed_id"], p["penalty_fixed_id"]))
    col = {}
    for p in pens:
        k = (p["base_pay_rate_id"], p["clause_fixed_id"])
        col[k] = col.get(k, 0) + 1
        c = by_bpr[p["base_pay_rate_id"]]
        pen_rows.append(
            "("
            + ", ".join(
                [
                    sql_str(code),
                    sql_str(p["base_pay_rate_id"]),
                    sql_str(c["classification"]),
                    sql_num(c["classification_level"]),
                    sql_str(c["employee_rate_type_code"]),
                    sql_str(p["penalty_description"]),
                    sql_str(p["clause_description"]),
                    "NULL",  # the API does not carry the clause reference; the UI falls back to clause_description
                    sql_num(p["rate"]),
                    sql_num(p["penalty_calculated_value"]),
                    sql_num(col[k]),
                    sql_num(order[p["base_pay_rate_id"]]),
                ]
            )
            + ")"
        )

    # --- wage allowances (classification-tied) ---
    wages, _ = latest(load(code, "wage-allowances"), lambda w: (w["wage_allowance_fixed_id"], w["base_pay_rate_id"]))
    for i, w in enumerate(sorted(wages, key=lambda w: (w["wage_allowance_fixed_id"], w["base_pay_rate_id"] or "")), 1):
        wage_rows.append(
            "("
            + ", ".join(
                [
                    sql_str(code),
                    sql_str(w["base_pay_rate_id"]),
                    sql_str(w["allowance"]),
                    sql_num(1 if w["is_all_purpose"] else 0),
                    sql_num(w["rate"]),
                    sql_num(w["allowance_amount"]),
                    sql_str(w["rate_unit"]),
                    sql_str(w["payment_frequency"]),
                    sql_num(i),
                ]
            )
            + ")"
        )

    # --- expense allowances (flat per award) ---
    exps, _ = latest(load(code, "expense-allowances"), lambda e: e["expense_allowance_fixed_id"])
    for i, e in enumerate(sorted(exps, key=lambda e: e["expense_allowance_fixed_id"]), 1):
        exp_rows.append(
            "("
            + ", ".join(
                [
                    sql_str(code),
                    sql_str(e["allowance"]),
                    sql_num(e["allowance_amount"]),
                    sql_str(e["payment_frequency"]),
                    sql_num(i),
                ]
            )
            + ")"
        )

write_inserts(
    "02_classifications.sql",
    "classifications",
    [
        "base_pay_rate_id", "award_code", "employee_rate_type_code", "parent_classification_name", "classification",
        "classification_level", "base_rate", "base_rate_type", "calculated_rate", "calculated_rate_type", "display_order",
    ],
    cls_rows,
)
write_inserts(
    "03_penalty_rates.sql",
    "penalty_rates",
    [
        "award_code", "base_pay_rate_id", "classification", "classification_level", "employee_rate_type_code",
        "penalty_description", "clause_description", "clauses", "rate_percent", "calculated_value",
        "column_display_order", "classification_display_order",
    ],
    pen_rows,
    batch=150,
)
write_inserts(
    "04_wage_allowances.sql",
    "wage_allowances",
    [
        "award_code", "base_pay_rate_id", "allowance", "is_all_purpose", "rate_percent", "allowance_amount",
        "rate_unit", "payment_frequency", "display_order",
    ],
    wage_rows,
)
write_inserts(
    "05_expense_allowances.sql",
    "expense_allowances",
    ["award_code", "allowance", "allowance_amount", "payment_frequency", "display_order"],
    exp_rows,
)


# --- apply.sql: one script that swaps the data tables in the right order ---
# awards is upserted rather than replaced: the casual-loading columns added by migration 0002 live
# on that table and must survive a refresh. Children are cleared first, then refilled.
awards_sql = (OUT / "01_awards.sql").read_text(encoding="utf-8").replace("DELETE FROM awards;\n", "")
awards_sql = awards_sql.replace(
    ";\n",
    " ON CONFLICT(award_code) DO UPDATE SET name = excluded.name, operative_from = excluded.operative_from,"
    " source_url = COALESCE(excluded.source_url, awards.source_url),"
    " consolidated_to = COALESCE(excluded.consolidated_to, awards.consolidated_to);\n",
)
with open(OUT / "apply.sql", "w", encoding="utf-8", newline="\n") as f:
    f.write(awards_sql)
    for name in ["02_classifications.sql", "03_penalty_rates.sql", "04_wage_allowances.sql", "05_expense_allowances.sql"]:
        f.write((OUT / name).read_text(encoding="utf-8"))
print("apply.sql written")
