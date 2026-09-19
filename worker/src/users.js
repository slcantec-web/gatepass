// worker/src/users.js
import { hashPassword } from "./auth.js";
import { writeAudit } from "./audit.js";

const VALID_ROLES = ["SUPER_ADMIN", "ADMIN", "HOD", "EMPLOYEE", "SECURITY", "MANAGEMENT_VIEWER"];

export async function listUsers(env) {
  const { results } = await env.DB.prepare(
    `SELECT u.user_id, u.username, u.role, u.status, u.employee_id, e.full_name AS employee_name,
            d.department_name, u.default_location_id, l.location_name AS default_location_name,
            u.last_login_at, u.created_at
     FROM users u
     LEFT JOIN employees e ON e.employee_id = u.employee_id
     LEFT JOIN departments d ON d.department_id = e.department_id
     LEFT JOIN locations l ON l.location_id = u.default_location_id
     ORDER BY u.username`
  ).all();
  return results;
}

export async function createUser(env, actingUser, body, request) {
  const { username, password, role, employee_id, default_location_id } = body;
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

  if (default_location_id != null) {
    const loc = await env.DB.prepare(`SELECT location_id FROM locations WHERE location_id = ?`)
      .bind(default_location_id).first();
    if (!loc) {
      const err = new Error("Default location not found");
      err.status = 404;
      throw err;
    }
  }

  const passwordHash = await hashPassword(password);
  const result = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, role, employee_id, default_location_id) VALUES (?, ?, ?, ?, ?)`
  ).bind(username, passwordHash, role, employee_id ?? null, default_location_id ?? null).run();

  await writeAudit(env, {
    userId: actingUser.userId,
    action: "ADMIN_CREATED_USER",
    recordType: "user",
    recordId: result.meta.last_row_id,
    details: { username, role, default_location_id: default_location_id ?? null },
    request,
  });

  return { user_id: result.meta.last_row_id };
}

export async function resetPassword(env, actingUser, userId, newPassword, request) {
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

export async function setUserStatus(env, actingUser, userId, status, request) {
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
export async function deleteUser(env, actingUser, userId, request) {
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

// Which location auto-fills on this user's movement events (specifically
// gate events, which otherwise carry no location_id at all) when they don't
// scan/pick one themselves - meant for SECURITY logins permanently stationed
// at one gate. Split out as its own small endpoint, same pattern as
// /status and /password, rather than folding into createUser-only.
export async function setUserDefaultLocation(env, actingUser, userId, locationId, request) {
  const target = await env.DB.prepare(`SELECT user_id, username FROM users WHERE user_id = ?`).bind(userId).first();
  if (!target) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }

  if (locationId != null) {
    const loc = await env.DB.prepare(`SELECT location_id FROM locations WHERE location_id = ?`).bind(locationId).first();
    if (!loc) {
      const err = new Error("Location not found");
      err.status = 404;
      throw err;
    }
  }

  await env.DB.prepare(`UPDATE users SET default_location_id = ? WHERE user_id = ?`).bind(locationId ?? null, userId).run();

  await writeAudit(env, {
    userId: actingUser.userId,
    action: "ADMIN_SET_USER_DEFAULT_LOCATION",
    recordType: "user",
    recordId: userId,
    details: { username: target.username, default_location_id: locationId ?? null },
    request,
  });

  return { user_id: Number(userId), default_location_id: locationId ?? null };
}
