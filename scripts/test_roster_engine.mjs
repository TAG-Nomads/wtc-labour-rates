// Run: node scripts/test_roster_engine.mjs   (needs the local D1 seeded)
// 1. Engine rate tables vs the official Fair Work pay data, every adult classification.
// 2. Worked shift examples with hand-checked expected hours.
import { execSync } from "node:child_process";
import { costShifts, rateTable } from "../worker/rosterEngine.js";

let failures = 0;
const check = (name, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.log(`FAIL  ${name} ${detail}`);
  } else console.log(`ok    ${name}`);
};

function q(sql) {
  const out = execSync(`npx wrangler d1 execute wtc-labour-rates --local --json --command "${sql.replace(/"/g, '\\"')}"`, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}

// ---------- 1. rates vs official data ----------
const AWARDS = ["MA000004", "MA000009", "MA000084"];
const MAP = {
  MA000004: {
    "Casual adult employees other than shiftworkers—ordinary and penalty rates": {
      "Ordinary hours": "Ordinary hours",
      "Monday to Friday after 6.00 pm": "Monday to Friday after 6.00 pm",
      Saturday: "Saturday",
      Sunday: "Sunday",
      "Public holiday": "Public holiday",
    },
    "Casual adult shiftworkers—shiftwork and penalty rates": {
      "Other than baking production employees (OBPE): Monday to Friday - Starting at or after 6.00 pm and before 5.00 am": "Shiftwork - Monday to Friday",
      "All shiftworkers: Saturday - OBPE and BPE": "Shiftwork - Saturday",
      "All shiftworkers: Sunday - OBPE and BPE": "Shiftwork - Sunday",
      "All shiftworkers: Public holiday - all hours within shift": "Shiftwork - Public holiday",
    },
  },
  MA000009: {
    "Adult casual employees—ordinary and penalty rates": {
      "Ordinary hours": "Ordinary hours",
      Saturday: "Saturday",
      Sunday: "Sunday",
      "Public holiday": "Public holiday",
    },
    "Adult casual employees—overtime rates": {
      "Monday to Friday - First 2 hours": "Overtime - Monday to Friday, first 2 hours",
      "Monday to Friday - After 2 hours": "Overtime - Monday to Friday, after 2 hours",
      Weekends: "Overtime - Saturday and Sunday",
      "Public holiday": "Overtime - Public holiday",
    },
  },
  MA000084: {
    "Casual employees—day workers—ordinary and penalty rates": {
      "Ordinary Hours": "Ordinary hours",
      Saturday: "Saturday",
      Sunday: "Sunday",
      "Public Holiday": "Public holiday",
    },
    "Casual employees—shiftworkers—penalty rates": {
      "Early Morning": "Early morning shift",
      Afternoon: "Afternoon shift",
      Night: "Night shift",
    },
  },
};

for (const award of AWARDS) {
  const cls = q(`SELECT base_pay_rate_id, classification, calculated_rate FROM classifications WHERE award_code='${award}' AND employee_rate_type_code='AD' AND calculated_rate IS NOT NULL`);
  const rows = q(`SELECT base_pay_rate_id, penalty_description, clause_description, calculated_value FROM penalty_rates WHERE award_code='${award}' AND clause_description LIKE '%asual%'`);
  const byBpr = new Map();
  for (const r of rows) {
    if (!byBpr.has(r.base_pay_rate_id)) byBpr.set(r.base_pay_rate_id, []);
    byBpr.get(r.base_pay_rate_id).push(r);
  }
  let compared = 0;
  let mismatches = [];
  for (const c of cls) {
    const base = Math.round(c.calculated_rate * 100);
    const table = new Map(rateTable(award, base).map((r) => [r.penalty_description, r.calculated_value]));
    for (const r of byBpr.get(c.base_pay_rate_id) || []) {
      const label = MAP[award][r.clause_description] && MAP[award][r.clause_description][r.penalty_description];
      if (!label) continue;
      compared++;
      const eng = table.get(label);
      if (Math.abs(eng - r.calculated_value) > 0.0001) mismatches.push(`${c.classification} / ${label}: engine ${eng} vs official ${r.calculated_value}`);
    }
  }
  check(`${award}: ${compared} official casual rates across ${cls.length} classifications match to the cent`, mismatches.length === 0 && compared > 0, `\n      ${mismatches.slice(0, 8).join("\n      ")}${mismatches.length > 8 ? `\n      ...and ${mismatches.length - 8} more` : ""}`);
}

// Retail casual overtime isn't in the pay data; check against the official pay guide (Level 1, $27.81 base).
{
  const t = new Map(rateTable("MA000004", 2781).map((r) => [r.penalty_description, r.calculated_value]));
  const expected = {
    "Overtime - Monday to Saturday, first 3 hours": 48.67,
    "Overtime - Monday to Saturday, after 3 hours": 62.57,
    "Overtime - Sunday": 62.57,
    "Overtime - Public holiday": 76.48,
  };
  for (const [k, v] of Object.entries(expected)) check(`Retail L1 casual ${k} = ${v} (official pay guide)`, t.get(k) === v, `got ${t.get(k)}`);
}

// ---------- 2. worked shifts ----------
const hrs = (res, label) => (res.lines.find((l) => l.label === label) || { hours: 0 }).hours;
const FRI = 4;
const sh = (day, start, lengthHours, breakMins = 0) => ({ day, start, lengthHours, breakMins });

{ // Retail Fri 6pm, 8h, 30 min break. 3h penalty, then outside the 9pm span = overtime.
  const r = costShifts({ awardCode: "MA000004", baseCents: 2781, shifts: [sh(FRI, "18:00", 8, 30)] });
  check("Retail Fri 6pm 8h: 3h after-6pm penalty", hrs(r, "Monday to Friday after 6.00 pm") === 3);
  check("Retail Fri 6pm 8h: 3h overtime first 3 hours", hrs(r, "Overtime - Monday to Saturday, first 3 hours") === 3);
  check("Retail Fri 6pm 8h: 1.5h overtime after 3 hours", hrs(r, "Overtime - Monday to Saturday, after 3 hours") === 1.5);
  check("Retail Fri 6pm 8h: total 7.5h paid", r.shiftDetails[0].workedHours === 7.5);
}
{ // Retail as a shiftworker: flat 155% weekday, Saturday 175% after midnight.
  const r = costShifts({ awardCode: "MA000004", baseCents: 2781, shifts: [sh(FRI, "18:00", 8, 30)], options: { shiftworker: true } });
  check("Retail shiftworker Fri 6pm 8h: 6h weekday + 1.5h? (midnight splits)", hrs(r, "Shiftwork - Monday to Friday") === 5.5 && hrs(r, "Shiftwork - Saturday") === 2, JSON.stringify(r.lines.map((l) => [l.label, l.hours])));
}
{ // Retail min engagement
  const r = costShifts({ awardCode: "MA000004", baseCents: 2781, shifts: [sh(5, "10:00", 2)] });
  check("Retail 2h Saturday shift topped up to 3h", hrs(r, "Saturday") === 3 && r.warnings.some((w) => /minimum engagement/.test(w)));
}
{ // Hospitality Fri 6pm 10h: all ordinary for a casual (12h cap), Saturday after midnight.
  const r = costShifts({ awardCode: "MA000009", baseCents: 2644, shifts: [sh(FRI, "18:00", 10, 30)] });
  check("Hospitality Fri 6pm 10h: no overtime for a casual", r.lines.every((l) => !l.isOvertime));
  check("Hospitality Fri 6pm 10h: 5.5h Friday ordinary + 4h Saturday", hrs(r, "Ordinary hours") === 5.5 && hrs(r, "Saturday") === 4);
  const eve = r.addOns.find((a) => /7.00 pm/.test(a.allowance));
  check("Hospitality Fri 6pm 10h: 4.5h of 7pm-midnight add-on", eve && eve.quantity === 4.5 && eve.appliesToCategory === "Ordinary hours");
}
{ // Hospitality 13h shift: overtime after 12h; evening add-on excludes overtime hours.
  const r = costShifts({ awardCode: "MA000009", baseCents: 2644, shifts: [sh(0, "07:00", 13, 30)] });
  check("Hospitality Mon 13h: 12h ordinary then 0.5h overtime (first 2h)", hrs(r, "Ordinary hours") === 12 && hrs(r, "Overtime - Monday to Friday, first 2 hours") === 0.5);
  const eve = r.addOns.find((a) => /7.00 pm/.test(a.allowance));
  check("Hospitality Mon 13h: evening add-on only on ordinary hours (0.5h)", eve && eve.quantity === 0.5, JSON.stringify(r.addOns));
}
{ // Weekly trigger
  const r = costShifts({ awardCode: "MA000009", baseCents: 2644, shifts: [sh(0, "09:00", 5)], otherHours: 36 });
  check("Hospitality: 36h already worked -> 2h ordinary, 2h OT first tier, 1h OT after", hrs(r, "Ordinary hours") === 2 && hrs(r, "Overtime - Monday to Friday, first 2 hours") === 2 && hrs(r, "Overtime - Monday to Friday, after 2 hours") === 1);
}
{ // Public holiday
  const r = costShifts({ awardCode: "MA000009", baseCents: 2644, shifts: [sh(0, "10:00", 4)], publicHolidays: [0] });
  check("Hospitality public holiday Monday: 4h at public holiday rate", hrs(r, "Public holiday") === 4);
}
{ // Storage day worker, afternoon (daily cap 8h -> overtime), unclassifiable gap, weekend
  const day = costShifts({ awardCode: "MA000084", baseCents: 2400, shifts: [sh(0, "08:00", 8.5, 30)] });
  check("Storage day worker 8h: all ordinary", hrs(day, "Ordinary hours") === 8 && day.lines.length === 1);
  const aft = costShifts({ awardCode: "MA000084", baseCents: 2400, shifts: [sh(1, "15:00", 9, 0)] });
  check("Storage afternoon shift 9h: 8h afternoon + 1h overtime first 2h", hrs(aft, "Afternoon shift") === 8 && hrs(aft, "Overtime - first 2 hours") === 1);
  let threw = false;
  try {
    costShifts({ awardCode: "MA000084", baseCents: 2400, shifts: [sh(2, "10:00", 8, 30)] });
  } catch (e) {
    threw = /doesn't fit a Storage Services shift type/.test(e.message);
  }
  check("Storage shift finishing 6pm sharp (fits no category) is refused, not guessed", threw);
  const sat = costShifts({ awardCode: "MA000084", baseCents: 2400, shifts: [sh(5, "07:00", 5, 0)] });
  check("Storage Saturday shift needs no classification", hrs(sat, "Saturday") === 5);
}
{ // Overlap + rest gap warning
  let threw = false;
  try {
    costShifts({ awardCode: "MA000004", baseCents: 2781, shifts: [sh(0, "09:00", 8), sh(0, "15:00", 4)] });
  } catch (e) {
    threw = /overlap/.test(e.message);
  }
  check("Overlapping shifts are refused", threw);
  const r = costShifts({ awardCode: "MA000004", baseCents: 2781, shifts: [sh(0, "14:00", 8), sh(1, "07:00", 5)] });
  check("Retail <12h rest gap is flagged", r.warnings.some((w) => /12-hour break/.test(w)));
}

console.log(failures ? `\n${failures} FAILED` : "\nAll passed");
process.exit(failures ? 1 : 0);
