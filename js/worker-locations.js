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

// "Delete" a location without breaking referential integrity: locations are
// referenced by gate_passes.from_location_id, pass_routes, and movement_events
// (with PRAGMA foreign_keys = ON, a real DELETE would fail anyway once any of
// those exist, and would destroy history for completed passes even when it
// didn't). So this is a soft delete - status flips to INACTIVE, which hides
// it from pickers on the frontend, and can be reversed with status=ACTIVE.
export async function setLocationStatus(env, user, locationId, status, request) {
  if (!["ACTIVE", "INACTIVE"].includes(status)) {
    const err = new Error("status must be ACTIVE or INACTIVE");
    err.status = 400;
    throw err;
  }

  const location = await env.DB.prepare(
    `SELECT location_id, location_name, status FROM locations WHERE location_id = ?`
  ).bind(locationId).first();
  if (!location) {
    const err = new Error("Location not found");
    err.status = 404;
    throw err;
  }

  if (status === "INACTIVE") {
    // Don't let a location disappear out from under a pass that's still in flight.
    const blocking = await env.DB.prepare(
      `SELECT gp.pass_number FROM gate_passes gp
       WHERE gp.status IN ('PENDING', 'APPROVED', 'IN_PROGRESS')
         AND (gp.from_location_id = ? OR EXISTS (
           SELECT 1 FROM pass_routes pr WHERE pr.pass_id = gp.pass_id AND pr.location_id = ?
         ))
       LIMIT 1`
    ).bind(locationId, locationId).first();
    if (blocking) {
      const err = new Error(`Cannot delete: location is used by active gate pass ${blocking.pass_number}`);
      err.status = 409;
      throw err;
    }
  }

  await env.DB.prepare(`UPDATE locations SET status = ? WHERE location_id = ?`).bind(status, locationId).run();

  await writeAudit(env, {
    userId: user.userId,
    action: status === "ACTIVE" ? "ADMIN_RESTORED_LOCATION" : "ADMIN_DELETED_LOCATION",
    recordType: "location",
    recordId: locationId,
    details: { location_name: location.location_name },
    request,
  });

  return { location_id: Number(locationId), status };
}

// Assigns a fresh qr_code_token to a location - either because it never had
// one (e.g. it was created before QR support existed and the column was
// added later via ALTER TABLE, so it's stuck NULL) or because you want to
// invalidate the old printed/displayed code and issue a new one.
export async function regenerateLocationQr(env, user, locationId, request) {
  const location = await env.DB.prepare(
    `SELECT location_id, location_name FROM locations WHERE location_id = ?`
  ).bind(locationId).first();
  if (!location) {
    const err = new Error("Location not found");
    err.status = 404;
    throw err;
  }

  // qr_code_token is UNIQUE - collision odds are astronomically low with 12
  // random bytes, but loop a few times rather than trust that blindly.
  let token;
  for (let attempt = 0; attempt < 5; attempt++) {
    token = randomToken(12);
    const clash = await env.DB.prepare(`SELECT location_id FROM locations WHERE qr_code_token = ?`).bind(token).first();
    if (!clash) break;
  }

  await env.DB.prepare(`UPDATE locations SET qr_code_token = ? WHERE location_id = ?`).bind(token, locationId).run();

  await writeAudit(env, {
    userId: user.userId,
    action: "ADMIN_REGENERATED_LOCATION_QR",
    recordType: "location",
    recordId: locationId,
    details: { location_name: location.location_name },
    request,
  });

  return { location_id: Number(locationId), qr_code_token: token };
}
