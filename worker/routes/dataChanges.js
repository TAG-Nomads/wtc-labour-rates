import { match } from "../router.js";
import { json, error } from "../http.js";
import { requireSession } from "./staff.js";
import { requireRole } from "../auth.js";
import { setSetting } from "../settings.js";

// What the Fair Work API has told us has changed since an owner/admin last marked the award data as refreshed.
export async function handleDataChanges(request, env, url) {
  const staff = await requireSession(request, env);
  if (!staff) return error("Not authenticated", 401);
  if (!requireRole({ id: staff.id, role: staff.role }, ["admin", "owner"])) return error("Forbidden", 403);

  if (match("/api/staff/data-changes", url.pathname) && request.method === "GET") {
    const ack = (await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'award_changes_ack_at'").first())?.value || "";
    const events = await env.DB.prepare(
      "SELECT kind, SUM(hits) AS hits, MIN(first_at) AS first_at, MAX(last_at) AS last_at FROM fwc_change_events WHERE last_at > ? GROUP BY kind ORDER BY last_at DESC"
    )
      .bind(ack)
      .all();
    const awards = await env.DB.prepare(
      `SELECT c.award_code, a.name, c.hits, c.last_at FROM fwc_change_awards c LEFT JOIN awards a ON a.award_code = c.award_code
       WHERE c.last_at > ? ORDER BY c.award_code`
    )
      .bind(ack)
      .all();
    return json({ pending: events.results.length > 0, since: ack || null, events: events.results, awards: awards.results });
  }

  if (match("/api/staff/data-changes/ack", url.pathname) && request.method === "POST") {
    await setSetting(env, "award_changes_ack_at", new Date().toISOString());
    return json({ ok: true });
  }

  return error("Not found", 404);
}
