// Rate build-up: award rate (blended from entered hours x official penalty-category
// rates) -> on-costs (super/payroll tax/WorkCover, floored at a configurable %) -> margin.
// The floor and default margin are owner-editable business settings stored in
// app_settings (see worker/settings.js), not constants -- these are just the
// values used if no settings row exists yet (should never happen post-migration).
export const FALLBACK_ONCOST_FLOOR_PCT = 22.7;
export const FALLBACK_DEFAULT_MARGIN_PCT = 15;

import { scopeConflict } from "./penalties.js";

const isOvertimeClause = (clauseDescription) => /overtime/i.test(clauseDescription || "");

// roster: [{ penaltyDescription, hours }], rateRows: penalty_rates rows for the
// chosen classification + casual/permanent split (from GET .../categories),
// each with { penalty_description, clause_description, calculated_value }. Any
// casual loading is already baked into calculated_value by that endpoint --
// this function never applies a loading itself, so it can't be double-applied.
export function blendAwardRate(roster, rateRows) {
  const rowByCategory = new Map(rateRows.map((r) => [r.penalty_description, r]));
  let totalPay = 0;
  let totalHours = 0;
  const lines = [];
  for (const line of roster) {
    const hours = Number(line.hours) || 0;
    if (hours <= 0) continue;
    const row = rowByCategory.get(line.penaltyDescription);
    if (row == null) {
      throw new Error(`No rate found for category "${line.penaltyDescription}" on this classification`);
    }
    const rate = row.calculated_value;
    totalPay += rate * hours;
    totalHours += hours;
    lines.push({
      penaltyDescription: line.penaltyDescription,
      hours,
      loadedRate: rate,
      lineTotal: rate * hours,
      isOvertime: isOvertimeClause(row.clause_description),
    });
  }
  if (totalHours <= 0) throw new Error("Roster has no hours entered");
  return { lines, totalHours, totalPay, blendedAwardRate: totalPay / totalHours };
}

const isHourlyAllowance = (paymentFrequency) => /hour/i.test(paymentFrequency || "");

// selections: [{ allowance, quantity, appliesToCategory }], allowanceRows: this
// award's full allowance list (from getAllowanceRows) -- matched by exact
// allowance name so the dollar amount always comes from our data, never
// trusted from the client. rosterLines: the roster lines already computed by
// blendAwardRate, so we can validate an hourly add-on's quantity against the
// SPECIFIC category it's attached to (not just the roster total) -- e.g. an
// evening penalty that only applies to ordinary hours must be capped to that
// category's hours, not allowed to piggyback on overtime hours as well, which
// usually already carries its own premium and isn't meant to stack with this.
// Per-shift/day/occasion allowances aren't hour-window add-ons in this way, so
// they don't need a category attached.
// The extra dollars are folded into totalPay (and so into blendedAwardRate)
// WITHOUT adding to totalHours, since these aren't extra hours worked -- this
// spreads the flat allowance evenly across the rostered hours, which is the
// right way to fold a flat $ amount into a $/hr charge rate.
export function applyAllowances(selections, allowanceRows, rosterLines, totalPay, totalHours) {
  const rowByName = new Map(allowanceRows.map((r) => [r.allowance, r]));
  const lineByCategory = new Map(rosterLines.map((l) => [l.penaltyDescription, l]));
  const lines = [];
  let allowanceTotal = 0;
  for (const sel of selections || []) {
    const qty = Number(sel.quantity) || 0;
    if (qty <= 0) continue;
    const row = rowByName.get(sel.allowance);
    if (row == null) throw new Error(`Unknown allowance "${sel.allowance}" for this award`);
    if (isHourlyAllowance(row.payment_frequency)) {
      if (!sel.appliesToCategory) {
        throw new Error(`"${sel.allowance}" is paid per hour on top of a specific roster category -- pick which category it applies to.`);
      }
      const targetLine = lineByCategory.get(sel.appliesToCategory);
      if (targetLine == null) {
        throw new Error(`"${sel.allowance}" is attached to "${sel.appliesToCategory}", which has no hours entered in the roster above.`);
      }
      if (targetLine.isOvertime) {
        throw new Error(
          `"${sel.allowance}" can't be attached to "${sel.appliesToCategory}" -- overtime hours already carry their own premium and ` +
            `aren't ordinary hours, so this per-hour penalty doesn't stack on top of them. Attach it to an ordinary-hours category instead.`
        );
      }
      if (scopeConflict(sel.allowance, sel.appliesToCategory)) {
        throw new Error(
          `"${sel.allowance}" only applies Monday to Friday, so it can't be attached to "${sel.appliesToCategory}" -- ` +
            `Saturday, Sunday and public-holiday hours have their own rates.`
        );
      }
      if (qty > targetLine.hours) {
        throw new Error(
          `"${sel.allowance}" is set to ${qty} hours but "${sel.appliesToCategory}" only has ${targetLine.hours} hours in the roster above -- ` +
            `this add-on can't cover more hours than the category it's attached to.`
        );
      }
    }
    const lineTotal = row.allowance_amount * qty;
    allowanceTotal += lineTotal;
    lines.push({
      allowance: sel.allowance,
      quantity: qty,
      amount: row.allowance_amount,
      unit: row.payment_frequency,
      appliesToCategory: sel.appliesToCategory || null,
      lineTotal,
    });
  }
  const newTotalPay = totalPay + allowanceTotal;
  return { lines, allowanceTotal, totalPay: newTotalPay, blendedAwardRate: totalHours > 0 ? newTotalPay / totalHours : 0 };
}

export function applyOncostAndMargin(blendedAwardRate, oncostPct, marginPct, oncostFloorPct) {
  if (oncostPct < oncostFloorPct) {
    throw new Error(`On-cost % cannot be below the ${oncostFloorPct}% floor (super + payroll tax + WorkCover)`);
  }
  const costRate = blendedAwardRate * (1 + oncostPct / 100);
  const chargeRate = costRate * (1 + (Number(marginPct) || 0) / 100);
  return { costRate, chargeRate };
}

// The client is invoiced per category, at exactly what the staff member earns
// for that category plus on-costs/margin -- never a single blended rate. This
// attaches the same on-cost%/margin% (a flat multiplier, so applying it per
// line is mathematically consistent with the blended total) to each roster
// and allowance line, so the rate card handed to a client/supplier shows the
// real per-category charge rate, not an average.
export function addChargeRates(lines, oncostPct, marginPct, rateKey, qtyKey) {
  const markup = (1 + oncostPct / 100) * (1 + (Number(marginPct) || 0) / 100);
  return lines.map((l) => {
    const chargeRate = l[rateKey] * markup;
    return { ...l, chargeRate, chargeLineTotal: chargeRate * l[qtyKey] };
  });
}
