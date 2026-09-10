// worker/src/locations.js
import { randomToken } from "./auth.js";
import { writeAudit } from "./audit.js";

const VALID_TYPES = [
  "HEAD_OFFICE", "FACTORY", "WAREHOUSE", "BRANCH", "INTERNAL",
  "CUSTOMER", "SUPPLIER", "EXTERNAL", "OTHER",
];

export async function listLocations(env) {
  const { results } = await env.DB.prepare(
    `SELECT location_id, location_code, location_name, location_type, address, latitude, longitude, status, qr_code_token
     FROM locations ORDER BY location_name`
  ).all();
  return results;
}

export async function getLocationByQrToken(env, token) {
  return env.DB.prepare(
    `SELECT location_id, location_code, location_name, location_type FROM locations WHERE qr_code_token = ? AND status = 'ACTIVE'`
  ).bind(token).first();
}

export async function createLocation(env, user, body, request) {
  const { location_code, location_name, location_type, address, latitude, longitude, geofence_radius, company_id } = body;
  if (!location_code || !location_name || !location_type) {
    const err = new Error("location_code, location_name and location_type are required");
    err.status = 400;
    throw err;
  }
  if (!VALID_TYPES.includes(location_type)) {
    const err = new Error(`location_type must be one of: ${VALID_TYPES.join(", ")}`);
    err.status = 400;
    throw err;
  }

  const existing = await env.DB.prepare(`SELECT location_id FROM locations WHERE location_code = ?`)
    .bind(location_code).first();
  if (existing) {
    const err = new Error(`${location_code} already exists`);
    err.status = 409;
    throw err;
  }

  const qrToken = randomToken(12);
  const result = await env.DB.prepare(
    `INSERT INTO locations (location_code, location_name, company_id, location_type, address, latitude, longitude, geofence_radius, qr_code_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(location_code, location_name, company_id ?? null, location_type, address ?? null, latitude ?? null, longitude ?? null, geofence_radius ?? null, qrToken).run();

  await writeAudit(env, {
    userId: user.userId,
    action: "ADMIN_CREATED_LOCATION",
    recordType: "location",
    recordId: result.meta.last_row_id,
    details: { location_code, location_name },
    request,
  });

  return { location_id: result.meta.last_row_id, qr_code_token: qrToken };
}
