// worker/src/audit.js
export async function writeAudit(env, { userId, action, recordType, recordId, details, request }) {
  const ip = request?.headers.get("CF-Connecting-IP") || "";
  const device = request?.headers.get("User-Agent") || "";
  await env.DB.prepare(
    `INSERT INTO audit_log (user_id, action, record_type, record_id, details, ip_address, device_info)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    userId ?? null,
    action,
    recordType ?? null,
    recordId != null ? String(recordId) : null,
    details ? JSON.stringify(details) : null,
    ip,
    device
  ).run();
}
