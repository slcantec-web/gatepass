// worker/src/settings.js
// Backs the Super Admin "System Settings" screen (js/settings.js): whether
// pass-slip printing is offered, and what paper size it prints to. Stored as
// simple key/value rows in system_settings so new setting keys don't need a
// schema migration.
import { writeAudit } from "./audit.js";

const DEFAULT_SETTINGS = {
  print_enabled: "true",
  print_paper_size: "A4",
  print_custom_width_mm: "80",
  print_custom_height_mm: "150",
};

export async function getSettings(env) {
  const { results } = await env.DB.prepare(
    `SELECT setting_key, setting_value FROM system_settings`
  ).all();

  const settings = { ...DEFAULT_SETTINGS };
  for (const row of results) {
    settings[row.setting_key] = row.setting_value;
  }
  return settings;
}

export async function updateSettings(env, user, body, request) {
  const allowedKeys = Object.keys(DEFAULT_SETTINGS);

  for (const key of allowedKeys) {
    if (body[key] === undefined) continue;
    await env.DB.prepare(
      `INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)
       ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`
    ).bind(key, String(body[key])).run();
  }

  await writeAudit(env, {
    userId: user.userId,
    action: "ADMIN_UPDATED_SETTINGS",
    recordType: "system_settings",
    details: body,
    request,
  });

  return getSettings(env);
}
