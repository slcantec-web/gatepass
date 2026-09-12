// worker/src/employees.js

import { randomToken } from "./auth.js";
import { writeAudit } from "./audit.js";

export async function listEmployees(env) {
  const { results } = await env.DB.prepare(
    `SELECT e.employee_id, e.emp_code, e.full_name, e.department_id, d.department_name, e.hod_employee_id, e.designation, e.phone, e.email, e.status, e.badge_qr_token
     FROM employees e LEFT JOIN departments d ON d.department_id = e.department_id
     ORDER BY e.full_name`
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

// Assigns/changes which department an existing employee belongs to. Split out
// as its own small endpoint (same pattern as /status, /password elsewhere)
// rather than a full "edit employee" form, since department is the one field
// that needs to be correctable after the fact - HOD approval scoping and the
// department roster both depend on every employee actually having one set.
export async function setEmployeeDepartment(env, user, employeeId, departmentId, request) {
  const employee = await env.DB.prepare(`SELECT employee_id, full_name FROM employees WHERE employee_id = ?`)
    .bind(employeeId).first();
  if (!employee) {
    const err = new Error("Employee not found");
    err.status = 404;
    throw err;
  }

  if (departmentId != null) {
    const dept = await env.DB.prepare(`SELECT department_id FROM departments WHERE department_id = ?`)
      .bind(departmentId).first();
    if (!dept) {
      const err = new Error("Department not found");
      err.status = 404;
      throw err;
    }
  }

  await env.DB.prepare(`UPDATE employees SET department_id = ?, updated_at = datetime('now') WHERE employee_id = ?`)
    .bind(departmentId ?? null, employeeId).run();

  await writeAudit(env, {
    userId: user.userId,
    action: "ADMIN_UPDATED_EMPLOYEE_DEPARTMENT",
    recordType: "employee",
    recordId: employeeId,
    details: { full_name: employee.full_name, department_id: departmentId ?? null },
    request,
  });

  return { employee_id: Number(employeeId), department_id: departmentId ?? null };
}
