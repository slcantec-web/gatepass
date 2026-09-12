// worker/src/departments.js
// Department Master. Departments already existed in the schema (employees
// and users have carried department_id/hod_employee_id from the start) but
// never had a dedicated management screen - HOD-scoped approvals depend on
// this data being complete and correct, so it needs to be first-class and
// editable, not just something admins insert manually into D1.

import { writeAudit } from "./audit.js";

export async function listDepartments(env) {
  const { results } = await env.DB.prepare(
    `SELECT d.department_id, d.company_id, d.department_code, d.department_name, d.status,
            d.hod_employee_id, e.full_name AS hod_name,
            (SELECT COUNT(*) FROM employees emp WHERE emp.department_id = d.department_id AND emp.status = 'ACTIVE') AS employee_count
     FROM departments d LEFT JOIN employees e ON e.employee_id = d.hod_employee_id
     ORDER BY d.department_name`
  ).all();
  return results;
}

export async function createDepartment(env, user, body, request) {
  const { department_code, department_name, hod_employee_id, company_id } = body;
  if (!department_code || !department_name) {
    const err = new Error("department_code and department_name are required");
    err.status = 400;
    throw err;
  }

  const existing = await env.DB.prepare(
    `SELECT department_id FROM departments WHERE department_code = ? AND (company_id IS ? OR company_id = ?)`
  ).bind(department_code, company_id ?? null, company_id ?? null).first();
  if (existing) {
    const err = new Error(`${department_code} already exists`);
    err.status = 409;
    throw err;
  }

  const result = await env.DB.prepare(
    `INSERT INTO departments (company_id, department_code, department_name, hod_employee_id) VALUES (?, ?, ?, ?)`
  ).bind(company_id ?? 1, department_code, department_name, hod_employee_id ?? null).run();

  await writeAudit(env, {
    userId: user.userId,
    action: "ADMIN_CREATED_DEPARTMENT",
    recordType: "department",
    recordId: result.meta.last_row_id,
    details: { department_code, department_name },
    request,
  });

  return { department_id: result.meta.last_row_id };
}

// Editable: name and who heads it. department_code is left alone once set -
// changing a code silently would be confusing anywhere it's referenced in
// history/audit text, so treat it as immutable and have people create a new
// department instead if a code was genuinely wrong.
export async function updateDepartment(env, user, departmentId, body, request) {
  const { department_name, hod_employee_id } = body;

  const department = await env.DB.prepare(`SELECT department_id FROM departments WHERE department_id = ?`)
    .bind(departmentId).first();
  if (!department) {
    const err = new Error("Department not found");
    err.status = 404;
    throw err;
  }
  if (!department_name) {
    const err = new Error("department_name is required");
    err.status = 400;
    throw err;
  }

  await env.DB.prepare(`UPDATE departments SET department_name = ?, hod_employee_id = ? WHERE department_id = ?`)
    .bind(department_name, hod_employee_id ?? null, departmentId).run();

  await writeAudit(env, {
    userId: user.userId,
    action: "ADMIN_UPDATED_DEPARTMENT",
    recordType: "department",
    recordId: departmentId,
    details: { department_name, hod_employee_id: hod_employee_id ?? null },
    request,
  });

  return { department_id: Number(departmentId) };
}

// Soft delete (status -> INACTIVE), same reasoning as locations: employees
// reference departments by department_id, so a real DELETE risks either an
// FK failure or silently orphaning people's department assignment. Blocked
// if active employees are still assigned, so you can't "delete" a department
// out from under a staffed team by mistake.
export async function setDepartmentStatus(env, user, departmentId, status, request) {
  if (!["ACTIVE", "INACTIVE"].includes(status)) {
    const err = new Error("status must be ACTIVE or INACTIVE");
    err.status = 400;
    throw err;
  }

  const department = await env.DB.prepare(`SELECT department_id, department_name FROM departments WHERE department_id = ?`)
    .bind(departmentId).first();
  if (!department) {
    const err = new Error("Department not found");
    err.status = 404;
    throw err;
  }

  if (status === "INACTIVE") {
    const staffed = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM employees WHERE department_id = ? AND status = 'ACTIVE'`
    ).bind(departmentId).first();
    if ((staffed?.c ?? 0) > 0) {
      const err = new Error(`Cannot delete: ${staffed.c} active employee(s) are still assigned to this department`);
      err.status = 409;
      throw err;
    }
  }

  await env.DB.prepare(`UPDATE departments SET status = ? WHERE department_id = ?`).bind(status, departmentId).run();

  await writeAudit(env, {
    userId: user.userId,
    action: status === "ACTIVE" ? "ADMIN_RESTORED_DEPARTMENT" : "ADMIN_DELETED_DEPARTMENT",
    recordType: "department",
    recordId: departmentId,
    details: { department_name: department.department_name },
    request,
  });

  return { department_id: Number(departmentId), status };
}
