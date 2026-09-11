// js/api.js
// Point this at your deployed Worker URL. Left relative for local dev via
// wrangler's `--local` proxy, or set API_BASE to the full Workers URL once deployed.
const API_BASE = window.GATEPASS_API_BASE || "/api";

async function apiRequest(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include", // send the HttpOnly session cookie
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // no body
  }

  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const Api = {
  login: (username, password) => apiRequest("/auth/login", { method: "POST", body: { username, password } }),
  logout: () => apiRequest("/auth/logout", { method: "POST" }),
  me: () => apiRequest("/auth/me"),

  listEmployees: () => apiRequest("/employees"),
  createEmployee: (emp) => apiRequest("/employees", { method: "POST", body: emp }),
  importEmployees: (rows) => apiRequest("/employees/import", { method: "POST", body: { rows } }),

  listLocations: () => apiRequest("/locations"),
  createLocation: (loc) => apiRequest("/locations", { method: "POST", body: loc }),

  listGatePasses: () => apiRequest("/gatepasses"),
  createGatePass: (pass) => apiRequest("/gatepasses", { method: "POST", body: pass }),
  getGatePass: (id) => apiRequest(`/gatepasses/${id}`),

  listPendingApprovals: () => apiRequest("/approvals/pending"),
  decidePass: (id, decision, comments) => apiRequest(`/gatepasses/${id}/decision`, { method: "POST", body: { decision, comments } }),

  recordMovement: (event) => apiRequest("/movements", { method: "POST", body: event }),
  liveStatus: () => apiRequest("/movements/live"),

  auditLog: () => apiRequest("/audit"),

  listUsers: () => apiRequest("/users"),
  createUser: (u) => apiRequest("/users", { method: "POST", body: u }),
  setUserStatus: (id, status) => apiRequest(`/users/${id}/status`, { method: "PUT", body: { status } }),
  resetPassword: (id, newPassword) => apiRequest(`/users/${id}/password`, { method: "PUT", body: { new_password: newPassword } }),

  resolveQr: (token) => apiRequest(`/qr/${encodeURIComponent(token)}`),

  // System Settings (Super Admin panel: js/settings.js, and read by js/gatepass.js
  // for the print-slip paper size). Backed by worker/src/settings.js.
  getSettings: () => apiRequest("/settings"),
  updateSettings: (settings) => apiRequest("/settings", { method: "PUT", body: settings }),
};

window.Api = Api;

// A stable per-tab-session idempotency key generator for movement transactions
// (spec section 17, level 1/2: prevents double-submit from creating duplicate events).
window.newIdempotencyKey = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
