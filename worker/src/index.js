// worker/src/index.js
// Entry point. Deliberately dependency-free (no bundler/framework required) -
// a small manual router is enough for this API's surface area.

import { hashPassword, verifyPassword, createSession, getCurrentUser, requireRole, sessionCookie, clearSessionCookie } from "./auth.js";
import { writeAudit } from "./audit.js";
import { listEmployees, createEmployee, importEmployees, getEmployeeByBadgeToken } from "./employees.js";
import { listLocations, createLocation, getLocationByQrToken } from "./locations.js";
import { createGatePass, listGatePasses, getGatePassDetails, getPassByQrToken } from "./gatepasses.js";
import { decidePass, listPendingApprovals } from "./approvals.js";
import { recordMovementEvent, getLiveStatus } from "./movements.js";
import { listUsers, createUser, setUserStatus } from "./users.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten to your Pages domain in production
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

export default {
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
