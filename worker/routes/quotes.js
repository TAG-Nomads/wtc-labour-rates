import { match } from "../router.js";
import { json, error } from "../http.js";
import { requireSession } from "./staff.js";
import { blendAwardRate, applyAllowances, applyOncostAndMargin, addChargeRates } from "../calc.js";
import { getRateCategories } from "../rates.js";
import { getAllowanceRows } from "../allowances.js";
import { getSettings } from "../settings.js";
import { costShifts, isSupported } from "../rosterEngine.js";

// Base (permanent) hourly rate in cents for a classification -- the engine
// derives every casual percentage from this.
async function getBaseCents(env, basePayRateId) {
  const c = await env.DB.prepare(
    "SELECT employee_rate_type_code, calculated_rate FROM classifications WHERE base_pay_rate_id = ?"
  )
    .bind(basePayRateId)
    .first();
  if (!c) throw new Error("Classification not found");
  if (c.employee_rate_type_code !== "AD") {
    throw new Error("The shift calculator only covers adult classifications - use by-category entry for juniors/apprentices");
  }
  if (!(c.calculated_rate > 0)) throw new Error("This classification has no hourly base rate on file");
  return Math.round(c.calculated_rate * 100);
}

// Runs the shift engine for a request body. Throws Error(message) on bad input;
// callers turn that into a 400.
async function runShiftEngine(env, body) {
  if (!isSupported(body.awardCode)) throw new Error("The shift calculator doesn't cover this award yet - use by-category entry");
  if (!body.isCasual) throw new Error("The shift calculator is casual-only - tick Casual placement or use by-category entry");
  const baseCents = await getBaseCents(env, body.basePayRateId);
  return costShifts({
    awardCode: body.awardCode,
    baseCents,
    shifts: body.shifts,
    publicHolidays: body.publicHolidays,
    otherHours: body.otherHoursThisWeek,
    options: body.shiftOptions || {},
  });
}

// Quotes saved before per-category charge rates existed only stored award rates.
// Derive the charge fields from the quote's own on-cost/margin so old quotes
// still render (same flat multiplier addChargeRates uses at calculation time).
function withCharge(lines, rateKey, qtyKey, row) {
  const markup = (1 + row.oncost_pct / 100) * (1 + (Number(row.margin_pct) || 0) / 100);
  return lines.map((l) => {
    if (l.chargeRate != null && l.chargeLineTotal != null) return l;
    const chargeRate = l[rateKey] * markup;
    return { ...l, chargeRate, chargeLineTotal: chargeRate * l[qtyKey] };
  });
}

function quoteRow(row) {
  return {
    ...row,
    roster: withCharge(JSON.parse(row.roster_json), "loadedRate", "hours", row),
    allowances: withCharge(row.allowances_json ? JSON.parse(row.allowances_json) : [], "amount", "quantity", row),
    shifts: row.shifts_json ? JSON.parse(row.shifts_json) : null,
    isCasual: !!row.is_casual,
  };
}

export async function handleQuotes(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  const staff = await requireSession(request, env);
  if (!staff) return error("Not authenticated", 401);

  // Work out hours per pay category from proposed shifts (no pricing yet).
  if (match("/api/staff/roster/calculate", pathname) && method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!Array.isArray(body.shifts) || !body.shifts.length) return error("Add at least one shift");
    try {
      const r = await runShiftEngine(env, body);
      return json({ lines: r.lines, shiftDetails: r.shiftDetails, addOns: r.addOns, warnings: r.warnings, assumptions: r.assumptions });
    } catch (e) {
      return error(e.message, 400);
    }
  }

  // Preview a calculation without saving it — used as the user edits the roster.
  if (match("/api/staff/quotes/preview", pathname) && method === "POST") {
    const computed = await computeQuote(request, env);
    if (computed instanceof Response) return computed;
    return json(computed.result);
  }

  if (match("/api/staff/quotes", pathname) && method === "POST") {
    const computed = await computeQuote(request, env);
    if (computed instanceof Response) return computed;
    const { body, result } = computed;
    const row = await env.DB.prepare(
      `INSERT INTO quotes (
         staff_id, client_name, role_title, award_code, award_name, base_pay_rate_id, classification_name,
         employee_rate_type_code, is_casual, casual_loading_pct, casual_rate_source, oncost_pct, margin_pct, roster_json,
         allowances_json, shifts_json, blended_award_rate, cost_rate, charge_rate, notes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    )
      .bind(
        staff.id,
        body.clientName,
        body.roleTitle || null,
        body.awardCode,
        body.awardName,
        body.basePayRateId,
        body.classificationName,
        body.employeeRateTypeCode,
        body.isCasual ? 1 : 0,
        result.usedFallbackLoading ? body.casualLoadingPct : null,
        result.casualRateSource,
        body.oncostPct,
        body.marginPct,
        JSON.stringify(result.lines),
        result.allowanceLines.length ? JSON.stringify(result.allowanceLines) : null,
        result.shiftPlan ? JSON.stringify(result.shiftPlan) : null,
        result.blendedAwardRate,
        result.costRate,
        result.chargeRate,
        body.notes || null
      )
      .first();
    return json(quoteRow(row), 201);
  }

  if (match("/api/staff/quotes", pathname) && method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT q.*, s.name AS staff_name FROM quotes q
       JOIN staff_users s ON s.id = q.staff_id ORDER BY q.created_at DESC LIMIT 200`
    ).all();
    return json(rows.results.map(quoteRow));
  }

  let m = match("/api/staff/quotes/:id", pathname);
  if (m && method === "GET") {
    const row = await env.DB.prepare(
      `SELECT q.*, s.name AS staff_name FROM quotes q
       JOIN staff_users s ON s.id = q.staff_id WHERE q.id = ?`
    )
      .bind(m.id)
      .first();
    if (!row) return error("Not found", 404);
    return json(quoteRow(row));
  }

  return error("Not found", 404);
}

async function computeQuote(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.basePayRateId || !body.awardCode) return error("basePayRateId and awardCode required");
  // Shift mode: hours per category come from the shift engine (with any manual
  // line overrides); by-category mode: they're entered directly.
  const shiftMode = Array.isArray(body.shifts) && body.shifts.length > 0;
  if (!shiftMode && (!Array.isArray(body.roster) || !body.roster.length)) return error("roster required");

  const settings = await getSettings(env);
  const oncostPct = body.oncostPct != null ? Number(body.oncostPct) : settings.oncostFloorPct;
  const marginPct = body.marginPct != null ? Number(body.marginPct) : settings.defaultMarginPct;

  let rateRows;
  let hasCasualTable;
  let usedFallbackLoading;
  let roster = body.roster;
  let allowanceSelections = body.allowances;
  let shiftPlan = null;

  if (shiftMode) {
    let engine;
    try {
      engine = await runShiftEngine(env, body);
    } catch (e) {
      return error(e.message, 400);
    }
    rateRows = engine.rateTable;
    hasCasualTable = true;
    usedFallbackLoading = false;
    const hoursByLabel = new Map(engine.lines.map((l) => [l.label, l.hours]));
    const overrides = body.lineOverrides && typeof body.lineOverrides === "object" ? body.lineOverrides : {};
    const overridden = [];
    for (const [label, h] of Object.entries(overrides)) {
      if (!rateRows.some((r) => r.penalty_description === label)) return error(`Unknown pay category "${label}"`);
      const hours = Number(h);
      if (!(hours >= 0)) return error(`Hours for "${label}" must be zero or more`);
      if (Math.abs((hoursByLabel.get(label) || 0) - hours) > 0.001) overridden.push({ label, from: hoursByLabel.get(label) || 0, to: hours });
      hoursByLabel.set(label, hours);
    }
    roster = [...hoursByLabel.entries()].filter(([, h]) => h > 0).map(([label, hours]) => ({ penaltyDescription: label, hours }));
    allowanceSelections = [...engine.addOns, ...(Array.isArray(body.allowances) ? body.allowances : [])];
    shiftPlan = {
      shifts: engine.shiftDetails,
      publicHolidays: body.publicHolidays || [],
      otherHoursThisWeek: Number(body.otherHoursThisWeek) || 0,
      options: body.shiftOptions || {},
      warnings: engine.warnings,
      assumptions: engine.assumptions,
      overrides: overridden,
    };
  } else {
    const got = await getRateCategories(env, body.basePayRateId, {
      wantCasual: !!body.isCasual,
      fallbackPct: body.casualLoadingPct,
    });
    rateRows = got.rows;
    hasCasualTable = got.hasCasualTable;
    usedFallbackLoading = got.usedFallbackLoading;
  }
  if (!rateRows.length) return error("No rate categories found for this classification", 404);

  let blended;
  try {
    blended = blendAwardRate(roster, rateRows);
  } catch (e) {
    return error(e.message, 400);
  }

  let withAllowances;
  try {
    const allowanceRows = await getAllowanceRows(env, body.awardCode);
    withAllowances = applyAllowances(allowanceSelections, allowanceRows, blended.lines, blended.totalPay, blended.totalHours);
  } catch (e) {
    return error(e.message, 400);
  }

  let costAndCharge;
  try {
    costAndCharge = applyOncostAndMargin(withAllowances.blendedAwardRate, oncostPct, marginPct, settings.oncostFloorPct);
  } catch (e) {
    return error(e.message, 400);
  }

  const casualRateSource = shiftMode
    ? "shift_calculator"
    : !body.isCasual
    ? "not_casual"
    : hasCasualTable
    ? "award_table"
    : "loading_fallback";

  const result = {
    shiftPlan,
    // Per-category charge rate: what the client is actually invoiced for each
    // category -- exactly what the staff member earns there, plus on-costs/margin.
    lines: addChargeRates(blended.lines, oncostPct, marginPct, "loadedRate", "hours"),
    allowanceLines: addChargeRates(withAllowances.lines, oncostPct, marginPct, "amount", "quantity"),
    totalHours: blended.totalHours,
    totalPay: withAllowances.totalPay,
    // Weighted average across the roster -- a reference figure only. The
    // client is never actually charged this single number; see lines above.
    blendedAwardRate: withAllowances.blendedAwardRate,
    oncostPct,
    marginPct,
    costRate: costAndCharge.costRate,
    chargeRate: costAndCharge.chargeRate,
    oncostFloorPct: settings.oncostFloorPct,
    hasCasualTable,
    usedFallbackLoading,
    casualRateSource,
  };

  return { body, result };
}
