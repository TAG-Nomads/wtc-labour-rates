"""
Compares the live seed (seed/) with a staged seed (seed_api/): what a refresh would change.

Run: python scripts/compare_seeds.py
"""
import re
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = ["01_awards.sql", "02_classifications.sql", "03_penalty_rates.sql", "04_wage_allowances.sql", "05_expense_allowances.sql"]


def build(folder):
    db = sqlite3.connect(":memory:")
    schema = (ROOT / "migrations" / "0001_init.sql").read_text(encoding="utf-8")
    for stmt in re.findall(r"CREATE TABLE (?:awards|classifications|penalty_rates|wage_allowances|expense_allowances) \(.*?\n\);", schema, flags=re.S):
        db.execute(stmt)
    for f in FILES:
        db.executescript((ROOT / folder / f).read_text(encoding="utf-8"))
    return db


old, new = build("seed"), build("seed_api")
q = lambda db, sql: db.execute(sql).fetchall()

print("== row counts (old -> new)")
for t in ["awards", "classifications", "penalty_rates", "wage_allowances", "expense_allowances"]:
    print(f"  {t}: {q(old, f'select count(*) from {t}')[0][0]} -> {q(new, f'select count(*) from {t}')[0][0]}")

oa = {r[0]: r[1] for r in q(old, "select award_code,name from awards")}
na = {r[0]: r[1] for r in q(new, "select award_code,name from awards")}
print("== awards added:", {c: na[c] for c in na if c not in oa}, " removed:", {c: oa[c] for c in oa if c not in na})
print("== renamed:", {c: (oa[c], na[c]) for c in oa if c in na and oa[c] != na[c]})

# classifications: same base pay rate id, did the rate change?
oc = {r[0]: r for r in q(old, "select base_pay_rate_id,award_code,classification,calculated_rate,employee_rate_type_code,calculated_rate_type from classifications")}
nc = {r[0]: r for r in q(new, "select base_pay_rate_id,award_code,classification,calculated_rate,employee_rate_type_code,calculated_rate_type from classifications")}
print(f"== classifications: {len(oc.keys() & nc.keys())} in both, {len(nc.keys() - oc.keys())} new ids, {len(oc.keys() - nc.keys())} old ids gone")
pct = Counter()
big = []
fixed = Counter()  # old row had no usable hourly rate (annual figure or none); new one does
for k in oc.keys() & nc.keys():
    o, n, otype = oc[k][3], nc[k][3], oc[k][5]
    if otype == "Hourly" and o and n:
        ch = (n - o) / o * 100
        pct[round(ch, 1)] += 1
        if abs(ch) > 8 or ch < 0:
            big.append((oc[k][1], oc[k][2], o, n, round(ch, 1)))
    elif otype == "Hourly" and not n:
        big.append((oc[k][1], oc[k][2], o, n, "LOST hourly rate"))
    elif otype != "Hourly" and n:
        fixed[oc[k][1]] += 1
print("  rows where the OLD seed had a real hourly rate: % change distribution (rounded 0.1):", dict(sorted(pct.items())))
print("  unusual (>8% or negative) / lost:", len(big))
for b in big[:15]:
    print("   ", b)
print(f"  rows that had no hourly rate in the old seed but do now: {sum(fixed.values())} across {len(fixed)} awards")
print(f"  rows with no hourly rate in the new seed: {sum(1 for r in nc.values() if not r[3])} (old: {sum(1 for r in oc.values() if r[5] != 'Hourly' or not r[3])})")
gone_by_award = Counter(oc[k][1] for k in oc.keys() - nc.keys())
new_by_award = Counter(nc[k][1] for k in nc.keys() - oc.keys())
print("  old ids gone by award:", dict(gone_by_award.most_common(8)))
print("  new ids by award:", dict(new_by_award.most_common(8)))

# penalties: per (bpr, clause_description, penalty_description) did the % change?
def pens(db):
    d = {}
    for r in q(db, "select base_pay_rate_id,clause_description,penalty_description,rate_percent,calculated_value from penalty_rates"):
        d.setdefault((r[0], r[1], r[2]), []).append((r[3], r[4]))
    return d

op, np_ = pens(old), pens(new)
both = op.keys() & np_.keys()
chg = [(k, op[k], np_[k]) for k in both if sorted(op[k]) != sorted(np_[k])]
same_pct_diff = [c for c in chg if [x[0] for x in c[1]] != [x[0] for x in c[2]]]
print(f"== penalties: {len(both)} keys in both; {len(np_.keys() - op.keys())} new; {len(op.keys() - np_.keys())} gone; {len(chg)} with a changed value; {len(same_pct_diff)} with a changed percentage")
for c in same_pct_diff[:10]:
    print("   ", c)
oa_ = Counter(k[1] for k in op.keys() - np_.keys())
print("  gone clause descriptions:", dict(oa_.most_common(5)))

# allowances
def allow(db, table):
    return {(r[0], r[1]): r[2] for r in q(db, f"select award_code, allowance, allowance_amount from {table}")}
for t in ["wage_allowances", "expense_allowances"]:
    o, n = allow(old, t), allow(new, t)
    print(f"== {t}: {len(o)} -> {len(n)}; added {len(n.keys() - o.keys())}, removed {len(o.keys() - n.keys())}, amount changed {sum(1 for k in o.keys() & n.keys() if o[k] != n[k])}")
    for k in list(o.keys() - n.keys())[:5]:
        print("   removed:", k)
    for k in list(n.keys() - o.keys())[:5]:
        print("   added:", k)

bad = sum(open(ROOT / "seed_api" / f, encoding="utf-8").read().count("â€") for f in FILES)
print("== leftover mojibake sequences in new seed:", bad)
