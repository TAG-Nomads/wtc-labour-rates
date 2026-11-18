// Time-of-day / day-of-week penalties that some awards pay as a flat $/hour on top of the ordinary rate
// (e.g. Hospitality: "Penalty—Monday to Friday—7.00 pm to midnight", $2.95 per hour). For quoting they behave
// like their own hourly rate (ordinary rate + penalty), so they're shown as rate lines rather than as allowances.
// Pure functions, shared by the quote builder and covered by scripts/test_quote_calc.mjs.

const WEEKEND_OR_PH = /saturday|sunday|public holiday|weekend/i;

export const isHourlyPenalty = (name, frequency) => /penalty/i.test(name || "") && /hour/i.test(frequency || "");

// Which days an allowance applies to, judged from its name.
export function allowanceScope(name) {
  const n = name || "";
  if (/monday/i.test(n)) return "weekday";
  if (/saturday/i.test(n) && !/sunday|public holiday/i.test(n)) return "saturday";
  if (/sunday|public holiday/i.test(n)) return "sunday";
  return "any";
}

// A Monday-to-Friday penalty can't sit on Saturday, Sunday or public-holiday hours (they have their own rates).
export function scopeConflict(allowanceName, categoryName) {
  return allowanceScope(allowanceName) === "weekday" && WEEKEND_OR_PH.test(categoryName || "");
}

// The ordinary-hours category a penalty belongs on: first non-overtime category that fits its days.
// categories: [{ name, isOvertime }]. Returns the category name, or null if none fits (then it stays an allowance).
export function baseCategoryFor(allowanceName, categories) {
  const scope = allowanceScope(allowanceName);
  const fits = (c) => {
    if (c.isOvertime) return false;
    if (scope === "weekday") return !WEEKEND_OR_PH.test(c.name);
    if (scope === "saturday") return /saturday/i.test(c.name);
    if (scope === "sunday") return /sunday|public holiday/i.test(c.name);
    return false;
  };
  const hit = categories.find(fits);
  return hit ? hit.name : null;
}

// "Penalty—Monday to Friday—7.00 pm to midnight" on "Ordinary hours"
//   -> "Ordinary hours + penalty (Monday to Friday, 7.00 pm to midnight)"
export function penaltyLineLabel(categoryName, allowanceName) {
  const rest = String(allowanceName || "")
    .replace(/^(early work |late work )?penalty\s*[—-]\s*/i, "")
    .replace(/\s*—\s*/g, ", ");
  return `${categoryName} + penalty (${rest})`;
}

// Moves hourly penalty allowances onto the hourly rate lines. The totals don't change: the penalty hours come
// off the base category and reappear as a line at (base rate + penalty) for the same hours.
//   lines: [{ penaltyDescription, hours, loadedRate, isOvertime, ... }]  (before charge rates)
//   allowanceLines: [{ allowance, quantity, amount, unit, appliesToCategory, ... }]
// Returns { lines, allowanceLines } with the folded allowances removed from allowanceLines.
export function foldHourlyPenalties(lines, allowanceLines) {
  const out = lines.map((l) => ({ ...l }));
  const remaining = [];
  const used = new Map(); // base category -> hours already moved
  const added = new Map(); // base category -> [new lines]
  for (const a of allowanceLines) {
    const base = a.appliesToCategory && out.find((l) => l.penaltyDescription === a.appliesToCategory);
    if (!base || base.isOvertime || !isHourlyPenalty(a.allowance, a.unit)) {
      remaining.push(a);
      continue;
    }
    const moved = (used.get(base.penaltyDescription) || 0) + a.quantity;
    if (moved > base.hours + 1e-9) {
      remaining.push(a); // would take more hours than the category has: leave it as an allowance
      continue;
    }
    used.set(base.penaltyDescription, moved);
    const rate = base.loadedRate + a.amount;
    const list = added.get(base.penaltyDescription) || [];
    list.push({
      penaltyDescription: penaltyLineLabel(base.penaltyDescription, a.allowance),
      hours: a.quantity,
      loadedRate: rate,
      lineTotal: rate * a.quantity,
      isOvertime: false,
      penaltyOf: base.penaltyDescription,
      penaltyAmount: a.amount,
    });
    added.set(base.penaltyDescription, list);
  }
  const result = [];
  for (const l of out) {
    const moved = used.get(l.penaltyDescription) || 0;
    const left = Math.round((l.hours - moved) * 1e6) / 1e6;
    if (left > 0) result.push({ ...l, hours: left, lineTotal: l.loadedRate * left });
    for (const n of added.get(l.penaltyDescription) || []) result.push(n);
  }
  return { lines: result, allowanceLines: remaining };
}
