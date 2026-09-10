-- Gate Pass & Employee Movement Management System
-- Cloudflare D1 schema

PRAGMA foreign_keys = ON;

-- ============================================================
-- COMPANIES / DEPARTMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS companies (
  company_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  company_code    TEXT UNIQUE NOT NULL,
  company_name    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS departments (
  department_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id          INTEGER REFERENCES companies(company_id),
  department_code     TEXT NOT NULL,
  department_name     TEXT NOT NULL,
  hod_employee_id     INTEGER, -- FK to employees, added after employees table exists (see below)
  status              TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(company_id, department_code)
);

-- ============================================================
-- EMPLOYEES
-- ============================================================

CREATE TABLE IF NOT EXISTS employees (
  employee_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_code         TEXT UNIQUE NOT NULL,       -- e.g. EMP001
  full_name        TEXT NOT NULL,
  company_id       INTEGER REFERENCES companies(company_id),
  department_id    INTEGER REFERENCES departments(department_id),
  hod_employee_id  INTEGER REFERENCES employees(employee_id),
  designation      TEXT,
  phone            TEXT,
  email            TEXT,
  -- future SAP B1 sync hooks (section 21) -- not mandatory for v1
  sap_employee_id  TEXT,
  sap_company      TEXT,
  badge_qr_token   TEXT UNIQUE,   -- printed on a physical ID badge; scanned by security/staff on the driver's behalf
  status           TEXT NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE / INACTIVE
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department_id);
CREATE INDEX IF NOT EXISTS idx_employees_hod ON employees(hod_employee_id);

-- ============================================================
-- USERS / AUTH / SESSIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  user_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username         TEXT UNIQUE NOT NULL,
  password_hash    TEXT NOT NULL,     -- PBKDF2 hash, format: iterations$salt_hex$hash_hex
  role             TEXT NOT NULL,     -- SUPER_ADMIN / ADMIN / HOD / EMPLOYEE / SECURITY / MANAGEMENT_VIEWER
  employee_id      INTEGER REFERENCES employees(employee_id),
  status           TEXT NOT NULL DEFAULT 'ACTIVE',
  last_login_at    TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  session_token    TEXT PRIMARY KEY,       -- random opaque token, stored in HttpOnly cookie
  user_id          INTEGER NOT NULL REFERENCES users(user_id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at       TEXT NOT NULL,
  ip_address       TEXT,
  device_info      TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ============================================================
-- LOCATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS locations (
  location_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  location_code     TEXT UNIQUE NOT NULL,
  location_name     TEXT NOT NULL,
  company_id        INTEGER REFERENCES companies(company_id),
  location_type     TEXT NOT NULL,   -- HEAD_OFFICE / FACTORY / WAREHOUSE / BRANCH / INTERNAL / CUSTOMER / SUPPLIER / EXTERNAL / OTHER
  address           TEXT,
  latitude          REAL,
  longitude         REAL,
  geofence_radius   REAL,            -- meters, optional
  qr_code_token     TEXT UNIQUE,     -- opaque token encoded into the location's QR code
  status            TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_locations_type ON locations(location_type);

-- ============================================================
-- GATE PASSES (Movement Pass) / PASS MEMBERS / ROUTE
-- ============================================================

CREATE TABLE IF NOT EXISTS gate_passes (
  pass_id             INTEGER PRIMARY KEY AUTOINCREMENT,
  pass_number         TEXT UNIQUE NOT NULL,     -- e.g. MP-20260909-0001
  leader_employee_id  INTEGER NOT NULL REFERENCES employees(employee_id),
  from_location_id    INTEGER NOT NULL REFERENCES locations(location_id),
  purpose             TEXT NOT NULL,
  expected_departure  TEXT,
  expected_return     TEXT,
  pass_type           TEXT NOT NULL DEFAULT 'GROUP',  -- SINGLE / GROUP
  status              TEXT NOT NULL DEFAULT 'PENDING', -- PENDING / APPROVED / REJECTED / IN_PROGRESS / COMPLETED / CANCELLED
  qr_code_token       TEXT UNIQUE,
  created_by          INTEGER NOT NULL REFERENCES users(user_id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gate_passes_status ON gate_passes(status);
CREATE INDEX IF NOT EXISTS idx_gate_passes_leader ON gate_passes(leader_employee_id);

-- Workers included in a pass, each with an INDEPENDENT status.
-- A pass cannot be marked COMPLETED while any member is not RETURNED/CANCELLED (enforced in Worker logic).
CREATE TABLE IF NOT EXISTS pass_members (
  pass_member_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  pass_id          INTEGER NOT NULL REFERENCES gate_passes(pass_id),
  employee_id      INTEGER NOT NULL REFERENCES employees(employee_id),
  member_status    TEXT NOT NULL DEFAULT 'PENDING',
    -- PENDING / OUTSIDE / AT_INTERNAL_LOCATION / AT_EXTERNAL_LOCATION / RETURNED / OVERDUE / CANCELLED
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(pass_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_pass_members_pass ON pass_members(pass_id);
CREATE INDEX IF NOT EXISTS idx_pass_members_employee ON pass_members(employee_id);

-- Planned route (ordered list of destination locations) for a pass.
CREATE TABLE IF NOT EXISTS pass_routes (
  route_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  pass_id        INTEGER NOT NULL REFERENCES gate_passes(pass_id),
  sequence_no    INTEGER NOT NULL,
  location_id    INTEGER NOT NULL REFERENCES locations(location_id),
  UNIQUE(pass_id, sequence_no)
);

-- ============================================================
-- MOVEMENT EVENTS (actual recorded movements)
-- ============================================================

CREATE TABLE IF NOT EXISTS movement_events (
  event_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pass_id           INTEGER NOT NULL REFERENCES gate_passes(pass_id),
  employee_id       INTEGER NOT NULL REFERENCES employees(employee_id),
  location_id       INTEGER REFERENCES locations(location_id),
  event_type        TEXT NOT NULL,
    -- GATE_OUT / LOCATION_IN / LOCATION_OUT / EXTERNAL_IN / EXTERNAL_OUT / RETURN / GATE_IN / CANCELLED
  event_time        TEXT NOT NULL DEFAULT (datetime('now')),
  recorded_by       INTEGER NOT NULL REFERENCES users(user_id),  -- security/employee/admin who recorded it
  device_info       TEXT,
  idempotency_key   TEXT NOT NULL,  -- client-generated key to make retries safe
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(pass_id, employee_id, event_type, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_movement_events_pass ON movement_events(pass_id);
CREATE INDEX IF NOT EXISTS idx_movement_events_employee ON movement_events(employee_id, event_time);

-- ============================================================
-- APPROVALS
-- ============================================================

CREATE TABLE IF NOT EXISTS approvals (
  approval_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  pass_id         INTEGER NOT NULL REFERENCES gate_passes(pass_id),
  approver_id     INTEGER NOT NULL REFERENCES users(user_id),
  decision        TEXT NOT NULL,    -- APPROVED / REJECTED
  comments        TEXT,
  decided_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_approvals_pass ON approvals(pass_id);

-- ============================================================
-- AUDIT LOG (append-only; never edited/deleted through the UI)
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER REFERENCES users(user_id),
  action        TEXT NOT NULL,        -- e.g. HOD_APPROVED_PASS, SECURITY_GATE_OUT, ADMIN_IMPORTED_EMPLOYEES
  record_type   TEXT,                 -- e.g. gate_pass, employee, movement_event
  record_id     TEXT,
  details       TEXT,                 -- free-form JSON string
  ip_address    TEXT,
  device_info   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_record ON audit_log(record_type, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, created_at);

-- ============================================================
-- SYSTEM SETTINGS
-- ============================================================

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key    TEXT PRIMARY KEY,
  setting_value  TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- SEED: default super admin (username: admin / password: ChangeMe123!)
-- Password hash below is a placeholder - regenerate with worker/src/auth.js hashPassword()
-- and replace before deploying. Do NOT ship this literal hash to production.
-- ============================================================

INSERT OR IGNORE INTO companies (company_id, company_code, company_name) VALUES (1, 'HQ', 'Head Office');
