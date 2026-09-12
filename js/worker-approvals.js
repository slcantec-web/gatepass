// worker/src/approvals.js

import { writeAudit } from "./audit.js";

export async function decidePass(env, user, passId, decision, comments, request) {
  if (!["APPROVED", "REJECTED"].includes(decision)) {
    const err = new Error("decision must be APPROVED or REJECTED");
    err.status = 400;
    throw err;
  }

  const pass = await env.DB.prepare(`SELECT * FROM gate_passes WHERE pass_id = ?`).bind(passId).first();
  if (!pass) {
    const err = new Error("Pass not found");
    err.status = 404;
    throw err;
  }
  if (pass.status !== "PENDING") {
    const err = new Error(`Pass is already ${pass.status}`);
    err.status = 409;
    throw err;
  }

  // A HOD may only decide on passes led by someone in their own department.
  // SUPER_ADMIN/ADMIN bypass this and can approve anything. This is enforced
  // here (not just by filtering what the HOD's approvals list shows) so a
  // HOD can't approve an out-of-department pass by calling the API directly
  // with a pass_id they weren't shown.
  if (user.role === "HOD") {
    const [hodEmployee, leader] = await Promise.all([
      env.DB.prepare(`SELECT department_id FROM employees WHERE employee_id = ?`).bind(user.employeeId).first(),
      env.DB.prepare(`SELECT department_id FROM employees WHERE employee_id = ?`).bind(pass.leader_employee_id).first(),
    ]);
    if (!hodEmployee?.department_id || !leader?.department_id || hodEmployee.department_id !== leader.department_id) {
      const err = new Error("You can only approve gate passes for your own department");
      err.status = 403;
      throw err;
    }
  }

  await env.DB.prepare(
    `INSERT INTO approvals (pass_id, approver_id, decision, comments) VALUES (?, ?, ?, ?)`
  ).bind(passId, user.userId, decision, comments ?? null).run();

  const newStatus = decision === "APPROVED" ? "APPROVED" : "REJECTED";
  await env.DB.prepare(
    `UPDATE gate_passes SET status = ?, updated_at = datetime('now') WHERE pass_id = ?`
  ).bind(newStatus, passId).run();

  await writeAudit(env, {
    userId: user.userId,
    action: decision === "APPROVED" ? "HOD_APPROVED_PASS" : "HOD_REJECTED_PASS",
    recordType: "gate_pass",
    recordId: passId,
    details: { comments },
    request,
  });

  return { pass_id: passId, status: newStatus };
}

// SUPER_ADMIN/ADMIN see every pending pass. A HOD only sees passes led by
// someone in their own department (looked up from their own linked employee
// record) - and if that HOD's employee record has no department set, they
// see nothing rather than everything: fail closed, not open.
export async function listPendingApprovals(env, user) {
  let departmentFilter = null;
  if (user.role === "HOD") {
    const hodEmployee = await env.DB.prepare(`SELECT department_id FROM employees WHERE employee_id = ?`)
      .bind(user.employeeId).first();
    departmentFilter = hodEmployee?.department_id ?? null;
    if (!departmentFilter) return [];
  }

  const query = `SELECT gp.pass_id, gp.pass_number, gp.purpose, gp.created_at, e.full_name AS leader_name, d.department_name AS leader_department
                 FROM gate_passes gp
                 JOIN employees e ON e.employee_id = gp.leader_employee_id
                 LEFT JOIN departments d ON d.department_id = e.department_id
                 WHERE gp.status = 'PENDING' ${departmentFilter ? "AND e.department_id = ?" : ""}
                 ORDER BY gp.created_at`;
  const stmt = departmentFilter ? env.DB.prepare(query).bind(departmentFilter) : env.DB.prepare(query);
  const { results } = await stmt.all();
  return results;
}
