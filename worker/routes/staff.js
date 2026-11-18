import { match } from "../router.js";
import { json, error } from "../http.js";
import {
  hashPassword,
  verifyPassword,
  makeCookie,
  clearCookie,
  readSession,
  requireRole,
  createInviteToken,
  hashInviteToken,
} from "../auth.js";
import { getSettings, setSetting } from "../settings.js";

function staffRow(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    mustChange: !!row.must_change,
    pendingInvite: !!row.invite_token_hash,
    active: !!row.active,
  };
}

export async function requireSession(request, env) {
  const session = await readSession(request, env);
  if (!session) return null;
  const row = await env.DB.prepare("SELECT * FROM staff_users WHERE id = ? AND active = 1").bind(session.id).first();
  if (!row) return null;
  return row;
}

export async function handleStaffAuth(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (match("/api/staff/login", pathname) && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const row = await env.DB.prepare("SELECT * FROM staff_users WHERE email = ?")
      .bind((body.email || "").trim().toLowerCase())
      .first();
    if (!row || !row.active || !(await verifyPassword(body.password || "", row))) {
      return error("Invalid email or password", 401);
    }
    const cookie = await makeCookie(env, { id: row.id, role: row.role, exp: Date.now() + 12 * 3600 * 1000 });
    return new Response(JSON.stringify(staffRow(row)), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": cookie },
    });
  }

  if (match("/api/staff/logout", pathname) && method === "POST") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": clearCookie() },
    });
  }

  // Account-setup invite link (unauthenticated -- the whole point is the new
  // person doesn't have a session or password yet).
  if (match("/api/staff/accept-invite", pathname) && method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!body.token || !body.password) return error("token and password required");
    if (body.password.length < 8) return error("Password must be at least 8 characters");
    const tokenHash = await hashInviteToken(body.token);
    const row = await env.DB.prepare(
      "SELECT * FROM staff_users WHERE invite_token_hash = ? AND invite_expires_at > datetime('now') AND active = 1"
    )
      .bind(tokenHash)
      .first();
    if (!row) return error("This setup link is invalid, expired, or the account isn't active -- ask an admin to send a new one", 404);
    const { salt, hash, iter } = await hashPassword(body.password);
    const updated = await env.DB.prepare(
      `UPDATE staff_users SET pw_salt=?, pw_hash=?, pw_iter=?, must_change=0, invite_token_hash=NULL, invite_expires_at=NULL
       WHERE id=? RETURNING *`
    )
      .bind(salt, hash, iter, row.id)
      .first();
    const cookie = await makeCookie(env, { id: updated.id, role: updated.role, exp: Date.now() + 12 * 3600 * 1000 });
    return new Response(JSON.stringify(staffRow(updated)), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": cookie },
    });
  }

  const staff = await requireSession(request, env);
  if (!staff) return error("Not authenticated", 401);
  const session = { id: staff.id, role: staff.role };

  if (match("/api/staff/me", pathname) && method === "GET") {
    return json(staffRow(staff));
  }

  if (match("/api/staff/password", pathname) && method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!body.password || body.password.length < 8) return error("Password must be at least 8 characters");
    // Changing your own password needs the current one, unless you're in the
    // forced first-login change (you've just signed in with the password you were given).
    if (!staff.must_change && !(await verifyPassword(body.currentPassword || "", staff))) {
      return error("Your current password isn't right", 400);
    }
    const { salt, hash, iter } = await hashPassword(body.password);
    await env.DB.prepare("UPDATE staff_users SET pw_salt=?, pw_hash=?, pw_iter=?, must_change=0 WHERE id=?")
      .bind(salt, hash, iter, staff.id)
      .run();
    return json({ ok: true });
  }

  // Only an owner may promote/demote to admin, or touch business settings.
  if (match("/api/staff/accounts", pathname) && method === "GET") {
    if (!requireRole(session, ["admin", "owner"])) return error("Forbidden", 403);
    const rows = await env.DB.prepare("SELECT * FROM staff_users ORDER BY name").all();
    return json(rows.results.map(staffRow));
  }
  if (match("/api/staff/accounts", pathname) && method === "POST") {
    if (!requireRole(session, ["admin", "owner"])) return error("Forbidden", 403);
    const body = await request.json().catch(() => ({}));
    if (!body.email || !body.name || !body.role) return error("email, name, role required");
    if (!["admin", "staff"].includes(body.role)) return error("role must be admin or staff");
    if (body.role === "admin" && session.role !== "owner") {
      return error("Only an owner can create admin accounts", 403);
    }
    // Optional: the admin sets the password directly instead of sending a setup link.
    if (body.password) {
      if (String(body.password).length < 8) return error("Password must be at least 8 characters");
      const pw = await hashPassword(body.password);
      const created = await env.DB.prepare(
        `INSERT INTO staff_users (email, name, role, pw_salt, pw_hash, pw_iter, must_change)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
      )
        .bind(body.email.trim().toLowerCase(), body.name, body.role, pw.salt, pw.hash, pw.iter, body.forceChange ? 1 : 0)
        .first();
      return json(staffRow(created), 201);
    }
    // Otherwise: placeholder password nobody knows -- login stays impossible until the invite link is used.
    const { salt, hash, iter } = await hashPassword(crypto.randomUUID());
    const { token, hash: inviteHash, expiresAt } = await createInviteToken();
    const row = await env.DB.prepare(
      `INSERT INTO staff_users (email, name, role, pw_salt, pw_hash, pw_iter, must_change, invite_token_hash, invite_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING *`
    )
      .bind(body.email.trim().toLowerCase(), body.name, body.role, salt, hash, iter, inviteHash, expiresAt)
      .first();
    const inviteLink = `${url.origin}/setup.html?token=${token}`;
    return json({ ...staffRow(row), inviteLink }, 201);
  }

  // Admin/owner sets (or resets) someone else's password directly. Same reach as
  // the other account actions: admins -> staff only, owner -> staff and admins,
  // nobody -> owners (they change their own via the current-password route).
  let m = match("/api/staff/accounts/:id/set-password", pathname);
  if (m && method === "POST") {
    if (!requireRole(session, ["admin", "owner"])) return error("Forbidden", 403);
    const target = await env.DB.prepare("SELECT * FROM staff_users WHERE id = ?").bind(m.id).first();
    if (!target) return error("Not found", 404);
    if (target.role === "owner") return error("Owner accounts can't be modified here", 403);
    if (target.id === session.id) return error("Change your own password with 'Change password' (it asks for your current one)", 400);
    if (session.role === "admin" && target.role !== "staff") {
      return error("Admins can only set passwords for staff-level accounts", 403);
    }
    const body = await request.json().catch(() => ({}));
    if (!body.password || String(body.password).length < 8) return error("Password must be at least 8 characters");
    const pw = await hashPassword(body.password);
    // Clears any pending setup link so the old link can't override the new password.
    const row = await env.DB.prepare(
      `UPDATE staff_users SET pw_salt=?, pw_hash=?, pw_iter=?, must_change=?, invite_token_hash=NULL, invite_expires_at=NULL
       WHERE id=? RETURNING *`
    )
      .bind(pw.salt, pw.hash, pw.iter, body.forceChange ? 1 : 0, m.id)
      .first();
    return json(staffRow(row));
  }

  m = match("/api/staff/accounts/:id/resend-invite", pathname);
  if (m && method === "POST") {
    if (!requireRole(session, ["admin", "owner"])) return error("Forbidden", 403);
    const target = await env.DB.prepare("SELECT * FROM staff_users WHERE id = ?").bind(m.id).first();
    if (!target) return error("Not found", 404);
    if (target.role === "owner") return error("Owner accounts can't be modified here", 403);
    if (session.role === "admin" && target.role !== "staff") {
      return error("Admins can only resend setup links for staff-level accounts", 403);
    }
    const { token, hash: inviteHash, expiresAt } = await createInviteToken();
    const row = await env.DB.prepare(
      "UPDATE staff_users SET invite_token_hash=?, invite_expires_at=?, must_change=1 WHERE id=? RETURNING *"
    )
      .bind(inviteHash, expiresAt, m.id)
      .first();
    const inviteLink = `${url.origin}/setup.html?token=${token}`;
    return json({ ...staffRow(row), inviteLink });
  }

  m = match("/api/staff/accounts/:id", pathname);
  if (m && method === "PATCH") {
    if (!requireRole(session, ["admin", "owner"])) return error("Forbidden", 403);
    const target = await env.DB.prepare("SELECT * FROM staff_users WHERE id = ?").bind(m.id).first();
    if (!target) return error("Not found", 404);
    if (target.role === "owner") return error("Owner accounts can't be modified here", 403);

    const body = await request.json().catch(() => ({}));
    if (body.role !== undefined) {
      if (session.role !== "owner") return error("Only an owner can change roles", 403);
      if (!["admin", "staff"].includes(body.role)) return error("role must be admin or staff");
    }
    if (body.active !== undefined) {
      if (target.id === session.id) return error("You can't deactivate your own account", 400);
      if (session.role === "admin" && target.role !== "staff") {
        return error("Admins can only deactivate/reactivate staff-level accounts", 403);
      }
    }

    const fields = [];
    const values = [];
    for (const [col, key] of [
      ["name", "name"],
      ["role", "role"],
      ["active", "active"],
    ]) {
      if (body[key] !== undefined) {
        fields.push(`${col} = ?`);
        values.push(key === "active" ? (body[key] ? 1 : 0) : body[key]);
      }
    }
    if (!fields.length) return error("Nothing to update");
    values.push(m.id);
    const row = await env.DB.prepare(`UPDATE staff_users SET ${fields.join(", ")} WHERE id = ? RETURNING *`)
      .bind(...values)
      .first();
    return json(staffRow(row));
  }

  if (match("/api/staff/settings", pathname) && method === "GET") {
    return json(await getSettings(env));
  }
  if (match("/api/staff/settings", pathname) && method === "POST") {
    if (!requireRole(session, ["owner"])) return error("Forbidden -- only an owner can change business settings", 403);
    const body = await request.json().catch(() => ({}));
    if (body.oncostFloorPct != null) {
      if (Number(body.oncostFloorPct) < 0) return error("On-cost floor % can't be negative");
      await setSetting(env, "oncost_floor_pct", Number(body.oncostFloorPct));
    }
    if (body.defaultMarginPct != null) {
      if (Number(body.defaultMarginPct) < 0) return error("Default margin % can't be negative");
      await setSetting(env, "default_margin_pct", Number(body.defaultMarginPct));
    }
    return json(await getSettings(env));
  }

  return error("Not found", 404);
}
