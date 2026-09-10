/* ============================================================
   Gate Pass & Employee Movement Management System - Worker
   Bundled single-file version (all modules merged) for pasting
   into the Cloudflare dashboard's single-file Quick Edit view.
   Generated from worker/src/*.js - do not maintain this file by
   hand, regenerate it from the separate module files instead.
   ============================================================ */

/* ---- from auth.js ---- */
// worker/src/auth.js
// Password hashing (PBKDF2-SHA256) and session management using Web Crypto,
// which is available natively in the Workers runtime (no dependencies needed).

const PBKDF2_ITERATIONS = 100000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return `${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(derived)}`;
}

async function verifyPassword(password, stored) {
  const [iterStr, saltHex, hashHex] = stored.split("$");
  const iterations = parseInt(iterStr, 10);
  const salt = fromHex(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return toHex(derived) === hashHex;
}

function randomToken(bytes = 32) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx > -1) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  });
  return out;
}

function sessionCookie(token, maxAgeSeconds) {
  // Secure + HttpOnly + SameSite=None: frontend (Pages) and API (Workers) live on
  // different domains, so this cookie must be sent cross-site - SameSite=None is
  // required for that (Strict\/Lax cookies are withheld on cross-site requests).
  return `session=${token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookie() {
  return `session=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
}

async function createSession(env, userId, request) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ua = request.headers.get("User-Agent") || "";
  await env.DB.prepare(
    `INSERT INTO sessions (session_token, user_id, expires_at, ip_address, device_info) VALUES (?, ?, ?, ?, ?)`
  ).bind(token, userId, expiresAt, ip, ua).run();
  return { token, expiresAt };
}

// Resolves the current user from the session cookie, or null.
async function getCurrentUser(env, request) {
  const cookies = parseCookies(request);
  const token = cookies["session"];
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT s.session_token, s.expires_at, u.user_id, u.username, u.role, u.employee_id, u.status
     FROM sessions s JOIN users u ON u.user_id = s.user_id
     WHERE s.session_token = ?`
  ).bind(token).first();

  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await env.DB.prepare(`DELETE FROM sessions WHERE session_token = ?`).bind(token).run();
    return null;
  }
  if (row.status !== "ACTIVE") return null;

  return {
    userId: row.user_id,
    username: row.username,
    role: row.role,
    employeeId: row.employee_id,
    sessionToken: row.session_token,
  };
}

// Simple RBAC guard: throws a Response-like error object the router can catch.
function requireRole(user, allowedRoles) {
  if (!user) {
    const err = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }
  if (!allowedRoles.includes(user.role)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
}


/* ---- from audit.js ---- */
// worker/src/audit.js
async function writeAudit(env, { userId, action, recordType, recordId, details, request }) {
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


/* ---- from employees.js ---- */
// worker/src/employees.js

async function listEmployees(env) {
  const { results } = await env.DB.prepare(
    `SELECT employee_id, emp_code, full_name, department_id, hod_employee_id, designation, phone, email, status, badge_qr_token
     FROM employees ORDER BY full_name`
  ).all();
  return results;
}

async function createEmployee(env, user, body, request) {
  const { emp_code, full_name, department_id, hod_employee_id, designation, phone, email } = body;
  if (!emp_code || !full_name) {
    const err = new Error("emp_code and full_name are required");
    err.status = 400;
    throw err;
  }

  const existing = await env.DB.prepare(`SELECT employee_id FROM employees WHERE emp_code = ?`)
    .bind(emp_code).first();
  if (existing) {
    const err = new Error(`${emp_code} already exists`);
    err.status = 409;
    throw err;
  }

  const badgeToken = randomToken(12);
  const result = await env.DB.prepare(
    `INSERT INTO employees (emp_code, full_name, department_id, hod_employee_id, designation, phone, email, badge_qr_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(emp_code, full_name, department_id ?? null, hod_employee_id ?? null, designation ?? null, phone ?? null, email ?? null, badgeToken).run();

  await writeAudit(env, {
    userId: user.userId,
    action: "ADMIN_CREATED_EMPLOYEE",
    recordType: "employee",
    recordId: result.meta.last_row_id,
    details: { emp_code, full_name },
    request,
  });

  return { employee_id: result.meta.last_row_id, badge_qr_token: badgeToken };
}

// Bulk import: expects an array of row objects already parsed client-side from CSV/XLSX.
// Duplicate emp_code -> rejected per-row, never silently skipped/overwritten (spec section 20).
async function importEmployees(env, user, rows, request) {
  const results = { imported: 0, errors: [] };

  for (const [i, row] of rows.entries()) {
    const emp_code = (row.emp_code || "").trim();
    const full_name = (row.full_name || "").trim();
    if (!emp_code || !full_name) {
      results.errors.push({ row: i + 1, error: "Missing emp_code or full_name" });
      continue;
    }
    const existing = await env.DB.prepare(`SELECT employee_id FROM employees WHERE emp_code = ?`)
      .bind(emp_code).first();
    if (existing) {
      results.errors.push({ row: i + 1, emp_code, error: `${emp_code} already exists` });
      continue;
    }
    const badgeToken = randomToken(12);
    await env.DB.prepare(
      `INSERT INTO employees (emp_code, full_name, department_id, designation, phone, email, badge_qr_token)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(emp_code, full_name, row.department_id ?? null, row.designation ?? null, row.phone ?? null, row.email ?? null, badgeToken).run();
    results.imported++;
  }

  await writeAudit(env, {
    userId: user.userId,
    action: "ADMIN_IMPORTED_EMPLOYEES",
    recordType: "employee",
    details: { imported: results.imported, errorCount: results.errors.length },
    request,
  });

  return results;
}

async function getEmployeeByBadgeToken(env, token) {
  return env.DB.prepare(
    `SELECT employee_id, emp_code, full_name, status FROM employees WHERE badge_qr_token = ? AND status = 'ACTIVE'`
  ).bind(token).first();
}


/* ---- from locations.js ---- */
// worker/src/locations.js

const VALID_TYPES = [
  "HEAD_OFFICE", "FACTORY", "WAREHOUSE", "BRANCH", "INTERNAL",
  "CUSTOMER", "SUPPLIER", "EXTERNAL", "OTHER",
];

async function listLocations(env) {
  const { results } = await env.DB.prepare(
    `SELECT location_id, location_code, location_name, location_type, address, latitude, longitude, status, qr_code_token
     FROM locations ORDER BY location_name`
  ).all();
  return results;
}

async function getLocationByQrToken(env, token) {
  return env.DB.prepare(
    `SELECT location_id, location_code, location_name, location_type FROM locations WHERE qr_code_token = ? AND status = 'ACTIVE'`
  ).bind(token).first();
}

async function createLocation(env, user, body, request) {
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


/* ---- from gatepasses.js ---- */
// worker/src/gatepasses.js

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

async function nextPassNumber(env) {
  const stamp = todayStamp();
  const prefix = `MP-${stamp}-`;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM gate_passes WHERE pass_number LIKE ?`
  ).bind(`${prefix}%`).first();
  const seq = String((row?.c ?? 0) + 1).padStart(4, "0");
  return `${prefix}${seq}`;
}

// body: { leader_employee_id, from_location_id, purpose, expected_departure, expected_return,
//         member_employee_ids: [...], route_location_ids: [...] }
async function createGatePass(env, user, body, request) {
  const {
    leader_employee_id, from_location_id, purpose,
    expected_departure, expected_return,
    member_employee_ids = [], route_location_ids = [],
  } = body;

  if (!leader_employee_id || !from_location_id || !purpose) {
    const err = new Error("leader_employee_id, from_location_id and purpose are required");
    err.status = 400;
    throw err;
  }

  // Leader is always a member too.
  const allMembers = Array.from(new Set([leader_employee_id, ...member_employee_ids]));
  const passNumber = await nextPassNumber(env);
  const qrToken = randomToken(16);
  const passType = allMembers.length > 1 ? "GROUP" : "SINGLE";

  const passResult = await env.DB.prepare(
    `INSERT INTO gate_passes (pass_number, leader_employee_id, from_location_id, purpose, expected_departure, expected_return, pass_type, status, qr_code_token, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`
  ).bind(passNumber, leader_employee_id, from_location_id, purpose, expected_departure ?? null, expected_return ?? null, passType, qrToken, user.userId).run();

  const passId = passResult.meta.last_row_id;

  for (const empId of allMembers) {
    await env.DB.prepare(
      `INSERT INTO pass_members (pass_id, employee_id, member_status) VALUES (?, ?, 'PENDING')`
    ).bind(passId, empId).run();
  }

  for (const [i, locId] of route_location_ids.entries()) {
    await env.DB.prepare(
      `INSERT INTO pass_routes (pass_id, sequence_no, location_id) VALUES (?, ?, ?)`
    ).bind(passId, i + 1, locId).run();
  }

  await writeAudit(env, {
    userId: user.userId,
    action: "EMPLOYEE_CREATED_PASS",
    recordType: "gate_pass",
    recordId: passId,
    details: { pass_number: passNumber, member_count: allMembers.length },
    request,
  });

  return { pass_id: passId, pass_number: passNumber, qr_code_token: qrToken };
}

async function getPassByQrToken(env, token) {
  const pass = await env.DB.prepare(
    `SELECT pass_id, pass_number, purpose, status FROM gate_passes WHERE qr_code_token = ?`
  ).bind(token).first();
  if (!pass) return null;

  const { results: members } = await env.DB.prepare(
    `SELECT pm.employee_id, e.emp_code, e.full_name, pm.member_status
     FROM pass_members pm JOIN employees e ON e.employee_id = pm.employee_id
     WHERE pm.pass_id = ?`
  ).bind(pass.pass_id).all();

  return { ...pass, members };
}

async function listGatePasses(env, user) {
  // Employees see only their own passes (as leader or member); HOD/Admin/Management see all.
  if (["EMPLOYEE"].includes(user.role)) {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT gp.pass_id, gp.pass_number, gp.purpose, gp.status, gp.created_at
       FROM gate_passes gp
       LEFT JOIN pass_members pm ON pm.pass_id = gp.pass_id
       WHERE gp.leader_employee_id = ? OR pm.employee_id = ?
       ORDER BY gp.created_at DESC`
    ).bind(user.employeeId, user.employeeId).all();
    return results;
  }

  const { results } = await env.DB.prepare(
    `SELECT pass_id, pass_number, purpose, status, created_at FROM gate_passes ORDER BY created_at DESC LIMIT 200`
  ).all();
  return results;
}

async function getGatePassDetails(env, passId) {
  const pass = await env.DB.prepare(`SELECT * FROM gate_passes WHERE pass_id = ?`).bind(passId).first();
  if (!pass) {
    const err = new Error("Pass not found");
    err.status = 404;
    throw err;
  }

  const { results: members } = await env.DB.prepare(
    `SELECT pm.pass_member_id, pm.employee_id, e.full_name, e.emp_code, pm.member_status
     FROM pass_members pm JOIN employees e ON e.employee_id = pm.employee_id
     WHERE pm.pass_id = ?`
  ).bind(passId).all();

  const { results: route } = await env.DB.prepare(
    `SELECT pr.sequence_no, pr.location_id, l.location_name, l.location_type
     FROM pass_routes pr JOIN locations l ON l.location_id = pr.location_id
     WHERE pr.pass_id = ? ORDER BY pr.sequence_no`
  ).bind(passId).all();

  const { results: events } = await env.DB.prepare(
    `SELECT me.event_id, me.employee_id, e.full_name, me.location_id, l.location_name, me.event_type, me.event_time
     FROM movement_events me
     JOIN employees e ON e.employee_id = me.employee_id
     LEFT JOIN locations l ON l.location_id = me.location_id
     WHERE me.pass_id = ? ORDER BY me.event_time`
  ).bind(passId).all();

  return { pass, members, route, events };
}


/* ---- from approvals.js ---- */
// worker/src/approvals.js

async function decidePass(env, user, passId, decision, comments, request) {
  if (!["APPROVED", "REJECTED"].includes(decision)) {
    const err = new Error("decision must be APPROVED or REJECTED");
    err.status = 400;
    throw err;
  }

  const pass = await env.DB.prepare(`SELECT * FROM gate_passes WHERE pass_id = ?`).bind(passId).first();
  if (!pass) {
    const err = new Error("Pass not found");
    err.status = 404;
    throw err;
  }
  if (pass.status !== "PENDING") {
    const err = new Error(`Pass is already ${pass.status}`);
    err.status = 409;
    throw err;
  }

  await env.DB.prepare(
    `INSERT INTO approvals (pass_id, approver_id, decision, comments) VALUES (?, ?, ?, ?)`
  ).bind(passId, user.userId, decision, comments ?? null).run();

  const newStatus = decision === "APPROVED" ? "APPROVED" : "REJECTED";
  await env.DB.prepare(
    `UPDATE gate_passes SET status = ?, updated_at = datetime('now') WHERE pass_id = ?`
  ).bind(newStatus, passId).run();

  await writeAudit(env, {
    userId: user.userId,
    action: decision === "APPROVED" ? "HOD_APPROVED_PASS" : "HOD_REJECTED_PASS",
    recordType: "gate_pass",
    recordId: passId,
    details: { comments },
    request,
  });

  return { pass_id: passId, status: newStatus };
}

async function listPendingApprovals(env) {
  const { results } = await env.DB.prepare(
    `SELECT gp.pass_id, gp.pass_number, gp.purpose, gp.created_at, e.full_name AS leader_name
     FROM gate_passes gp JOIN employees e ON e.employee_id = gp.leader_employee_id
     WHERE gp.status = 'PENDING' ORDER BY gp.created_at`
  ).all();
  return results;
}


/* ---- from movements.js ---- */
// worker/src/movements.js
// Implements the validation chain from spec section 26 and the atomic
// transaction pattern from section 18. D1 doesn't expose multi-statement
// interactive transactions over HTTP the way a normal SQL client would,
// but env.DB.batch() runs the statements atomically as a single unit,
// which is what we use for the "create event + update state + audit" step.

const EVENT_TYPES = [
  "GATE_OUT", "LOCATION_IN", "LOCATION_OUT", "EXTERNAL_IN", "EXTERNAL_OUT", "RETURN", "GATE_IN", "CANCELLED",
];

// Maps an event type to the pass_member status it produces.
function memberStatusFor(eventType) {
  switch (eventType) {
    case "GATE_OUT": return "OUTSIDE";
    case "LOCATION_IN": return "AT_INTERNAL_LOCATION";
    case "LOCATION_OUT": return "OUTSIDE";
    case "EXTERNAL_IN": return "AT_EXTERNAL_LOCATION";
    case "EXTERNAL_OUT": return "OUTSIDE";
    case "RETURN": return "OUTSIDE"; // returned to a company location, but pass not yet closed until GATE_IN
    case "GATE_IN": return "RETURNED";
    case "CANCELLED": return "CANCELLED";
    default: return null;
  }
}

// body: { pass_id, employee_id, location_id, event_type, idempotency_key }
async function recordMovementEvent(env, user, body, request) {
  const { pass_id, employee_id, location_id, event_type, idempotency_key } = body;

  // --- Validation chain (spec section 26) ---
  if (!pass_id || !employee_id || !event_type) {
    const err = new Error("pass_id, employee_id and event_type are required");
    err.status = 400;
    throw err;
  }
  if (!EVENT_TYPES.includes(event_type)) {
    const err = new Error(`event_type must be one of: ${EVENT_TYPES.join(", ")}`);
    err.status = 400;
    throw err;
  }
  if (!idempotency_key) {
    const err = new Error("idempotency_key is required to make this request safely retryable");
    err.status = 400;
    throw err;
  }

  // SECURITY role: gate events only. EMPLOYEE role: location/external/return events for themselves.
  const gateEvents = ["GATE_OUT", "GATE_IN"];
  if (gateEvents.includes(event_type) && !["SECURITY", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
    const err = new Error("Only Security can record gate in/out events");
    err.status = 403;
    throw err;
  }
  if (!gateEvents.includes(event_type) && user.role === "EMPLOYEE" && user.employeeId !== employee_id) {
    const err = new Error("Employees can only record their own movement events");
    err.status = 403;
    throw err;
  }

  const pass = await env.DB.prepare(`SELECT * FROM gate_passes WHERE pass_id = ?`).bind(pass_id).first();
  if (!pass) {
    const err = new Error("Pass not found");
    err.status = 404;
    throw err;
  }
  if (pass.status !== "APPROVED" && pass.status !== "IN_PROGRESS") {
    const err = new Error(`Pass is not approved (status: ${pass.status})`);
    err.status = 409;
    throw err;
  }

  const member = await env.DB.prepare(
    `SELECT * FROM pass_members WHERE pass_id = ? AND employee_id = ?`
  ).bind(pass_id, employee_id).first();
  if (!member) {
    const err = new Error("Employee does not belong to this pass");
    err.status = 403;
    throw err;
  }
  if (member.member_status === "RETURNED" || member.member_status === "CANCELLED") {
    const err = new Error(`Employee movement already closed (${member.member_status})`);
    err.status = 409;
    throw err;
  }

  // Duplicate check (level 2 - Worker API). Level 3 (DB UNIQUE constraint) is the real backstop.
  const dup = await env.DB.prepare(
    `SELECT event_id FROM movement_events WHERE pass_id = ? AND employee_id = ? AND event_type = ? AND idempotency_key = ?`
  ).bind(pass_id, employee_id, event_type, idempotency_key).first();
  if (dup) {
    // Already processed - return success idempotently rather than erroring.
    return { event_id: dup.event_id, duplicate: true };
  }

  const newMemberStatus = memberStatusFor(event_type);

  // Atomic batch: insert event + update member status + flip pass to IN_PROGRESS on first GATE_OUT.
  const stmts = [
    env.DB.prepare(
      `INSERT INTO movement_events (pass_id, employee_id, location_id, event_type, recorded_by, device_info, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(pass_id, employee_id, location_id ?? null, event_type, user.userId, request.headers.get("User-Agent") || "", idempotency_key),
    env.DB.prepare(
      `UPDATE pass_members SET member_status = ? WHERE pass_id = ? AND employee_id = ?`
    ).bind(newMemberStatus, pass_id, employee_id),
  ];

  if (event_type === "GATE_OUT" && pass.status === "APPROVED") {
    stmts.push(
      env.DB.prepare(`UPDATE gate_passes SET status = 'IN_PROGRESS', updated_at = datetime('now') WHERE pass_id = ?`).bind(pass_id)
    );
  }

  const batchResults = await env.DB.batch(stmts);
  const eventId = batchResults[0]?.meta?.last_row_id;

  await writeAudit(env, {
    userId: user.userId,
    action: `MOVEMENT_${event_type}`,
    recordType: "movement_event",
    recordId: eventId,
    details: { pass_id, employee_id, location_id },
    request,
  });

  // If this was a GATE_IN, check whether the whole pass can now be completed
  // (spec section 5: must NOT close until every member has returned).
  if (event_type === "GATE_IN") {
    await maybeCompletePass(env, pass_id, user, request);
  }

  return { event_id: eventId, member_status: newMemberStatus };
}

async function maybeCompletePass(env, passId, user, request) {
  const { results } = await env.DB.prepare(
    `SELECT member_status FROM pass_members WHERE pass_id = ?`
  ).bind(passId).all();

  const allResolved = results.every((m) => m.member_status === "RETURNED" || m.member_status === "CANCELLED");
  if (allResolved) {
    await env.DB.prepare(
      `UPDATE gate_passes SET status = 'COMPLETED', updated_at = datetime('now') WHERE pass_id = ?`
    ).bind(passId).run();
    await writeAudit(env, {
      userId: user.userId,
      action: "PASS_COMPLETED",
      recordType: "gate_pass",
      recordId: passId,
      request,
    });
  }
}

// Live status dashboard (spec section 11): calculated from each employee's
// latest movement event across all currently-active (non-completed) passes.
async function getLiveStatus(env) {
  const { results } = await env.DB.prepare(`
    SELECT e.employee_id, e.full_name, pm.member_status, gp.pass_number, gp.expected_return
    FROM pass_members pm
    JOIN employees e ON e.employee_id = pm.employee_id
    JOIN gate_passes gp ON gp.pass_id = pm.pass_id
    WHERE gp.status IN ('APPROVED', 'IN_PROGRESS')
      AND pm.member_status NOT IN ('RETURNED', 'CANCELLED')
  `).all();

  const now = Date.now();
  const outside = [];
  let overdueCount = 0;

  for (const row of results) {
    const overdue = row.expected_return && new Date(row.expected_return).getTime() < now;
    if (overdue) overdueCount++;
    outside.push({ ...row, overdue });
  }

  const totalEmployees = await env.DB.prepare(`SELECT COUNT(*) AS c FROM employees WHERE status = 'ACTIVE'`).first();

  return {
    inside: (totalEmployees?.c ?? 0) - outside.length,
    outside: outside.filter((o) => o.member_status === "OUTSIDE").length,
    at_internal_location: outside.filter((o) => o.member_status === "AT_INTERNAL_LOCATION").length,
    at_external_location: outside.filter((o) => o.member_status === "AT_EXTERNAL_LOCATION").length,
    overdue: overdueCount,
    details: outside,
  };
}


/* ---- from users.js ---- */
// worker/src/users.js

const VALID_ROLES = ["SUPER_ADMIN", "ADMIN", "HOD", "EMPLOYEE", "SECURITY", "MANAGEMENT_VIEWER"];

async function listUsers(env) {
  const { results } = await env.DB.prepare(
    `SELECT u.user_id, u.username, u.role, u.status, u.employee_id, e.full_name AS employee_name, u.last_login_at, u.created_at
     FROM users u LEFT JOIN employees e ON e.employee_id = u.employee_id
     ORDER BY u.username`
  ).all();
  return results;
}

async function createUser(env, actingUser, body, request) {
  const { username, password, role, employee_id } = body;
  if (!username || !password || !role) {
    const err = new Error("username, password and role are required");
    err.status = 400;
    throw err;
  }
  if (!VALID_ROLES.includes(role)) {
    const err = new Error(`role must be one of: ${VALID_ROLES.join(", ")}`);
    err.status = 400;
    throw err;
  }
  if (password.length < 8) {
    const err = new Error("Password must be at least 8 characters");
    err.status = 400;
    throw err;
  }

  const existing = await env.DB.prepare(`SELECT user_id FROM users WHERE username = ?`).bind(username).first();
  if (existing) {
    const err = new Error(`Username '${username}' already exists`);
    err.status = 409;
    throw err;
  }

  // Only a SUPER_ADMIN can create another SUPER_ADMIN.
  if (role === "SUPER_ADMIN" && actingUser.role !== "SUPER_ADMIN") {
    const err = new Error("Only a Super Admin can create another Super Admin");
    err.status = 403;
    throw err;
  }

  const passwordHash = await hashPassword(password);
  const result = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, role, employee_id) VALUES (?, ?, ?, ?)`
  ).bind(username, passwordHash, role, employee_id ?? null).run();

  await writeAudit(env, {
    userId: actingUser.userId,
    action: "ADMIN_CREATED_USER",
    recordType: "user",
    recordId: result.meta.last_row_id,
    details: { username, role },
    request,
  });

  return { user_id: result.meta.last_row_id };
}

async function setUserStatus(env, actingUser, userId, status, request) {
  if (!["ACTIVE", "INACTIVE"].includes(status)) {
    const err = new Error("status must be ACTIVE or INACTIVE");
    err.status = 400;
    throw err;
  }
  if (Number(userId) === actingUser.userId && status === "INACTIVE") {
    const err = new Error("You cannot deactivate your own account");
    err.status = 400;
    throw err;
  }

  await env.DB.prepare(`UPDATE users SET status = ? WHERE user_id = ?`).bind(status, userId).run();
  if (status === "INACTIVE") {
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();
  }

  await writeAudit(env, {
    userId: actingUser.userId,
    action: status === "ACTIVE" ? "ADMIN_ACTIVATED_USER" : "ADMIN_DEACTIVATED_USER",
    recordType: "user",
    recordId: userId,
    request,
  });

  return { user_id: Number(userId), status };
}


/* ---- from index.js ---- */
// worker/src/index.js
// Entry point. Deliberately dependency-free (no bundler/framework required) -
// a small manual router is enough for this API's surface area.


const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://gate-26.pages.dev", // must be a specific origin, not "*", since SameSite=None cookies require credentials support
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Credentials": "true",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

function errorResponse(err) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  return json({ error: err.message || "Internal error" }, status);
}

const __worker_export__ = {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ---------- AUTH (no session required) ----------
      if (path === "/api/auth/login" && request.method === "POST") {
        const { username, password } = await request.json();
        const userRow = await env.DB.prepare(
          `SELECT user_id, username, password_hash, role, employee_id, status FROM users WHERE username = ?`
        ).bind(username).first();

        if (!userRow || userRow.status !== "ACTIVE" || !(await verifyPassword(password, userRow.password_hash))) {
          // Same generic error whether the user doesn't exist or the password is wrong.
          return json({ error: "Invalid username or password" }, 401);
        }

        const { token, expiresAt } = await createSession(env, userRow.user_id, request);
        await env.DB.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE user_id = ?`).bind(userRow.user_id).run();

        return json(
          { user_id: userRow.user_id, username: userRow.username, role: userRow.role, employee_id: userRow.employee_id, expires_at: expiresAt },
          200,
          { "Set-Cookie": sessionCookie(token, 12 * 60 * 60) }
        );
      }

      if (path === "/api/auth/logout" && request.method === "POST") {
        const user = await getCurrentUser(env, request);
        if (user) {
          await env.DB.prepare(`DELETE FROM sessions WHERE session_token = ?`).bind(user.sessionToken).run();
        }
        return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
      }

      // ---------- Everything below requires an active session ----------
      const user = await getCurrentUser(env, request);

      if (path === "/api/auth/me" && request.method === "GET") {
        if (!user) return json({ error: "Unauthorized" }, 401);
        return json({ user });
      }

      // ---------- EMPLOYEES ----------
      if (path === "/api/employees" && request.method === "GET") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN", "HOD", "SECURITY", "MANAGEMENT_VIEWER", "EMPLOYEE"]);
        return json(await listEmployees(env));
      }
      if (path === "/api/employees" && request.method === "POST") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN"]);
        return json(await createEmployee(env, user, await request.json(), request));
      }
      if (path === "/api/employees/import" && request.method === "POST") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN"]);
        const { rows } = await request.json(); // pre-parsed on the frontend (PapaParse / SheetJS)
        return json(await importEmployees(env, user, rows, request));
      }

      // ---------- LOCATIONS ----------
      if (path === "/api/locations" && request.method === "GET") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN", "HOD", "SECURITY", "MANAGEMENT_VIEWER", "EMPLOYEE"]);
        return json(await listLocations(env));
      }
      if (path === "/api/locations" && request.method === "POST") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN"]);
        return json(await createLocation(env, user, await request.json(), request));
      }

      // ---------- GATE PASSES ----------
      if (path === "/api/gatepasses" && request.method === "GET") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN", "HOD", "SECURITY", "MANAGEMENT_VIEWER", "EMPLOYEE"]);
        return json(await listGatePasses(env, user));
      }
      if (path === "/api/gatepasses" && request.method === "POST") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN", "EMPLOYEE", "HOD"]);
        return json(await createGatePass(env, user, await request.json(), request));
      }
      const passDetailMatch = path.match(/^\/api\/gatepasses\/(\d+)$/);
      if (passDetailMatch && request.method === "GET") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN", "HOD", "SECURITY", "MANAGEMENT_VIEWER", "EMPLOYEE"]);
        return json(await getGatePassDetails(env, passDetailMatch[1]));
      }

      // ---------- APPROVALS ----------
      if (path === "/api/approvals/pending" && request.method === "GET") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN", "HOD"]);
        return json(await listPendingApprovals(env));
      }
      const decideMatch = path.match(/^\/api\/gatepasses\/(\d+)\/decision$/);
      if (decideMatch && request.method === "POST") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN", "HOD"]);
        const { decision, comments } = await request.json();
        return json(await decidePass(env, user, decideMatch[1], decision, comments, request));
      }

      // ---------- MOVEMENTS ----------
      if (path === "/api/movements" && request.method === "POST") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN", "SECURITY", "EMPLOYEE"]);
        return json(await recordMovementEvent(env, user, await request.json(), request));
      }
      if (path === "/api/movements/live" && request.method === "GET") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN", "HOD", "SECURITY", "MANAGEMENT_VIEWER"]);
        return json(await getLiveStatus(env));
      }

      // ---------- USER MANAGEMENT ----------
      if (path === "/api/users" && request.method === "GET") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN"]);
        return json(await listUsers(env));
      }
      if (path === "/api/users" && request.method === "POST") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN"]);
        return json(await createUser(env, user, await request.json(), request));
      }
      const userStatusMatch = path.match(/^\/api\/users\/(\d+)\/status$/);
      if (userStatusMatch && request.method === "PUT") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN"]);
        const { status } = await request.json();
        return json(await setUserStatus(env, user, userStatusMatch[1], status, request));
      }

      // ---------- QR RESOLUTION ----------
      // Unified lookup so the scanner doesn't need to know in advance whether
      // it scanned a location QR or a pass QR (spec section 13).
      const qrMatch = path.match(/^\/api\/qr\/([A-Za-z0-9]+)$/);
      if (qrMatch && request.method === "GET") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN", "HOD", "SECURITY", "EMPLOYEE", "MANAGEMENT_VIEWER"]);
        const token = qrMatch[1];
        const location = await getLocationByQrToken(env, token);
        if (location) return json({ type: "location", location });
        const pass = await getPassByQrToken(env, token);
        if (pass) return json({ type: "pass", pass });
        const employee = await getEmployeeByBadgeToken(env, token);
        if (employee) return json({ type: "employee", employee });
        return json({ error: "QR code not recognized" }, 404);
      }

      // ---------- AUDIT LOG ----------
      if (path === "/api/audit" && request.method === "GET") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN"]);
        const { results } = await env.DB.prepare(
          `SELECT audit_id, user_id, action, record_type, record_id, created_at FROM audit_log ORDER BY created_at DESC LIMIT 200`
        ).all();
        return json(results);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return errorResponse(err);
    }
  },
};


export default __worker_export__;
