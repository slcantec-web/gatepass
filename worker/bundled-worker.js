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
  // Secure + HttpOnly + SameSite=Lax: frontend and API are subdomains of the
  // same registrable domain (lksys.dpdns.org), so this is a same-site cookie
  // and Lax is the standard, safest choice.
  return `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookie() {
  return `session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
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
    `SELECT e.employee_id, e.emp_code, e.full_name, e.department_id, d.department_name, e.hod_employee_id, e.designation, e.phone, e.email, e.status, e.badge_qr_token
     FROM employees e LEFT JOIN departments d ON d.department_id = e.department_id
     ORDER BY e.full_name`
  ).all();
  return results;
}

// Assigns/changes which department an existing employee belongs to. Split out
// as its own small endpoint (same pattern as /status, /password elsewhere)
// rather than a full "edit employee" form, since department is the one field
// that needs to be correctable after the fact - HOD approval scoping and the
// department roster both depend on every employee actually having one set.
async function setEmployeeDepartment(env, user, employeeId, departmentId, request) {
  const employee = await env.DB.prepare(`SELECT employee_id, full_name FROM employees WHERE employee_id = ?`)
    .bind(employeeId).first();
  if (!employee) {
    const err = new Error("Employee not found");
    err.status = 404;
    throw err;
  }

  if (departmentId != null) {
    const dept = await env.DB.prepare(`SELECT department_id FROM departments WHERE department_id = ?`)
      .bind(departmentId).first();
    if (!dept) {
      const err = new Error("Department not found");
      err.status = 404;
      throw err;
    }
  }

  await env.DB.prepare(`UPDATE employees SET department_id = ?, updated_at = datetime('now') WHERE employee_id = ?`)
    .bind(departmentId ?? null, employeeId).run();

  await writeAudit(env, {
    userId: user.userId,
    action: "ADMIN_UPDATED_EMPLOYEE_DEPARTMENT",
    recordType: "employee",
    recordId: employeeId,
    details: { full_name: employee.full_name, department_id: departmentId ?? null },
    request,
  });

  return { employee_id: Number(employeeId), department_id: departmentId ?? null };
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


/* ---- from departments.js ---- */
// worker/src/departments.js
// Department Master. Departments already existed in the schema (employees
// and users have carried department_id/hod_employee_id from the start) but
// never had a dedicated management screen - HOD-scoped approvals depend on
// this data being complete and correct, so it needs to be first-class and
// editable, not just something admins insert manually into D1.

async function listDepartments(env) {
  const { results } = await env.DB.prepare(
    `SELECT d.department_id, d.company_id, d.department_code, d.department_name, d.status,
            d.hod_employee_id, e.full_name AS hod_name,
            (SELECT COUNT(*) FROM employees emp WHERE emp.department_id = d.department_id AND emp.status = 'ACTIVE') AS employee_count
     FROM departments d LEFT JOIN employees e ON e.employee_id = d.hod_employee_id
     ORDER BY d.department_name`
  ).all();
  return results;
}

async function createDepartment(env, user, body, request) {
  const { department_code, department_name, hod_employee_id, company_id } = body;
  if (!department_code || !department_name) {
    const err = new Error("department_code and department_name are required");
    err.status = 400;
    throw err;
  }

  const existing = await env.DB.prepare(
    `SELECT department_id FROM departments WHERE department_code = ? AND (company_id IS ? OR company_id = ?)`
  ).bind(department_code, company_id ?? null, company_id ?? null).first();
  if (existing) {
    const err = new Error(`${department_code} already exists`);
    err.status = 409;
    throw err;
  }

  const result = await env.DB.prepare(
    `INSERT INTO departments (company_id, department_code, department_name, hod_employee_id) VALUES (?, ?, ?, ?)`
  ).bind(company_id ?? 1, department_code, department_name, hod_employee_id ?? null).run();

  await writeAudit(env, {
    userId: user.userId,
    action: "ADMIN_CREATED_DEPARTMENT",
    recordType: "department",
    recordId: result.meta.last_row_id,
    details: { department_code, department_name },
    request,
  });

  return { department_id: result.meta.last_row_id };
}

// Editable: name and who heads it. department_code is left alone once set -
// changing a code silently would be confusing anywhere it's referenced in
// history/audit text, so treat it as immutable and have people create a new
// department instead if a code was genuinely wrong.
async function updateDepartment(env, user, departmentId, body, request) {
  const { department_name, hod_employee_id } = body;

  const department = await env.DB.prepare(`SELECT department_id FROM departments WHERE department_id = ?`)
    .bind(departmentId).first();
  if (!department) {
    const err = new Error("Department not found");
    err.status = 404;
    throw err;
  }
  if (!department_name) {
    const err = new Error("department_name is required");
    err.status = 400;
    throw err;
  }

  await env.DB.prepare(`UPDATE departments SET department_name = ?, hod_employee_id = ? WHERE department_id = ?`)
    .bind(department_name, hod_employee_id ?? null, departmentId).run();

  await writeAudit(env, {
    userId: user.userId,
    action: "ADMIN_UPDATED_DEPARTMENT",
    recordType: "department",
    recordId: departmentId,
    details: { department_name, hod_employee_id: hod_employee_id ?? null },
    request,
  });

  return { department_id: Number(departmentId) };
}

// Soft delete (status -> INACTIVE), same reasoning as locations: employees
// reference departments by department_id, so a real DELETE risks either an
// FK failure or silently orphaning people's department assignment. Blocked
// if active employees are still assigned, so you can't "delete" a department
// out from under a staffed team by mistake.
async function setDepartmentStatus(env, user, departmentId, status, request) {
  if (!["ACTIVE", "INACTIVE"].includes(status)) {
    const err = new Error("status must be ACTIVE or INACTIVE");
    err.status = 400;
    throw err;
  }

  const department = await env.DB.prepare(`SELECT department_id, department_name FROM departments WHERE department_id = ?`)
    .bind(departmentId).first();
  if (!department) {
    const err = new Error("Department not found");
    err.status = 404;
    throw err;
  }

  if (status === "INACTIVE") {
    const staffed = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM employees WHERE department_id = ? AND status = 'ACTIVE'`
    ).bind(departmentId).first();
    if ((staffed?.c ?? 0) > 0) {
      const err = new Error(`Cannot delete: ${staffed.c} active employee(s) are still assigned to this department`);
      err.status = 409;
      throw err;
    }
  }

  await env.DB.prepare(`UPDATE departments SET status = ? WHERE department_id = ?`).bind(status, departmentId).run();

  await writeAudit(env, {
    userId: user.userId,
    action: status === "ACTIVE" ? "ADMIN_RESTORED_DEPARTMENT" : "ADMIN_DELETED_DEPARTMENT",
    recordType: "department",
    recordId: departmentId,
    details: { department_name: department.department_name },
    request,
  });

  return { department_id: Number(departmentId), status };
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

// "Delete" a location without breaking referential integrity: locations are
// referenced by gate_passes.from_location_id, pass_routes, and movement_events
// (with PRAGMA foreign_keys = ON, a real DELETE would fail anyway once any of
// those exist, and would destroy history for completed passes even when it
// didn't). So this is a soft delete - status flips to INACTIVE, which hides
// it from pickers on the frontend, and can be reversed with status=ACTIVE.
async function setLocationStatus(env, user, locationId, status, request) {
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
async function regenerateLocationQr(env, user, locationId, request) {
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

const PASS_CATEGORIES = ["MOVEMENT", "EARLY_LEAVE"];

// body: { leader_employee_id, from_location_id, purpose, expected_departure, expected_return,
//         member_employee_ids: [...], route_location_ids: [...], destination_note, pass_category }
async function createGatePass(env, user, body, request) {
  const {
    leader_employee_id, from_location_id, purpose,
    expected_departure, expected_return,
    member_employee_ids = [], route_location_ids = [],
    destination_note, pass_category = "MOVEMENT",
  } = body;

  if (!leader_employee_id || !from_location_id || !purpose) {
    const err = new Error("leader_employee_id, from_location_id and purpose are required");
    err.status = 400;
    throw err;
  }
  if (!PASS_CATEGORIES.includes(pass_category)) {
    const err = new Error(`pass_category must be one of: ${PASS_CATEGORIES.join(", ")}`);
    err.status = 400;
    throw err;
  }

  // A pass isn't required to have a registered route location at all: the
  // destination might genuinely be unknown yet, or it might be a real place
  // that was simply never added to Location Master. destination_note covers
  // the latter case as free text, since pass_routes.location_id is a
  // required foreign key and can't reference something that doesn't exist.
  const trimmedNote = destination_note ? String(destination_note).trim() : null;

  // EARLY_LEAVE passes are one-way by definition - there's no return time to
  // record, so don't persist a stray expected_return even if the client sent one.
  const effectiveExpectedReturn = pass_category === "EARLY_LEAVE" ? null : (expected_return ?? null);

  // Leader is always a member too.
  const allMembers = Array.from(new Set([leader_employee_id, ...member_employee_ids]));
  const passNumber = await nextPassNumber(env);
  const qrToken = randomToken(16);
  const passType = allMembers.length > 1 ? "GROUP" : "SINGLE";

  const passResult = await env.DB.prepare(
    `INSERT INTO gate_passes (pass_number, leader_employee_id, from_location_id, purpose, destination_note, pass_category, expected_departure, expected_return, pass_type, status, qr_code_token, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`
  ).bind(passNumber, leader_employee_id, from_location_id, purpose, trimmedNote || null, pass_category, expected_departure ?? null, effectiveExpectedReturn, passType, qrToken, user.userId).run();

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
      `SELECT DISTINCT gp.pass_id, gp.pass_number, gp.purpose, gp.status, gp.pass_category, gp.created_at, gp.leader_employee_id
       FROM gate_passes gp
       LEFT JOIN pass_members pm ON pm.pass_id = gp.pass_id
       WHERE gp.leader_employee_id = ? OR pm.employee_id = ?
       ORDER BY gp.created_at DESC`
    ).bind(user.employeeId, user.employeeId).all();
    return results;
  }

  // Admin / HOD / Security / Management Viewer: full gate pass history, with
  // the leader's name so it reads as a real history list rather than just IDs.
  const { results } = await env.DB.prepare(
    `SELECT gp.pass_id, gp.pass_number, gp.purpose, gp.status, gp.pass_category, gp.created_at, gp.leader_employee_id, e.full_name AS leader_name
     FROM gate_passes gp
     JOIN employees e ON e.employee_id = gp.leader_employee_id
     ORDER BY gp.created_at DESC LIMIT 200`
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

// Delete a gate pass and all its child rows (pass_members, pass_routes,
// movement_events, approvals). Two paths in:
//  - The pass LEADER can delete their OWN pass, but only while it's PENDING
//    or REJECTED - i.e. before any movement has actually happened.
//  - A SUPER_ADMIN can delete ANY pass that isn't COMPLETED, to clean up
//    stuck/abandoned/mis-created passes.
// COMPLETED passes can never be deleted by anyone - that's the permanent
// movement record and it stays in the audit trail.
async function deleteGatePass(env, user, passId, request) {
  const pass = await env.DB.prepare(`SELECT * FROM gate_passes WHERE pass_id = ?`).bind(passId).first();
  if (!pass) {
    const err = new Error("Pass not found");
    err.status = 404;
    throw err;
  }

  if (pass.status === "COMPLETED") {
    const err = new Error("Completed gate passes cannot be deleted");
    err.status = 409;
    throw err;
  }

  const isOwner = pass.leader_employee_id === user.employeeId;
  const isSuperAdmin = user.role === "SUPER_ADMIN";
  const ownerCanDelete = isOwner && ["PENDING", "REJECTED"].includes(pass.status);

  if (!isSuperAdmin && !ownerCanDelete) {
    const err = new Error("You can only delete your own pass before it has moved (Pending or Rejected), or ask a Super Admin");
    err.status = 403;
    throw err;
  }

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM movement_events WHERE pass_id = ?`).bind(passId),
    env.DB.prepare(`DELETE FROM approvals WHERE pass_id = ?`).bind(passId),
    env.DB.prepare(`DELETE FROM pass_members WHERE pass_id = ?`).bind(passId),
    env.DB.prepare(`DELETE FROM pass_routes WHERE pass_id = ?`).bind(passId),
    env.DB.prepare(`DELETE FROM gate_passes WHERE pass_id = ?`).bind(passId),
  ]);

  await writeAudit(env, {
    userId: user.userId,
    action: isSuperAdmin && !ownerCanDelete ? "SUPER_ADMIN_DELETED_PASS" : "USER_DELETED_OWN_PASS",
    recordType: "gate_pass",
    recordId: passId,
    details: { pass_number: pass.pass_number, previous_status: pass.status },
    request,
  });

  return { deleted: true, pass_id: Number(passId) };
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

  // A HOD may only decide on passes led by someone in their own department.
  // SUPER_ADMIN/ADMIN bypass this and can approve anything. This is enforced
  // here (not just by filtering what the HOD's approvals list shows) so a
  // HOD can't approve an out-of-department pass by calling the API directly
  // with a pass_id they weren't shown.
  if (user.role === "HOD") {
    const [hodEmployee, leader] = await Promise.all([
      env.DB.prepare(`SELECT department_id FROM employees WHERE employee_id = ?`).bind(user.employeeId).first(),
      env.DB.prepare(`SELECT department_id FROM employees WHERE employee_id = ?`).bind(pass.leader_employee_id).first(),
    ]);
    if (!hodEmployee?.department_id || !leader?.department_id || hodEmployee.department_id !== leader.department_id) {
      const err = new Error("You can only approve gate passes for your own department");
      err.status = 403;
      throw err;
    }
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

// SUPER_ADMIN/ADMIN see every pending pass. A HOD only sees passes led by
// someone in their own department (looked up from their own linked employee
// record) - and if that HOD's employee record has no department set, they
// see nothing rather than everything: fail closed, not open.
async function listPendingApprovals(env, user) {
  let departmentFilter = null;
  if (user.role === "HOD") {
    const hodEmployee = await env.DB.prepare(`SELECT department_id FROM employees WHERE employee_id = ?`)
      .bind(user.employeeId).first();
    departmentFilter = hodEmployee?.department_id ?? null;
    if (!departmentFilter) return [];
  }

  const query = `SELECT gp.pass_id, gp.pass_number, gp.purpose, gp.created_at, e.full_name AS leader_name, d.department_name AS leader_department
                 FROM gate_passes gp
                 JOIN employees e ON e.employee_id = gp.leader_employee_id
                 LEFT JOIN departments d ON d.department_id = e.department_id
                 WHERE gp.status = 'PENDING' ${departmentFilter ? "AND e.department_id = ?" : ""}
                 ORDER BY gp.created_at`;
  const stmt = departmentFilter ? env.DB.prepare(query).bind(departmentFilter) : env.DB.prepare(query);
  const { results } = await stmt.all();
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

// Statuses that mean "this member's part of the pass is done" - no further
// movement events are expected, and the pass can complete once every member
// is in one of these.
const TERMINAL_MEMBER_STATUSES = ["RETURNED", "CANCELLED", "LEFT_FOR_DAY"];

// Maps an event type to the pass_member status it produces. passCategory
// matters only for GATE_OUT: on a normal MOVEMENT pass, going out just means
// "currently outside" and a GATE_IN is still expected later. On an
// EARLY_LEAVE pass (a worker authorized to leave before shift end, with no
// return expected that day), the same GATE_OUT is the end of the story for
// that member - there is no return time to wait for, so it goes straight to
// a terminal status instead of OUTSIDE.
function memberStatusFor(eventType, passCategory) {
  switch (eventType) {
    case "GATE_OUT": return passCategory === "EARLY_LEAVE" ? "LEFT_FOR_DAY" : "OUTSIDE";
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
  if (pass.pass_category === "EARLY_LEAVE" && event_type === "GATE_IN") {
    const err = new Error("This is an Early Leave pass with no return expected - there's nothing to gate in.");
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
  if (TERMINAL_MEMBER_STATUSES.includes(member.member_status)) {
    const err = new Error(`Employee movement already closed (${member.member_status})`);
    err.status = 409;
    throw err;
  }

  // Explicit gate-event transition guard: GATE_OUT/GATE_IN each have exactly
  // one valid starting state. Without this, member_status === "OUTSIDE" was
  // never in the terminal-status check above, so a second GATE_OUT (e.g. a
  // duplicate tap that generated a fresh idempotency key) would sail through,
  // re-recording the same person as gated out twice on the same pass.
  if (event_type === "GATE_OUT" && member.member_status !== "PENDING") {
    const err = new Error(`This person has already been gated out on this pass (status: ${member.member_status}). Use Gate In instead.`);
    err.status = 409;
    throw err;
  }
  if (event_type === "GATE_IN" && member.member_status === "PENDING") {
    const err = new Error("This person hasn't been gated out yet on this pass - nothing to gate in.");
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

  const newMemberStatus = memberStatusFor(event_type, pass.pass_category);

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

  // Check whether the whole pass can now be completed (spec section 5: must
  // NOT close until every member has resolved) - triggered any time this
  // event just put a member into a terminal state, whether that's a normal
  // GATE_IN return or a GATE_OUT on an Early Leave pass.
  if (TERMINAL_MEMBER_STATUSES.includes(newMemberStatus)) {
    await maybeCompletePass(env, pass_id, user, request);
  }

  return { event_id: eventId, member_status: newMemberStatus };
}

async function maybeCompletePass(env, passId, user, request) {
  const { results } = await env.DB.prepare(
    `SELECT member_status FROM pass_members WHERE pass_id = ?`
  ).bind(passId).all();

  const allResolved = results.every((m) => TERMINAL_MEMBER_STATUSES.includes(m.member_status));
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
      AND pm.member_status NOT IN ('RETURNED', 'CANCELLED', 'LEFT_FOR_DAY')
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

// Super Admin "clean slate" tool for the dashboard: forcibly resolves every
// pass stuck in an unfinished state instead of requiring someone to hunt
// down and manually close each one.
//  - PENDING passes (never approved) are marked REJECTED.
//  - APPROVED / IN_PROGRESS passes have every unresolved member forced to
//    CANCELLED and the pass itself marked COMPLETED, dropping it off the
//    live status dashboard. "Unresolved" here uses the same
//    TERMINAL_MEMBER_STATUSES list movements.js already uses, so an
//    Early Leave member sitting at LEFT_FOR_DAY is correctly left alone.
// COMPLETED and REJECTED passes are already resolved and untouched.
async function resetIncompletePasses(env, user, request) {
  const { results: activePasses } = await env.DB.prepare(
    `SELECT pass_id, status FROM gate_passes WHERE status IN ('PENDING', 'APPROVED', 'IN_PROGRESS')`
  ).all();

  let rejectedPending = 0;
  let closedInProgress = 0;
  let clearedMembers = 0;

  for (const p of activePasses) {
    if (p.status === "PENDING") {
      await env.DB.prepare(
        `UPDATE gate_passes SET status = 'REJECTED', updated_at = datetime('now') WHERE pass_id = ?`
      ).bind(p.pass_id).run();
      rejectedPending++;
      continue;
    }

    const upd = await env.DB.prepare(
      `UPDATE pass_members SET member_status = 'CANCELLED'
       WHERE pass_id = ? AND member_status NOT IN ('RETURNED', 'CANCELLED', 'LEFT_FOR_DAY')`
    ).bind(p.pass_id).run();
    clearedMembers += upd.meta?.changes || 0;

    await env.DB.prepare(
      `UPDATE gate_passes SET status = 'COMPLETED', updated_at = datetime('now') WHERE pass_id = ?`
    ).bind(p.pass_id).run();
    closedInProgress++;
  }

  await writeAudit(env, {
    userId: user.userId,
    action: "SUPER_ADMIN_RESET_DASHBOARD",
    recordType: "gate_pass",
    details: { rejectedPending, closedInProgress, clearedMembers },
    request,
  });

  return { rejected_pending: rejectedPending, closed_in_progress: closedInProgress, cleared_members: clearedMembers };
}


/* ---- from users.js ---- */
// worker/src/users.js

const VALID_ROLES = ["SUPER_ADMIN", "ADMIN", "HOD", "EMPLOYEE", "SECURITY", "MANAGEMENT_VIEWER"];

async function listUsers(env) {
  const { results } = await env.DB.prepare(
    `SELECT u.user_id, u.username, u.role, u.status, u.employee_id, e.full_name AS employee_name, d.department_name, u.last_login_at, u.created_at
     FROM users u
     LEFT JOIN employees e ON e.employee_id = u.employee_id
     LEFT JOIN departments d ON d.department_id = e.department_id
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

async function resetPassword(env, actingUser, userId, newPassword, request) {
  if (!newPassword || newPassword.length < 8) {
    const err = new Error("New password must be at least 8 characters");
    err.status = 400;
    throw err;
  }

  const target = await env.DB.prepare(`SELECT user_id, username, role FROM users WHERE user_id = ?`).bind(userId).first();
  if (!target) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }
  // Only a SUPER_ADMIN can reset another SUPER_ADMIN's password.
  if (target.role === "SUPER_ADMIN" && actingUser.role !== "SUPER_ADMIN") {
    const err = new Error("Only a Super Admin can reset another Super Admin's password");
    err.status = 403;
    throw err;
  }

  const passwordHash = await hashPassword(newPassword);
  await env.DB.prepare(`UPDATE users SET password_hash = ? WHERE user_id = ?`).bind(passwordHash, userId).run();
  // Force re-login everywhere - a reset password should invalidate any existing sessions.
  await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();

  await writeAudit(env, {
    userId: actingUser.userId,
    action: "ADMIN_RESET_PASSWORD",
    recordType: "user",
    recordId: userId,
    details: { username: target.username },
    request,
  });

  return { user_id: Number(userId), reset: true };
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

// Hard delete, unlike setUserStatus (soft, reversible). Only makes sense for
// an account that hasn't actually done anything in the system yet - e.g. a
// freshly-created login that turned out wrong and needs to be recreated -
// since users.user_id is referenced by gate_passes.created_by,
// movement_events.recorded_by and approvals.approver_id (all NOT NULL FKs).
// If the account has any of that history, this refuses rather than either
// failing on the FK constraint or silently orphaning the audit trail; the
// caller should use setUserStatus('INACTIVE') instead to preserve history.
async function deleteUser(env, actingUser, userId, request) {
  const target = await env.DB.prepare(`SELECT user_id, username, role FROM users WHERE user_id = ?`).bind(userId).first();
  if (!target) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }
  if (Number(userId) === actingUser.userId) {
    const err = new Error("You cannot delete your own account");
    err.status = 400;
    throw err;
  }
  // Only a SUPER_ADMIN can delete another SUPER_ADMIN (mirrors createUser).
  if (target.role === "SUPER_ADMIN" && actingUser.role !== "SUPER_ADMIN") {
    const err = new Error("Only a Super Admin can delete another Super Admin");
    err.status = 403;
    throw err;
  }

  const [passCount, movementCount, approvalCount] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS c FROM gate_passes WHERE created_by = ?`).bind(userId).first(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM movement_events WHERE recorded_by = ?`).bind(userId).first(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM approvals WHERE approver_id = ?`).bind(userId).first(),
  ]);
  const usageParts = [];
  if (passCount.c > 0) usageParts.push(`created ${passCount.c} gate pass(es)`);
  if (movementCount.c > 0) usageParts.push(`recorded ${movementCount.c} movement event(s)`);
  if (approvalCount.c > 0) usageParts.push(`made ${approvalCount.c} approval decision(s)`);
  if (usageParts.length > 0) {
    const err = new Error(`Cannot delete '${target.username}': this account has ${usageParts.join(", ")} and is part of the audit trail. Deactivate it instead.`);
    err.status = 409;
    throw err;
  }

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM users WHERE user_id = ?`).bind(userId),
  ]);

  await writeAudit(env, {
    userId: actingUser.userId,
    action: "ADMIN_DELETED_USER",
    recordType: "user",
    recordId: userId,
    details: { username: target.username, role: target.role },
    request,
  });

  return { deleted: true, user_id: Number(userId) };
}


/* ---- from settings.js ---- */
// worker/src/settings.js
// Backs the Super Admin "System Settings" screen (js/settings.js): whether
// pass-slip printing is offered, and what paper size it prints to. Stored as
// simple key/value rows in system_settings so new setting keys don't need a
// schema migration.

const DEFAULT_SETTINGS = {
  print_enabled: "true",
  print_paper_size: "A4",
  print_custom_width_mm: "80",
  print_custom_height_mm: "150",
};

async function getSettings(env) {
  const { results } = await env.DB.prepare(
    `SELECT setting_key, setting_value FROM system_settings`
  ).all();

  const settings = { ...DEFAULT_SETTINGS };
  for (const row of results) {
    settings[row.setting_key] = row.setting_value;
  }
  return settings;
}

async function updateSettings(env, user, body, request) {
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


/* ---- from index.js ---- */
// worker/src/index.js
// Entry point. Deliberately dependency-free (no bundler/framework required) -
// a small manual router is enough for this API's surface area.


const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://lksys.dpdns.org", // must be a specific origin, not "*", since SameSite=Lax cookies require credentials support
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
      const employeeDeptMatch = path.match(/^\/api\/employees\/(\d+)\/department$/);
      if (employeeDeptMatch && request.method === "PUT") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN"]);
        const { department_id } = await request.json();
        return json(await setEmployeeDepartment(env, user, employeeDeptMatch[1], department_id, request));
      }

      // ---------- DEPARTMENTS ----------
      if (path === "/api/departments" && request.method === "GET") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN", "HOD", "SECURITY", "MANAGEMENT_VIEWER", "EMPLOYEE"]);
        return json(await listDepartments(env));
      }
      if (path === "/api/departments" && request.method === "POST") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN"]);
        return json(await createDepartment(env, user, await request.json(), request));
      }
      const departmentMatch = path.match(/^\/api\/departments\/(\d+)$/);
      if (departmentMatch && request.method === "PUT") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN"]);
        return json(await updateDepartment(env, user, departmentMatch[1], await request.json(), request));
      }
      const departmentStatusMatch = path.match(/^\/api\/departments\/(\d+)\/status$/);
      if (departmentStatusMatch && request.method === "PUT") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN"]);
        const { status } = await request.json();
        return json(await setDepartmentStatus(env, user, departmentStatusMatch[1], status, request));
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
      const locationStatusMatch = path.match(/^\/api\/locations\/(\d+)\/status$/);
      if (locationStatusMatch && request.method === "PUT") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN"]);
        const { status } = await request.json();
        return json(await setLocationStatus(env, user, locationStatusMatch[1], status, request));
      }
      const locationQrMatch = path.match(/^\/api\/locations\/(\d+)\/regenerate-qr$/);
      if (locationQrMatch && request.method === "POST") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN"]);
        return json(await regenerateLocationQr(env, user, locationQrMatch[1], request));
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
      if (passDetailMatch && request.method === "DELETE") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN", "HOD", "EMPLOYEE"]);
        return json(await deleteGatePass(env, user, passDetailMatch[1], request));
      }

      // ---------- APPROVALS ----------
      if (path === "/api/approvals/pending" && request.method === "GET") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN", "HOD"]);
        return json(await listPendingApprovals(env, user));
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
      if (path === "/api/movements/reset" && request.method === "POST") {
        requireRole(user, ["SUPER_ADMIN"]);
        return json(await resetIncompletePasses(env, user, request));
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
      const userDeleteMatch = path.match(/^\/api\/users\/(\d+)$/);
      if (userDeleteMatch && request.method === "DELETE") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN"]);
        return json(await deleteUser(env, user, userDeleteMatch[1], request));
      }
      const userPasswordMatch = path.match(/^\/api\/users\/(\d+)\/password$/);
      if (userPasswordMatch && request.method === "PUT") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN"]);
        const { new_password } = await request.json();
        return json(await resetPassword(env, user, userPasswordMatch[1], new_password, request));
      }

      // ---------- SETTINGS ----------
      if (path === "/api/settings" && request.method === "GET") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN", "HOD", "SECURITY", "MANAGEMENT_VIEWER", "EMPLOYEE"]);
        return json(await getSettings(env));
      }
      if (path === "/api/settings" && request.method === "PUT") {
        requireRole(user, ["SUPER_ADMIN"]);
        return json(await updateSettings(env, user, await request.json(), request));
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
