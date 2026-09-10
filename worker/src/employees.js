// worker/src/employees.js
import { writeAudit } from "./audit.js";
import { randomToken } from "./auth.js";

export async function listEmployees(env) {
  const { results } = await env.DB.prepare(
    `SELECT employee_id, emp_code, full_name, department_id, hod_employee_id, designation, phone, email, status, badge_qr_token
     FROM employees ORDER BY full_name`
  ).all();
  return results;
}

export async function createEmployee(env, user, body, request) {
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
export async function importEmployees(env, user, rows, request) {
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

export async function getEmployeeByBadgeToken(env, token) {
  return env.DB.prepare(
    `SELECT employee_id, emp_code, full_name, status FROM employees WHERE badge_qr_token = ? AND status = 'ACTIVE'`
  ).bind(token).first();
}
