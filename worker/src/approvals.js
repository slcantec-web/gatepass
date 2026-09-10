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

export async function listPendingApprovals(env) {
  const { results } = await env.DB.prepare(
    `SELECT gp.pass_id, gp.pass_number, gp.purpose, gp.created_at, e.full_name AS leader_name
     FROM gate_passes gp JOIN employees e ON e.employee_id = gp.leader_employee_id
     WHERE gp.status = 'PENDING' ORDER BY gp.created_at`
  ).all();
  return results;
}
