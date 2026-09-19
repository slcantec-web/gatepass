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

export async function hashPassword(password) {
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

export async function verifyPassword(password, stored) {
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

export function randomToken(bytes = 32) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function parseCookies(request) {
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

export function sessionCookie(token, maxAgeSeconds) {
  // Secure + HttpOnly + SameSite=Lax: frontend and API are subdomains of the
  // same registrable domain, so this is a same-site cookie and Lax is the
  // standard, safest choice. (Switch to SameSite=None if you ever split the
  // frontend onto a fully different registrable domain.)
  return `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie() {
  return `session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function createSession(env, userId, request) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ua = request.headers.get("User-Agent") || "";
  await env.DB.prepare(
    `INSERT INTO sessions (session_token, user_id, expires_at, ip_address, device_info) VALUES (?, ?, ?, ?, ?)`
  ).bind(token, userId, expiresAt, ip, ua).run();
  return { token, expiresAt };
}

// Resolves the current user from the session cookie, or null. Carries
// default_location_id through so SECURITY logins stationed at one gate can
// have their movement events auto-tagged with that location without the
// frontend needing a second round trip.
export async function getCurrentUser(env, request) {
  const cookies = parseCookies(request);
  const token = cookies["session"];
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT s.session_token, s.expires_at, u.user_id, u.username, u.role, u.employee_id, u.status, u.default_location_id
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
    defaultLocationId: row.default_location_id,
    sessionToken: row.session_token,
  };
}

// Simple RBAC guard: throws a Response-like error object the router can catch.
export function requireRole(user, allowedRoles) {
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
