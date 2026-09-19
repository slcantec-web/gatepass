// worker/src/index.js
// Entry point. Deliberately dependency-free (no bundler/framework required) -
// a small manual router is enough for this API's surface area.

import { hashPassword, verifyPassword, createSession, getCurrentUser, requireRole, sessionCookie, clearSessionCookie } from "./auth.js";
import { writeAudit } from "./audit.js";
import { listEmployees, createEmployee, importEmployees, getEmployeeByBadgeToken, setEmployeeDepartment } from "./employees.js";
import { listLocations, createLocation, getLocationByQrToken, setLocationStatus, regenerateLocationQr } from "./locations.js";
import { createGatePass, listGatePasses, getGatePassDetails, getPassByQrToken, deleteGatePass } from "./gatepasses.js";
import { decidePass, listPendingApprovals } from "./approvals.js";
import { recordMovementEvent, getLiveStatus, resetIncompletePasses } from "./movements.js";
import { listUsers, createUser, setUserStatus, resetPassword, deleteUser, setUserDefaultLocation } from "./users.js";
import { getSettings, updateSettings } from "./settings.js";
import { listDepartments, createDepartment, updateDepartment, setDepartmentStatus } from "./departments.js";

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
          `SELECT user_id, username, password_hash, role, employee_id, status, default_location_id FROM users WHERE username = ?`
        ).bind(username).first();

        if (!userRow || userRow.status !== "ACTIVE" || !(await verifyPassword(password, userRow.password_hash))) {
          // Same generic error whether the user doesn't exist or the password is wrong.
          return json({ error: "Invalid username or password" }, 401);
        }

        const { token, expiresAt } = await createSession(env, userRow.user_id, request);
        await env.DB.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE user_id = ?`).bind(userRow.user_id).run();

        return json(
          {
            user_id: userRow.user_id,
            username: userRow.username,
            role: userRow.role,
            employee_id: userRow.employee_id,
            default_location_id: userRow.default_location_id,
            expires_at: expiresAt,
          },
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
      const userDefaultLocationMatch = path.match(/^\/api\/users\/(\d+)\/default-location$/);
      if (userDefaultLocationMatch && request.method === "PUT") {
        requireRole(user, ["SUPER_ADMIN", "ADMIN"]);
        const { location_id } = await request.json();
        return json(await setUserDefaultLocation(env, user, userDefaultLocationMatch[1], location_id, request));
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
