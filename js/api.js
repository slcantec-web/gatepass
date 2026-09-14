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
  setEmployeeDepartment: (id, departmentId) => apiRequest(`/employees/${id}/department`, { method: "PUT", body: { department_id: departmentId } }),

  listDepartments: () => apiRequest("/departments"),
  createDepartment: (dept) => apiRequest("/departments", { method: "POST", body: dept }),
  updateDepartment: (id, dept) => apiRequest(`/departments/${id}`, { method: "PUT", body: dept }),
  setDepartmentStatus: (id, status) => apiRequest(`/departments/${id}/status`, { method: "PUT", body: { status } }),

  listLocations: () => apiRequest("/locations"),
  createLocation: (loc) => apiRequest("/locations", { method: "POST", body: loc }),

  listGatePasses: () => apiRequest("/gatepasses"),
  createGatePass: (pass) => apiRequest("/gatepasses", { method: "POST", body: pass }),
  getGatePass: (id) => apiRequest(`/gatepasses/${id}`),
  // Owner can delete their own PENDING/REJECTED pass; a Super Admin can delete
  // any pass that isn't COMPLETED. Backed by DELETE /api/gatepasses/:id in
  // worker/src/gatepasses.js (deleteGatePass) - the server is the source of
  // truth on who's actually allowed; the frontend just hides the button when
  // it already knows the call would be rejected.
  deleteGatePass: (id) => apiRequest(`/gatepasses/${id}`, { method: "DELETE" }),

  listPendingApprovals: () => apiRequest("/approvals/pending"),
  decidePass: (id, decision, comments) => apiRequest(`/gatepasses/${id}/decision`, { method: "POST", body: { decision, comments } }),

  recordMovement: (event) => apiRequest("/movements", { method: "POST", body: event }),
  liveStatus: () => apiRequest("/movements/live"),
  // Super Admin "clean slate" tool for the dashboard: force-resolves every
  // pass stuck PENDING/APPROVED/IN_PROGRESS (PENDING -> REJECTED, the rest ->
  // COMPLETED with unresolved members CANCELLED). Backed by POST
  // /api/movements/reset (resetIncompletePasses) in worker/src/movements.js.
  resetDashboard: () => apiRequest("/movements/reset", { method: "POST" }),

  auditLog: () => apiRequest("/audit"),

  listUsers: () => apiRequest("/users"),
  createUser: (u) => apiRequest("/users", { method: "POST", body: u }),
  setUserStatus: (id, status) => apiRequest(`/users/${id}/status`, { method: "PUT", body: { status } }),
  resetPassword: (id, newPassword) => apiRequest(`/users/${id}/password`, { method: "PUT", body: { new_password: newPassword } }),
  // Hard delete - only succeeds if the account has no audit-trail history
  // (no gate passes created, movements recorded, or approvals made). The
  // backend blocks it otherwise and tells you to deactivate instead.
  deleteUser: (id) => apiRequest(`/users/${id}`, { method: "DELETE" }),

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

// member_status only changes when a physical gate/location event is recorded -
// it does NOT track pass approval. So every member sits at "PENDING" from the
// moment the pass is created, all the way through HOD approval, right up until
// Security scans them out at the gate. That reads as "stuck"/broken if shown
// verbatim, so this maps the same underlying value to a clearer label based on
// where the *pass* itself is in its own approval lifecycle, without touching
// the stored data.
window.formatMemberStatus = function formatMemberStatus(passStatus, memberStatus) {
  if (memberStatus === "PENDING") {
    if (passStatus === "PENDING") return "Awaiting HOD Approval";
    if (passStatus === "REJECTED") return "Pass Rejected";
    if (passStatus === "APPROVED" || passStatus === "IN_PROGRESS") return "Approved - Awaiting Gate Out";
  }
  if (memberStatus === "LEFT_FOR_DAY") return "Left for the Day (Early Leave)";
  return memberStatus.replace(/_/g, " ");
};
