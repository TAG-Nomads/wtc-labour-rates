import { FALLBACK_ONCOST_FLOOR_PCT, FALLBACK_DEFAULT_MARGIN_PCT } from "./calc.js";

export async function getSettings(env) {
  const rows = await env.DB.prepare("SELECT key, value FROM app_settings").all();
  const map = new Map(rows.results.map((r) => [r.key, r.value]));
  return {
    oncostFloorPct: Number(map.get("oncost_floor_pct") ?? FALLBACK_ONCOST_FLOOR_PCT),
    defaultMarginPct: Number(map.get("default_margin_pct") ?? FALLBACK_DEFAULT_MARGIN_PCT),
  };
}

export async function setSetting(env, key, value) {
  await env.DB.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(key, String(value))
    .run();
}
