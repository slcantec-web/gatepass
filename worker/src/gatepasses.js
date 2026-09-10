// worker/src/gatepasses.js
import { randomToken } from "./auth.js";
import { writeAudit } from "./audit.js";

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

async function nextPassNumber(env) {
  const stamp = todayStamp();
  const prefix = `MP-${stamp}-`;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM gate_passes WHERE pass_number LIKE ?`
  ).bind(`${prefix}%`).first();
  const seq = String((row?.c ?? 0) + 1).padStart(4, "0");
  return `${prefix}${seq}`;
}

// body: { leader_employee_id, from_location_id, purpose, expected_departure, expected_return,
//         member_employee_ids: [...], route_location_ids: [...] }
export async function createGatePass(env, user, body, request) {
  const {
    leader_employee_id, from_location_id, purpose,
    expected_departure, expected_return,
    member_employee_ids = [], route_location_ids = [],
  } = body;

  if (!leader_employee_id || !from_location_id || !purpose) {
    const err = new Error("leader_employee_id, from_location_id and purpose are required");
    err.status = 400;
    throw err;
  }

  // Leader is always a member too.
  const allMembers = Array.from(new Set([leader_employee_id, ...member_employee_ids]));
  const passNumber = await nextPassNumber(env);
  const qrToken = randomToken(16);
  const passType = allMembers.length > 1 ? "GROUP" : "SINGLE";

  const passResult = await env.DB.prepare(
    `INSERT INTO gate_passes (pass_number, leader_employee_id, from_location_id, purpose, expected_departure, expected_return, pass_type, status, qr_code_token, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`
  ).bind(passNumber, leader_employee_id, from_location_id, purpose, expected_departure ?? null, expected_return ?? null, passType, qrToken, user.userId).run();

  const passId = passResult.meta.last_row_id;

  for (const empId of allMembers) {
    await env.DB.prepare(
      `INSERT INTO pass_members (pass_id, employee_id, member_status) VALUES (?, ?, 'PENDING')`
    ).bind(passId, empId).run();
  }

  for (const [i, locId] of route_location_ids.entries()) {
    await env.DB.prepare(
      `INSERT INTO pass_routes (pass_id, sequence_no, location_id) VALUES (?, ?, ?)`
    ).bind(passId, i + 1, locId).run();
  }

  await writeAudit(env, {
    userId: user.userId,
    action: "EMPLOYEE_CREATED_PASS",
    recordType: "gate_pass",
    recordId: passId,
    details: { pass_number: passNumber, member_count: allMembers.length },
    request,
  });

  return { pass_id: passId, pass_number: passNumber, qr_code_token: qrToken };
}

export async function getPassByQrToken(env, token) {
  const pass = await env.DB.prepare(
    `SELECT pass_id, pass_number, purpose, status FROM gate_passes WHERE qr_code_token = ?`
  ).bind(token).first();
  if (!pass) return null;

  const { results: members } = await env.DB.prepare(
    `SELECT pm.employee_id, e.emp_code, e.full_name, pm.member_status
     FROM pass_members pm JOIN employees e ON e.employee_id = pm.employee_id
     WHERE pm.pass_id = ?`
  ).bind(pass.pass_id).all();

  return { ...pass, members };
}

export async function listGatePasses(env, user) {
  // Employees see only their own passes (as leader or member); HOD/Admin/Management see all.
  if (["EMPLOYEE"].includes(user.role)) {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT gp.pass_id, gp.pass_number, gp.purpose, gp.status, gp.created_at
       FROM gate_passes gp
       LEFT JOIN pass_members pm ON pm.pass_id = gp.pass_id
       WHERE gp.leader_employee_id = ? OR pm.employee_id = ?
       ORDER BY gp.created_at DESC`
    ).bind(user.employeeId, user.employeeId).all();
    return results;
  }

  const { results } = await env.DB.prepare(
    `SELECT pass_id, pass_number, purpose, status, created_at FROM gate_passes ORDER BY created_at DESC LIMIT 200`
  ).all();
  return results;
}

export async function getGatePassDetails(env, passId) {
  const pass = await env.DB.prepare(`SELECT * FROM gate_passes WHERE pass_id = ?`).bind(passId).first();
  if (!pass) {
    const err = new Error("Pass not found");
    err.status = 404;
    throw err;
  }

  const { results: members } = await env.DB.prepare(
    `SELECT pm.pass_member_id, pm.employee_id, e.full_name, e.emp_code, pm.member_status
     FROM pass_members pm JOIN employees e ON e.employee_id = pm.employee_id
     WHERE pm.pass_id = ?`
  ).bind(passId).all();

  const { results: route } = await env.DB.prepare(
    `SELECT pr.sequence_no, pr.location_id, l.location_name, l.location_type
     FROM pass_routes pr JOIN locations l ON l.location_id = pr.location_id
     WHERE pr.pass_id = ? ORDER BY pr.sequence_no`
  ).bind(passId).all();

  const { results: events } = await env.DB.prepare(
    `SELECT me.event_id, me.employee_id, e.full_name, me.location_id, l.location_name, me.event_type, me.event_time
     FROM movement_events me
     JOIN employees e ON e.employee_id = me.employee_id
     LEFT JOIN locations l ON l.location_id = me.location_id
     WHERE me.pass_id = ? ORDER BY me.event_time`
  ).bind(passId).all();

  return { pass, members, route, events };
}
