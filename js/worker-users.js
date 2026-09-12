// worker/src/users.js

import { hashPassword } from "./auth.js";
import { writeAudit } from "./audit.js";

const VALID_ROLES = ["SUPER_ADMIN", "ADMIN", "HOD", "EMPLOYEE", "SECURITY", "MANAGEMENT_VIEWER"];

export async function listUsers(env) {
  const { results } = await env.DB.prepare(
    `SELECT u.user_id, u.username, u.role, u.status, u.employee_id, e.full_name AS employee_name, d.department_name, u.last_login_at, u.created_at
     FROM users u
     LEFT JOIN employees e ON e.employee_id = u.employee_id
     LEFT JOIN departments d ON d.department_id = e.department_id
     ORDER BY u.username`
  ).all();
  return results;
}

export async function createUser(env, actingUser, body, request) {
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
