import { match } from "../router.js";
import { json, error } from "../http.js";

// Receiver for the Fair Work Modern Awards API change notifications (POST only, https only on their side).
// Unauthenticated by design -- the secret is the token in the path (FWC can't send a session cookie).
// It only ever writes a counter, so a leaked token can at worst cause a spurious "award data changed" banner.

function sameToken(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function handleFwcWebhook(request, env, url) {
  const m = match("/api/webhooks/fwc/:token", url.pathname);
  if (!m) return error("Not found", 404);
  if (!env.FWC_WEBHOOK_TOKEN) return error("Webhook receiver not configured", 503);
  if (!sameToken(m.token, env.FWC_WEBHOOK_TOKEN)) return error("Not found", 404);

  // Answer a validation GET/HEAD (some gateways probe a callback before activating it).
  if (request.method !== "POST") return json({ ok: true });

  const raw = (await request.text().catch(() => "")).slice(0, 65536);
  let kind = "unknown";
  try {
    const body = JSON.parse(raw);
    // When a subscription is created FWC verifies the callback: it POSTs {message_type:"HANDSHAKE",
    // webhook_fixed_id, correlation_id} and wants the same ids echoed back in the response.
    if (body.message_type === "HANDSHAKE") {
      return json({ correlation_id: body.correlation_id, webhook_fixed_id: body.webhook_fixed_id });
    }
    const k = (body.payload && (body.payload.hook_on || body.payload.hookOn)) || body.hook_on || body.hookOn || body.message_type || body.event || body.type;
    if (typeof k === "string" && k) kind = k.slice(0, 60);
  } catch {
    /* not JSON -- still counts as a change signal */
  }
  const codes = [...new Set(raw.match(/MA\d{6}/g) || [])].slice(0, 200);

  // Keep the non-standard headers with the sample: FWC hands us a per-subscription callback_secret
  // (FWC_CALLBACK_SECRETS) but the signature scheme isn't documented, so the first real delivery will show it.
  const hdrs = {};
  for (const [k, v] of request.headers) {
    if (/^(x-|webhook|signature|authorization|content-type)/i.test(k) || /sign|hmac|secret/i.test(k)) hdrs[k] = String(v).slice(0, 200);
  }
  const sample = JSON.stringify({ headers: hdrs, body: raw.slice(0, 3500) });

  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const stmts = [
    env.DB.prepare(
      `INSERT INTO fwc_change_events (day, kind, hits, first_at, last_at, sample) VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT(day, kind) DO UPDATE SET hits = hits + 1, last_at = excluded.last_at, sample = excluded.sample`
    ).bind(day, kind, now, now, sample),
    ...codes.map((c) =>
      env.DB.prepare(
        `INSERT INTO fwc_change_awards (award_code, hits, first_at, last_at) VALUES (?, 1, ?, ?)
         ON CONFLICT(award_code) DO UPDATE SET hits = hits + 1, last_at = excluded.last_at`
      ).bind(c, now, now)
    ),
  ];
  await env.DB.batch(stmts);
  return json({ ok: true });
}
