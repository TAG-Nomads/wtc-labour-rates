// Casual shift costing for the awards we've researched clause-by-clause:
//   MA000004 General Retail, MA000009 Hospitality (General), MA000084 Storage
//   Services and Wholesale. Adult casuals only.
//
// Given proposed shifts, it classifies every worked minute as ordinary, penalty
// or overtime under the award's own rules and returns hours per pay category,
// with each rate computed as a % of the permanent base rate (casual loading is
// already inside every casual percentage -- it is never added again). The
// percentages and clause numbers below come from the award text; the test
// script (scripts/test_roster_engine.mjs) checks the resulting rates against
// the official Fair Work pay data to the cent.
//
// Time model: a week, Monday = 0 ... Sunday = 6. Shifts that run past midnight
// are split by calendar day, so Saturday/Sunday/public-holiday rules start at
// midnight. Public holidays are ticked by the user per day of the week.

const MIN = 60;
const DAY = 1440;

// cents, rounded half-up -- integer maths avoids float drift on x.5 cents.
const rate = (baseCents, pct) => Math.round((baseCents * pct) / 100) / 100;

const CLAUSE_ORD = "Casual ordinary and penalty rates";
const CLAUSE_OT = "Casual overtime rates";

// label, pct of base (casual column, loading included), clauses, isOvertime
const TABLES = {
  MA000004: [
    ["Ordinary hours", 125, "Table 12, cl 22.1(b)", false],
    ["Monday to Friday after 6.00 pm", 150, "Table 12, cl 22.1(b)", false],
    ["Saturday", 150, "Table 12, cl 22.1(b)", false],
    ["Sunday", 175, "Table 12, cl 22.1(b)", false],
    ["Public holiday", 250, "Table 12, cl 22.1(b), cl 33.3", false],
    ["Shiftwork - Monday to Friday", 155, "cl 25.1", false],
    ["Shiftwork - Saturday", 175, "cl 25.1", false],
    ["Shiftwork - Sunday", 200, "cl 25.1", false],
    ["Shiftwork - Public holiday", 250, "cl 25.3(a), Table 12", false],
    ["Overtime - Monday to Saturday, first 3 hours", 175, "Table 11, cl 21.2", true],
    ["Overtime - Monday to Saturday, after 3 hours", 225, "Table 11, cl 21.2", true],
    ["Overtime - Sunday", 225, "Table 11, cl 21.2", true],
    ["Overtime - Public holiday", 275, "Table 11, cl 21.2", true],
  ],
  MA000009: [
    ["Ordinary hours", 125, "Table 14, cl 29.2(b)", false],
    ["Saturday", 150, "Table 14, cl 29.2(b)", false],
    ["Sunday", 175, "Table 14, cl 29.2(b)", false],
    ["Public holiday", 250, "Table 14, cl 29.2(b)", false],
    // Overtime is a % of the BASE rate; the casual loading is not added (Schedule B.2.4).
    ["Overtime - Monday to Friday, first 2 hours", 150, "Table 13, cl 28.4", true],
    ["Overtime - Monday to Friday, after 2 hours", 200, "Table 13, cl 28.4", true],
    ["Overtime - Saturday and Sunday", 200, "Table 13, cl 28.4", true],
    ["Overtime - Public holiday", 250, "Schedule B.2.4", true],
  ],
  MA000084: [
    ["Ordinary hours", 125, "Schedule B.2.1, cl 11.2", false],
    ["Early morning shift", 137.5, "Schedule B.2.2, cl 20.4(a)", false],
    ["Afternoon shift", 140, "Schedule B.2.2, cl 20.4(b)", false],
    ["Night shift", 155, "Schedule B.2.2, cl 20.4(c)", false],
    ["Saturday", 175, "cl 22.1(a)", false],
    ["Sunday", 225, "cl 22.2(a)", false],
    ["Public holiday", 275, "cl 22.3(a)", false],
    ["Overtime - first 2 hours", 175, "cl 21.1(d)", true],
    ["Overtime - after 2 hours", 225, "cl 21.1(d)", true],
    ["Overtime - Sunday", 225, "cl 21.1(d), cl 22.2(a)", true],
  ],
};

const DEFAULT_DAILY_CAP = { MA000004: 9, MA000009: 12, MA000084: 8 };
const MIN_ENGAGEMENT = { MA000004: 3 * MIN, MA000009: 2 * MIN, MA000084: 4 * MIN };

export const SUPPORTED_AWARDS = {
  MA000004: {
    name: "General Retail Industry Award 2020",
    dailyCap: 9,
    options: ["shiftworker", "lateTrading", "dailyCapHours"],
  },
  MA000009: { name: "Hospitality Industry (General) Award 2020", dailyCap: 12, options: ["dailyCapHours"] },
  MA000084: { name: "Storage Services and Wholesale Award 2020", dailyCap: 8, options: ["dailyCapHours"] },
};

export const isSupported = (awardCode) => Object.prototype.hasOwnProperty.call(SUPPORTED_AWARDS, awardCode);

export const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// Rate table in the same row shape the DB category lookup uses, so the quote
// pipeline can treat engine output like any other set of pay categories.
export function rateTable(awardCode, baseCents) {
  return TABLES[awardCode].map(([label, pct, clauses, ot]) => ({
    penalty_description: label,
    clause_description: ot ? `${CLAUSE_OT} (${clauses})` : `${CLAUSE_ORD} (${clauses})`,
    clauses,
    rate_percent: pct,
    calculated_value: rate(baseCents, pct),
  }));
}

const hhmm = (min) => {
  const m = ((min % DAY) + DAY) % DAY;
  const h = Math.floor(m / 60);
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m % 60).padStart(2, "0")} ${ampm}`;
};

function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
  if (!m) throw new Error(`"${s}" isn't a valid time (use HH:MM)`);
  const mins = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`"${s}" isn't a valid time`);
  return mins;
}

function normaliseShifts(shifts) {
  const out = shifts.map((s, i) => {
    const day = Number(s.day);
    if (!(day >= 0 && day <= 6)) throw new Error(`Shift ${i + 1}: pick a day of the week`);
    const start = parseTime(s.start);
    let duration;
    if (s.lengthHours != null && s.lengthHours !== "") duration = Math.round(Number(s.lengthHours) * MIN);
    else if (s.finish) duration = (((parseTime(s.finish) - start) % DAY) + DAY) % DAY;
    else throw new Error(`Shift ${i + 1}: enter a length or a finish time`);
    if (!(duration > 0) || duration > DAY) throw new Error(`Shift ${i + 1}: length must be between 0 and 24 hours`);
    const brk = Math.round(Number(s.breakMins) || 0);
    if (brk < 0 || brk >= duration) throw new Error(`Shift ${i + 1}: unpaid break must be shorter than the shift`);
    const startAbs = day * DAY + start;
    const breakOffset = Math.min(4 * MIN, Math.floor((duration - brk) / 2));
    return { idx: i, day, start, duration, brk, startAbs, endAbs: startAbs + duration, breakOffset };
  });
  out.sort((a, b) => a.startAbs - b.startAbs);
  for (let i = 1; i < out.length; i++) {
    if (out[i].startAbs < out[i - 1].endAbs) {
      throw new Error(
        `Shifts overlap: ${DAY_NAMES[out[i - 1].day]} ${hhmm(out[i - 1].start)} runs into the ${DAY_NAMES[out[i].day]} ${hhmm(out[i].start)} shift`
      );
    }
  }
  return out;
}

export function costShifts({ awardCode, baseCents, shifts, publicHolidays = [], otherHours = 0, options = {} }) {
  if (!isSupported(awardCode)) throw new Error("This award isn't supported by the shift calculator yet");
  if (!(baseCents > 0)) throw new Error("No base rate found for this classification");

  const table = rateTable(awardCode, baseCents);
  const rateByLabel = new Map(table.map((r) => [r.penalty_description, r]));
  const ph = new Set((publicHolidays || []).map(Number));
  const cap = Math.round((Number(options.dailyCapHours) || DEFAULT_DAILY_CAP[awardCode]) * MIN);
  const weeklyCap = 38 * MIN;
  const norm = normaliseShifts(shifts);

  const warnings = [];
  const assumptions = [];
  const addOnMinutes = { eve: 0, night: 0 };
  const totals = new Map(); // label -> minutes
  const shiftDetails = [];

  let weeklyOrd = Math.max(0, Number(otherHours) || 0) * MIN;
  const dayWorked = new Map();
  const dayOt = new Map();

  const retailShiftwork = awardCode === "MA000004" && !!options.shiftworker;
  const lateTrading = !!options.lateTrading;

  const retailSpan = (dow) => {
    if (dow <= 4) return [7 * MIN, lateTrading ? 23 * MIN : 21 * MIN];
    if (dow === 5) return [7 * MIN, lateTrading ? 23 * MIN : 18 * MIN];
    return [9 * MIN, lateTrading ? 23 * MIN : 18 * MIN];
  };

  // Storage Services: which shift type a weekday shift is (cl 20.1, 13.1(b)).
  const storageType = (s) => {
    const finishAbs = s.endAbs;
    const finishTod = ((finishAbs % DAY) + DAY) % DAY;
    const sameDayFinish = finishAbs < (s.day + 1) * DAY || finishAbs === (s.day + 1) * DAY;
    const matches = [];
    if (s.start >= 2 * MIN && s.start < 7 * MIN) matches.push("Early morning shift");
    if (sameDayFinish && (finishTod > 18 * MIN || finishAbs === (s.day + 1) * DAY)) matches.push("Afternoon shift");
    if (!sameDayFinish && finishTod > 0 && finishTod <= 8 * MIN + 30) matches.push("Night shift");
    if (s.start >= 7 * MIN && sameDayFinish && finishTod <= 17 * MIN + 30 && finishAbs !== (s.day + 1) * DAY) matches.push("Ordinary hours");
    return matches;
  };

  for (const s of norm) {
    const label0 = `${DAY_NAMES[s.day]} ${hhmm(s.start)} - ${hhmm(s.start + s.duration)}`;
    const segs = new Map();
    let firstLabel = null;
    let workedMin = 0;

    // Classification needed once per shift for Storage weekday shifts.
    let sType = null;
    if (awardCode === "MA000084") {
      let hasWeekday = false;
      for (let off = 0; off < s.duration; off++) {
        const m = s.startAbs + off;
        const dow = Math.floor(m / DAY) % 7;
        if (dow <= 4 && !ph.has(dow)) {
          hasWeekday = true;
          break;
        }
      }
      if (hasWeekday) {
        const types = storageType(s);
        if (types.length !== 1) {
          throw new Error(
            types.length === 0
              ? `${label0}: doesn't fit a Storage Services shift type (day work 7:00 am-5:30 pm; early morning starts 2-7 am; afternoon finishes after 6 pm up to midnight; night finishes after midnight up to 8:30 am). Choose the classification manually using the by-category entry.`
              : `${label0}: fits more than one Storage Services shift type (${types.join(" and ")}) and the award doesn't say which applies. Choose manually using the by-category entry.`
          );
        }
        sType = types[0];
      }
    }

    // Retail shiftwork only applies to shifts starting 6 pm - 5 am (cl 24.1).
    let retailShift = false;
    if (retailShiftwork) {
      retailShift = s.start >= 18 * MIN || s.start < 5 * MIN;
      if (!retailShift) {
        warnings.push(`${label0}: starts outside 6 pm - 5 am, so it isn't shiftwork (cl 24.1) and is costed as normal hours.`);
      }
    }

    for (let off = 0; off < s.duration; off++) {
      if (s.brk > 0 && off >= s.breakOffset && off < s.breakOffset + s.brk) continue;
      const m = s.startAbs + off;
      const dow = Math.floor(m / DAY) % 7;
      const tod = m % DAY;
      const isPh = ph.has(dow);
      const worked = dayWorked.get(s.day) || 0;
      const otToday = dayOt.get(s.day) || 0;

      let label;
      let isOt = false;

      const dailyExceeded = worked >= cap;
      const weeklyExceeded = weeklyOrd >= weeklyCap;

      if (awardCode === "MA000004") {
        if (retailShift) {
          // Shiftwork: only the weekly 38-hour trigger is applied (see assumptions).
          isOt = weeklyExceeded;
          if (!isOt) {
            // A shift that begins on a public holiday is a public holiday shift for all its hours (cl 25.3(b)).
            label = isPh || ph.has(s.day)
              ? "Shiftwork - Public holiday"
              : dow === 5
              ? "Shiftwork - Saturday"
              : dow === 6
              ? "Shiftwork - Sunday"
              : "Shiftwork - Monday to Friday";
          }
        } else {
          const [from, to] = retailSpan(dow);
          isOt = dailyExceeded || weeklyExceeded || tod < from || tod >= to;
          if (!isOt) {
            label = isPh ? "Public holiday" : dow === 5 ? "Saturday" : dow === 6 ? "Sunday" : tod >= 18 * MIN ? "Monday to Friday after 6.00 pm" : "Ordinary hours";
          }
        }
        if (isOt) {
          label = isPh
            ? "Overtime - Public holiday"
            : dow === 6
            ? "Overtime - Sunday"
            : otToday < 3 * MIN
            ? "Overtime - Monday to Saturday, first 3 hours"
            : "Overtime - Monday to Saturday, after 3 hours";
        }
      } else if (awardCode === "MA000009") {
        isOt = dailyExceeded || weeklyExceeded;
        if (!isOt) {
          label = isPh ? "Public holiday" : dow === 5 ? "Saturday" : dow === 6 ? "Sunday" : "Ordinary hours";
          if (label === "Ordinary hours") {
            if (tod >= 19 * MIN) addOnMinutes.eve += 1;
            else if (tod < 7 * MIN) addOnMinutes.night += 1;
          }
        } else {
          label = isPh
            ? "Overtime - Public holiday"
            : dow >= 5
            ? "Overtime - Saturday and Sunday"
            : otToday < 2 * MIN
            ? "Overtime - Monday to Friday, first 2 hours"
            : "Overtime - Monday to Friday, after 2 hours";
        }
      } else {
        // Storage Services
        isOt = dailyExceeded || weeklyExceeded;
        if (isPh) {
          label = "Public holiday"; // no separate overtime tier on a public holiday (cl 22.3(a))
          isOt = false;
        } else if (isOt) {
          label = dow === 6 ? "Overtime - Sunday" : otToday < 2 * MIN ? "Overtime - first 2 hours" : "Overtime - after 2 hours";
        } else {
          label = dow === 5 ? "Saturday" : dow === 6 ? "Sunday" : sType || "Ordinary hours";
        }
      }

      if (isOt) dayOt.set(s.day, otToday + 1);
      else weeklyOrd += 1;
      dayWorked.set(s.day, worked + 1);
      workedMin += 1;
      if (firstLabel == null) firstLabel = label;
      segs.set(label, (segs.get(label) || 0) + 1);
      totals.set(label, (totals.get(label) || 0) + 1);
    }

    // Minimum engagement top-up, paid at the rate the shift started in.
    const minEng = MIN_ENGAGEMENT[awardCode];
    if (workedMin > 0 && workedMin < minEng) {
      const short = minEng - workedMin;
      segs.set(firstLabel, (segs.get(firstLabel) || 0) + short);
      totals.set(firstLabel, (totals.get(firstLabel) || 0) + short);
      warnings.push(
        `${label0}: worked ${(workedMin / 60).toFixed(2)} h, under the ${minEng / 60}-hour minimum engagement - topped up to ${minEng / 60} h at the "${firstLabel}" rate.`
      );
    }

    shiftDetails.push({
      day: s.day,
      dayName: DAY_NAMES[s.day],
      start: hhmm(s.start),
      finish: hhmm(s.start + s.duration),
      breakMins: s.brk,
      workedHours: Math.round((workedMin / 60) * 100) / 100,
      segments: [...segs.entries()].map(([label, mins]) => ({
        label,
        hours: Math.round((mins / 60) * 100) / 100,
        isOvertime: rateByLabel.get(label).clause_description.startsWith(CLAUSE_OT),
      })),
    });
  }

  // Rest-gap and meal-break warnings -- flagged, not priced (decision: warn only).
  for (let i = 1; i < norm.length; i++) {
    const gapH = (norm[i].startAbs - norm[i - 1].endAbs) / 60;
    if (awardCode === "MA000004" && gapH < 12) {
      warnings.push(`Only ${gapH.toFixed(1)} h between ${DAY_NAMES[norm[i - 1].day]} and ${DAY_NAMES[norm[i].day]} shifts: Retail cl 16.6 requires a 12-hour break (10 by agreement) or the following hours are paid at 200% until a 12-hour break. Not priced - check.`);
    }
    if (awardCode === "MA000084" && gapH < 10) {
      warnings.push(`Only ${gapH.toFixed(1)} h between ${DAY_NAMES[norm[i - 1].day]} and ${DAY_NAMES[norm[i].day]} shifts: Storage Services cl 21.4 requires 10 hours off, otherwise a casual is paid 225% until released. Not priced - check.`);
    }
  }
  const mealThreshold = awardCode === "MA000009" ? 6 * MIN : 5 * MIN;
  for (const s of norm) {
    if (s.brk === 0 && s.duration > mealThreshold) {
      warnings.push(
        `${DAY_NAMES[s.day]} ${hhmm(s.start)} shift is over ${mealThreshold / 60} hours with no unpaid meal break entered. ` +
          (awardCode === "MA000009" ? "Hospitality cl 16 requires a 30-minute unpaid meal break after 6 hours; working through it carries a 50% penalty (cl 16.6)." : "A meal break is required within 5 hours.")
      );
    }
  }

  // Lines in rate-table order.
  const lines = table
    .filter((r) => totals.has(r.penalty_description))
    .map((r) => {
      const hours = Math.round((totals.get(r.penalty_description) / 60) * 100) / 100;
      return {
        label: r.penalty_description,
        hours,
        rate: r.calculated_value,
        isOvertime: r.clause_description.startsWith(CLAUSE_OT),
        clauses: r.clauses,
      };
    });

  const otHours = lines.filter((l) => l.isOvertime).reduce((a, l) => a + l.hours, 0);
  if (awardCode === "MA000004" && otHours > 1) {
    warnings.push("Retail overtime of more than 1 hour may trigger the overtime meal allowance (cl 19.2: $24.56, plus $22.27 if over 4 hours) - not included.");
  }
  if (awardCode === "MA000084" && otHours > 0) {
    warnings.push("Storage Services overtime may trigger an overtime meal allowance (cl 17.3(a)) - not included.");
  }

  // Hospitality evening / night add-ons are separate allowance lines.
  const addOns = [];
  if (awardCode === "MA000009") {
    if (addOnMinutes.eve > 0) {
      addOns.push({
        allowance: "Penalty—Monday to Friday—7.00 pm to midnight",
        quantity: Math.round((addOnMinutes.eve / 60) * 100) / 100,
        appliesToCategory: "Ordinary hours",
      });
    }
    if (addOnMinutes.night > 0) {
      addOns.push({
        allowance: "Penalty—Monday to Friday—midnight to 7.00 am",
        quantity: Math.round((addOnMinutes.night / 60) * 100) / 100,
        appliesToCategory: "Ordinary hours",
      });
    }
    if (addOns.length) {
      assumptions.push("The evening/night add-ons are paid 'per hour or part of an hour' (Table 14); exact hours are used here, so part-hours are not rounded up.");
    }
  }

  assumptions.push(`Unpaid break is placed ${shifts.some((x) => Number(x.breakMins) > 0) ? "in the middle of the shift (or 4 hours in, whichever is sooner)" : "n/a - none entered"}.`);
  assumptions.push(`Daily ordinary-hours cap used: ${cap / 60} hours per shift/day; weekly cap: 38 hours (4-week averaging is not modelled). Hours already worked this week: ${Math.max(0, Number(otherHours) || 0)}.`);
  if (awardCode === "MA000004") {
    assumptions.push("Ordinary hours outside the award's span (Mon-Fri 7am-9pm, Sat 7am-6pm, Sun 9am-6pm) are overtime (cl 21.2). Shifts past the span are priced as overtime unless the worker is employed as a shiftworker or the site trades later.");
    if (retailShiftwork) assumptions.push("Shiftwork: only the weekly 38-hour overtime trigger is applied - the award's daily limits for shiftworkers were not verified.");
  }
  if (awardCode === "MA000009") assumptions.push("Casual overtime is a percentage of the base rate, not the loaded rate (Schedule B.2.4). Penalties do not apply to overtime hours (cl 29.1) and don't stack (cl 29.3(b)).");
  if (awardCode === "MA000084") assumptions.push("Public holiday hours are paid 275% with no separate overtime tier (cl 22.3(a)). Sunday overtime is priced at 225% (cl 21.1(d)) - the award isn't explicit for casuals.");
  if (ph.size) assumptions.push(`Public holidays ticked: ${[...ph].sort().map((d) => DAY_NAMES[d]).join(", ")}.`);

  return { lines, rateTable: table, shiftDetails, addOns, warnings, assumptions };
}
