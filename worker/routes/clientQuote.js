import { match } from "../router.js";
import { json, error } from "../http.js";
import { quoteRow } from "./quotes.js";

// Public (no login) endpoints behind a quote's share link. The link token is the only credential, so what comes
// back is deliberately client-safe: our charge rates only -- no award rates, on-costs, margin, split, warnings or notes.

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Fingerprint of what the client was shown and agreed to.
export const quoteFingerprint = (row) =>
  sha256Hex(
    JSON.stringify([row.id, row.client_name, row.roster_json, row.allowances_json, row.shifts_json, row.min_engagement_hours, row.daily_ot_hours, row.shift_length_note])
  );

function clientSafe(row) {
  const q = quoteRow(row);
  const day = (d) => ({ dayName: d.dayName, start: d.start, finish: d.finish, breakMins: d.breakMins, workedHours: d.workedHours });
  let shifts = null;
  if (q.shifts) {
    shifts = { publicHolidays: q.shifts.publicHolidays || [] };
    if (Array.isArray(q.shifts.staff)) {
      shifts.staff = q.shifts.staff.map((g) => ({ name: g.name, count: g.count, shifts: (g.shifts || []).map(day) }));
    } else if (Array.isArray(q.shifts.shifts)) {
      shifts.shifts = q.shifts.shifts.map(day);
    }
  }
  return {
    id: q.id,
    created_at: q.created_at,
    client_name: q.client_name,
    role_title: q.role_title,
    classification_name: q.classification_name,
    is_casual: q.is_casual,
    staff_name: q.staff_name,
    roster: q.roster.map((l) => ({
      penaltyDescription: l.penaltyDescription,
      hours: l.hours,
      isOvertime: l.isOvertime,
      chargeRate: l.chargeRate,
      chargeLineTotal: l.chargeLineTotal,
    })),
    allowances: (q.allowances || []).map((l) => ({
      allowance: l.allowance,
      quantity: l.quantity,
      chargeRate: l.chargeRate,
      chargeLineTotal: l.chargeLineTotal,
    })),
    shifts,
    min_engagement_hours: q.min_engagement_hours,
    daily_ot_hours: q.daily_ot_hours,
    shift_length_note: q.shift_length_note,
    accepted_at: q.accepted_at,
    accepted_name: q.accepted_name,
  };
}

const findByToken = (env, token) =>
  env.DB.prepare(
    "SELECT q.*, s.name AS staff_name FROM quotes q JOIN staff_users s ON s.id = q.staff_id WHERE q.share_token = ?"
  )
    .bind(token)
    .first();

export async function handleClientQuote(request, env, url) {
  let m = match("/api/client-quote/:token", url.pathname);
  if (m && request.method === "GET") {
    const row = m.token.length >= 20 ? await findByToken(env, m.token) : null;
    if (!row) return error("This link isn't valid. Ask your Work + Travel Co. contact for a new one.", 404);
    return json(clientSafe(row));
  }

  m = match("/api/client-quote/:token/accept", url.pathname);
  if (m && request.method === "POST") {
    const row = m.token.length >= 20 ? await findByToken(env, m.token) : null;
    if (!row) return error("This link isn't valid. Ask your Work + Travel Co. contact for a new one.", 404);
    if (row.accepted_at) return error("This quote has already been accepted.", 409);
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "").trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 100) return error("Enter your full name to accept.");
    if (body.agree !== true) return error("Tick the box to confirm you're authorised to accept this quote.");
    const now = new Date().toISOString();
    const res = await env.DB.prepare(
      `UPDATE quotes SET accepted_at = ?, accepted_name = ?, accepted_ip = ?, accepted_ua = ?, accepted_hash = ?
       WHERE id = ? AND accepted_at IS NULL`
    )
      .bind(
        now,
        name,
        request.headers.get("CF-Connecting-IP") || null,
        (request.headers.get("User-Agent") || "").slice(0, 300),
        await quoteFingerprint(row),
        row.id
      )
      .run();
    if (!res.meta.changes) return error("This quote has already been accepted.", 409);
    return json({ ok: true, accepted_at: now, accepted_name: name });
  }

  return error("Not found", 404);
}
