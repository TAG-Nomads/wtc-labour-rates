// Tests for the quote build-up pieces that don't need the database:
// hourly penalties folded into hourly rate lines, the Monday-to-Friday guard, and the margin floor.
// Run: node scripts/test_quote_calc.mjs
import { foldHourlyPenalties, baseCategoryFor, scopeConflict, penaltyLineLabel, isHourlyPenalty } from "../worker/penalties.js";
import { applyAllowances, applyOncostAndMargin, blendAwardRate, addChargeRates } from "../worker/calc.js";

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${name}${ok ? "" : "  -> " + detail}`);
  if (!ok) failed++;
};
const near = (a, b) => Math.abs(a - b) < 1e-9;

const EVE = "Penalty—Monday to Friday—7.00 pm to midnight";
const NIGHT = "Penalty—Monday to Friday—midnight to 7.00 am";

// Hospitality-like rate rows (casual, rate in $/hr)
const rateRows = [
  { penalty_description: "Ordinary hours", clause_description: "ordinary and penalty rates", calculated_value: 32.18 },
  { penalty_description: "Saturday", clause_description: "ordinary and penalty rates", calculated_value: 40.23 },
  { penalty_description: "Public holiday", clause_description: "ordinary and penalty rates", calculated_value: 64.36 },
  { penalty_description: "Monday to Friday - First 2 hours", clause_description: "overtime rates", calculated_value: 48.27 },
];
const allowanceRows = [
  { allowance: EVE, allowance_amount: 2.95, payment_frequency: "per hour or part thereof" },
  { allowance: NIGHT, allowance_amount: 4.42, payment_frequency: "per hour or part thereof" },
  { allowance: "Clothing allowance", allowance_amount: 1.23, payment_frequency: "per day" },
];

// --- label + classification helpers
check("label from allowance name", penaltyLineLabel("Ordinary hours", EVE) === "Ordinary hours + penalty (Monday to Friday, 7.00 pm to midnight)", penaltyLineLabel("Ordinary hours", EVE));
check("'Early work penalty' prefix is stripped", penaltyLineLabel("Ordinary hours", "Early work penalty—Monday to Friday, midnight to 7.00 am") === "Ordinary hours + penalty (Monday to Friday, midnight to 7.00 am)");
check("hourly penalty detected", isHourlyPenalty(EVE, "per hour or part thereof") && !isHourlyPenalty("Clothing allowance", "per day") && !isHourlyPenalty("First aid", "per hour"));
const cats = rateRows.map((r) => ({ name: r.penalty_description, isOvertime: /overtime/i.test(r.clause_description) }));
check("weekday penalty belongs on 'Ordinary hours'", baseCategoryFor(EVE, cats) === "Ordinary hours", baseCategoryFor(EVE, cats));
check("Saturday penalty belongs on Saturday", baseCategoryFor("Penalty—Saturday", cats) === "Saturday");
check("Mon-Fri penalty conflicts with Saturday/PH, not with Ordinary hours",
  scopeConflict(EVE, "Saturday (1h)") && scopeConflict(EVE, "Public holiday") && !scopeConflict(EVE, "Ordinary hours"));

// --- Laura's case: evening penalty attached to Saturday must be refused
const roster = [
  { penaltyDescription: "Ordinary hours", hours: 10 },
  { penaltyDescription: "Saturday", hours: 1 },
];
const blended = blendAwardRate(roster, rateRows);
let err = null;
try {
  applyAllowances([{ allowance: EVE, quantity: 1, appliesToCategory: "Saturday" }], allowanceRows, blended.lines, blended.totalPay, blended.totalHours);
} catch (e) {
  err = e.message;
}
check("Mon-Fri evening penalty can't be attached to Saturday", !!err && /Monday to Friday/.test(err), err);

// --- fold: totals unchanged, penalty hours move to their own line at base + penalty
const sel = [
  { allowance: EVE, quantity: 3, appliesToCategory: "Ordinary hours" },
  { allowance: NIGHT, quantity: 2, appliesToCategory: "Ordinary hours" },
  { allowance: "Clothing allowance", quantity: 1 },
];
const withA = applyAllowances(sel, allowanceRows, blended.lines, blended.totalPay, blended.totalHours);
const folded = foldHourlyPenalties(blended.lines, withA.lines);
const hrs = (label) => folded.lines.find((l) => l.penaltyDescription === label)?.hours;
check("plain ordinary hours reduced by the penalty hours", near(hrs("Ordinary hours"), 5), hrs("Ordinary hours"));
check("evening line holds 3h", near(hrs("Ordinary hours + penalty (Monday to Friday, 7.00 pm to midnight)"), 3));
check("night line holds 2h", near(hrs("Ordinary hours + penalty (Monday to Friday, midnight to 7.00 am)"), 2));
check("evening rate is base + $2.95", near(folded.lines.find((l) => /7\.00 pm/.test(l.penaltyDescription)).loadedRate, 32.18 + 2.95));
check("total hours unchanged", near(folded.lines.reduce((a, l) => a + l.hours, 0), blended.totalHours));
check("per-day allowance stays an allowance", folded.allowanceLines.length === 1 && folded.allowanceLines[0].allowance === "Clothing allowance");
const pay = folded.lines.reduce((a, l) => a + l.loadedRate * l.hours, 0) + folded.allowanceLines.reduce((a, l) => a + l.lineTotal, 0);
check("total pay unchanged by folding", near(pay, withA.totalPay), `${pay} vs ${withA.totalPay}`);
const charged = addChargeRates(folded.lines, 22.7, 15, "loadedRate", "hours");
const markup = 1.227 * 1.15;
check("charge rate on the penalty line = (base + penalty) x on-costs x margin", near(charged.find((l) => /7\.00 pm/.test(l.penaltyDescription)).chargeRate, (32.18 + 2.95) * markup));
check("order: penalty lines sit right after their base line", folded.lines.map((l) => l.penaltyDescription).slice(0, 3).join("|").startsWith("Ordinary hours|Ordinary hours + penalty"));

// all hours penalised -> base line disappears
const all = foldHourlyPenalties(blended.lines, [{ allowance: EVE, quantity: 10, amount: 2.95, unit: "per hour or part thereof", appliesToCategory: "Ordinary hours" }]);
check("a category fully covered by a penalty has no plain line left", !all.lines.some((l) => l.penaltyDescription === "Ordinary hours"));

// --- margin is free to set (no floor); the on-cost floor still applies
check("any margin is accepted, including below 8%", applyOncostAndMargin(40, 22.7, 5, 22.7).chargeRate > 40 && near(applyOncostAndMargin(40, 22.7, 0, 22.7).chargeRate, 40 * 1.227));
let e2 = null;
try {
  applyOncostAndMargin(40, 20, 15, 22.7);
} catch (e) {
  e2 = e.message;
}
check("on-cost floor is still enforced", !!e2 && /22\.7%/.test(e2), e2);

console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
process.exit(failed ? 1 : 0);
