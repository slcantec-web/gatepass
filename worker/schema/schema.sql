/* Gate Pass & Employee Movement Management System - Cloudflare D1 schema */

PRAGMA foreign_keys = ON;

/* COMPANIES / DEPARTMENTS */

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
  hod_employee_id     INTEGER,
  status              TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(company_id, department_code)
);

/* EMPLOYEES */

CREATE TABLE IF NOT EXISTS employees (
  employee_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_code         TEXT UNIQUE NOT NULL,
  full_name        TEXT NOT NULL,
  company_id       INTEGER REFERENCES companies(company_id),
  department_id    INTEGER REFERENCES departments(department_id),
  hod_employee_id  INTEGER REFERENCES employees(employee_id),
  designation      TEXT,
  phone            TEXT,
  email            TEXT,
  sap_employee_id  TEXT,
  sap_company      TEXT,
  badge_qr_token   TEXT UNIQUE,
  status           TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department_id);
CREATE INDEX IF NOT EXISTS idx_employees_hod ON employees(hod_employee_id);

/* USERS / AUTH / SESSIONS */

CREATE TABLE IF NOT EXISTS users (
  user_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username         TEXT UNIQUE NOT NULL,
  password_hash    TEXT NOT NULL,
  role             TEXT NOT NULL,
  employee_id      INTEGER REFERENCES employees(employee_id),
  status           TEXT NOT NULL DEFAULT 'ACTIVE',
  last_login_at    TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  session_token    TEXT PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(user_id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at       TEXT NOT NULL,
  ip_address       TEXT,
  device_info      TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

/* LOCATIONS */

CREATE TABLE IF NOT EXISTS locations (
  location_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  location_code     TEXT UNIQUE NOT NULL,
  location_name     TEXT NOT NULL,
  company_id        INTEGER REFERENCES companies(company_id),
  location_type     TEXT NOT NULL,
  address           TEXT,
  latitude          REAL,
  longitude         REAL,
  geofence_radius   REAL,
  qr_code_token     TEXT UNIQUE,
  status            TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_locations_type ON locations(location_type);

/* GATE PASSES (Movement Pass) / PASS MEMBERS / ROUTE */

CREATE TABLE IF NOT EXISTS gate_passes (
  pass_id             INTEGER PRIMARY KEY AUTOINCREMENT,
  pass_number         TEXT UNIQUE NOT NULL,
  leader_employee_id  INTEGER NOT NULL REFERENCES employees(employee_id),
  from_location_id    INTEGER NOT NULL REFERENCES locations(location_id),
  purpose             TEXT NOT NULL,
  destination_note    TEXT,
  expected_departure  TEXT,
  expected_return     TEXT,
  pass_type           TEXT NOT NULL DEFAULT 'GROUP',
  status              TEXT NOT NULL DEFAULT 'PENDING',
  qr_code_token       TEXT UNIQUE,
  created_by          INTEGER NOT NULL REFERENCES users(user_id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gate_passes_status ON gate_passes(status);
CREATE INDEX IF NOT EXISTS idx_gate_passes_leader ON gate_passes(leader_employee_id);

CREATE TABLE IF NOT EXISTS pass_members (
  pass_member_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  pass_id          INTEGER NOT NULL REFERENCES gate_passes(pass_id),
  employee_id      INTEGER NOT NULL REFERENCES employees(employee_id),
  member_status    TEXT NOT NULL DEFAULT 'PENDING',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(pass_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_pass_members_pass ON pass_members(pass_id);
CREATE INDEX IF NOT EXISTS idx_pass_members_employee ON pass_members(employee_id);

CREATE TABLE IF NOT EXISTS pass_routes (
  route_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  pass_id        INTEGER NOT NULL REFERENCES gate_passes(pass_id),
  sequence_no    INTEGER NOT NULL,
  location_id    INTEGER NOT NULL REFERENCES locations(location_id),
  UNIQUE(pass_id, sequence_no)
);

/* MOVEMENT EVENTS (actual recorded movements) */

CREATE TABLE IF NOT EXISTS movement_events (
  event_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pass_id           INTEGER NOT NULL REFERENCES gate_passes(pass_id),
  employee_id       INTEGER NOT NULL REFERENCES employees(employee_id),
  location_id       INTEGER REFERENCES locations(location_id),
  event_type        TEXT NOT NULL,
  event_time        TEXT NOT NULL DEFAULT (datetime('now')),
  recorded_by       INTEGER NOT NULL REFERENCES users(user_id),
  device_info       TEXT,
  idempotency_key   TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(pass_id, employee_id, event_type, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_movement_events_pass ON movement_events(pass_id);
CREATE INDEX IF NOT EXISTS idx_movement_events_employee ON movement_events(employee_id, event_time);

/* APPROVALS */

CREATE TABLE IF NOT EXISTS approvals (
  approval_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  pass_id         INTEGER NOT NULL REFERENCES gate_passes(pass_id),
  approver_id     INTEGER NOT NULL REFERENCES users(user_id),
  decision        TEXT NOT NULL,
  comments        TEXT,
  decided_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_approvals_pass ON approvals(pass_id);

/* AUDIT LOG (append-only; never edited/deleted through the UI) */

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER REFERENCES users(user_id),
  action        TEXT NOT NULL,
  record_type   TEXT,
  record_id     TEXT,
  details       TEXT,
  ip_address    TEXT,
  device_info   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_record ON audit_log(record_type, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, created_at);

/* SYSTEM SETTINGS */

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key    TEXT PRIMARY KEY,
  setting_value  TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

/* Seed row - safe to run every time, no password hash included here.
   Create your admin login separately with a real INSERT INTO users ... statement. */

INSERT OR IGNORE INTO companies (company_id, company_code, company_name) VALUES (1, 'HQ', 'Head Office');
