// worker/src/movements.js
// Implements the validation chain from spec section 26 and the atomic
// transaction pattern from section 18. D1 doesn't expose multi-statement
// interactive transactions over HTTP the way a normal SQL client would,
// but env.DB.batch() runs the statements atomically as a single unit,
// which is what we use for the "create event + update state + audit" step.
import { writeAudit } from "./audit.js";

const EVENT_TYPES = [
  "GATE_OUT", "LOCATION_IN", "LOCATION_OUT", "EXTERNAL_IN", "EXTERNAL_OUT", "RETURN", "GATE_IN", "CANCELLED",
];

// Statuses that mean "this member's part of the pass is done" - no further
// movement events are expected, and the pass can complete once every member
// is in one of these.
const TERMINAL_MEMBER_STATUSES = ["RETURNED", "CANCELLED", "LEFT_FOR_DAY"];

// Maps an event type to the pass_member status it produces. passCategory
// matters only for GATE_OUT: on a normal MOVEMENT pass, going out just means
// "currently outside" and a GATE_IN is still expected later. On an
// EARLY_LEAVE pass (a worker authorized to leave before shift end, with no
// return expected that day), the same GATE_OUT is the end of the story for
// that member - there is no return time to wait for, so it goes straight to
// a terminal status instead of OUTSIDE.
function memberStatusFor(eventType, passCategory) {
  switch (eventType) {
    case "GATE_OUT": return passCategory === "EARLY_LEAVE" ? "LEFT_FOR_DAY" : "OUTSIDE";
    case "LOCATION_IN": return "AT_INTERNAL_LOCATION";
    case "LOCATION_OUT": return "OUTSIDE";
    case "EXTERNAL_IN": return "AT_EXTERNAL_LOCATION";
    case "EXTERNAL_OUT": return "OUTSIDE";
    case "RETURN": return "OUTSIDE"; // returned to a company location, but pass not yet closed until GATE_IN
    case "GATE_IN": return "RETURNED";
    case "CANCELLED": return "CANCELLED";
    default: return null;
  }
}

// body: { pass_id, employee_id, location_id, event_type, idempotency_key }
export async function recordMovementEvent(env, user, body, request) {
  const { pass_id, employee_id, location_id, event_type, idempotency_key } = body;

  // --- Validation chain (spec section 26) ---
  if (!pass_id || !employee_id || !event_type) {
    const err = new Error("pass_id, employee_id and event_type are required");
    err.status = 400;
    throw err;
  }
  if (!EVENT_TYPES.includes(event_type)) {
    const err = new Error(`event_type must be one of: ${EVENT_TYPES.join(", ")}`);
    err.status = 400;
    throw err;
  }
  if (!idempotency_key) {
    const err = new Error("idempotency_key is required to make this request safely retryable");
    err.status = 400;
    throw err;
  }

  // SECURITY role: gate events only. EMPLOYEE role: location/external/return events for themselves.
  const gateEvents = ["GATE_OUT", "GATE_IN"];
  if (gateEvents.includes(event_type) && !["SECURITY", "ADMIN", "SUPER_ADMIN"].includes(user.role)) {
    const err = new Error("Only Security can record gate in/out events");
    err.status = 403;
    throw err;
  }
  if (!gateEvents.includes(event_type) && user.role === "EMPLOYEE" && user.employeeId !== employee_id) {
    const err = new Error("Employees can only record their own movement events");
    err.status = 403;
    throw err;
  }

  const pass = await env.DB.prepare(`SELECT * FROM gate_passes WHERE pass_id = ?`).bind(pass_id).first();
  if (!pass) {
    const err = new Error("Pass not found");
    err.status = 404;
    throw err;
  }
  if (pass.status !== "APPROVED" && pass.status !== "IN_PROGRESS") {
    const err = new Error(`Pass is not approved (status: ${pass.status})`);
    err.status = 409;
    throw err;
  }
  if (pass.pass_category === "EARLY_LEAVE" && event_type === "GATE_IN") {
    const err = new Error("This is an Early Leave pass with no return expected - there's nothing to gate in.");
    err.status = 409;
    throw err;
  }

  const member = await env.DB.prepare(
    `SELECT * FROM pass_members WHERE pass_id = ? AND employee_id = ?`
  ).bind(pass_id, employee_id).first();
  if (!member) {
    const err = new Error("Employee does not belong to this pass");
    err.status = 403;
    throw err;
  }
  if (TERMINAL_MEMBER_STATUSES.includes(member.member_status)) {
    const err = new Error(`Employee movement already closed (${member.member_status})`);
    err.status = 409;
    throw err;
  }

  // Explicit gate-event transition guard: GATE_OUT/GATE_IN each have exactly
  // one valid starting state. Without this, member_status === "OUTSIDE" was
  // never in the terminal-status check above, so a second GATE_OUT (e.g. a
  // duplicate tap that generated a fresh idempotency key) would sail through,
  // re-recording the same person as gated out twice on the same pass.
  if (event_type === "GATE_OUT" && member.member_status !== "PENDING") {
    const err = new Error(`This person has already been gated out on this pass (status: ${member.member_status}). Use Gate In instead.`);
    err.status = 409;
    throw err;
  }
  if (event_type === "GATE_IN" && member.member_status === "PENDING") {
    const err = new Error("This person hasn't been gated out yet on this pass - nothing to gate in.");
    err.status = 409;
    throw err;
  }

  // Duplicate check (level 2 - Worker API). Level 3 (DB UNIQUE constraint) is the real backstop.
  const dup = await env.DB.prepare(
    `SELECT event_id FROM movement_events WHERE pass_id = ? AND employee_id = ? AND event_type = ? AND idempotency_key = ?`
  ).bind(pass_id, employee_id, event_type, idempotency_key).first();
  if (dup) {
    // Already processed - return success idempotently rather than erroring.
    return { event_id: dup.event_id, duplicate: true };
  }

  const newMemberStatus = memberStatusFor(event_type, pass.pass_category);

  // Atomic batch: insert event + update member status + flip pass to IN_PROGRESS on first GATE_OUT.
  const stmts = [
    env.DB.prepare(
      `INSERT INTO movement_events (pass_id, employee_id, location_id, event_type, recorded_by, device_info, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(pass_id, employee_id, location_id ?? null, event_type, user.userId, request.headers.get("User-Agent") || "", idempotency_key),
    env.DB.prepare(
      `UPDATE pass_members SET member_status = ? WHERE pass_id = ? AND employee_id = ?`
    ).bind(newMemberStatus, pass_id, employee_id),
  ];

  if (event_type === "GATE_OUT" && pass.status === "APPROVED") {
    stmts.push(
      env.DB.prepare(`UPDATE gate_passes SET status = 'IN_PROGRESS', updated_at = datetime('now') WHERE pass_id = ?`).bind(pass_id)
    );
  }

  const batchResults = await env.DB.batch(stmts);
  const eventId = batchResults[0]?.meta?.last_row_id;

  await writeAudit(env, {
    userId: user.userId,
    action: `MOVEMENT_${event_type}`,
    recordType: "movement_event",
    recordId: eventId,
    details: { pass_id, employee_id, location_id },
    request,
  });

  // Check whether the whole pass can now be completed (spec section 5: must
  // NOT close until every member has resolved) - triggered any time this
  // event just put a member into a terminal state, whether that's a normal
  // GATE_IN return or a GATE_OUT on an Early Leave pass.
  if (TERMINAL_MEMBER_STATUSES.includes(newMemberStatus)) {
    await maybeCompletePass(env, pass_id, user, request);
  }

  return { event_id: eventId, member_status: newMemberStatus };
}

async function maybeCompletePass(env, passId, user, request) {
  const { results } = await env.DB.prepare(
    `SELECT member_status FROM pass_members WHERE pass_id = ?`
  ).bind(passId).all();

  const allResolved = results.every((m) => TERMINAL_MEMBER_STATUSES.includes(m.member_status));
  if (allResolved) {
    await env.DB.prepare(
      `UPDATE gate_passes SET status = 'COMPLETED', updated_at = datetime('now') WHERE pass_id = ?`
    ).bind(passId).run();
    await writeAudit(env, {
      userId: user.userId,
      action: "PASS_COMPLETED",
      recordType: "gate_pass",
      recordId: passId,
      request,
    });
  }
}

// Live status dashboard (spec section 11): calculated from each employee's
// latest movement event across all currently-active (non-completed) passes.
export async function getLiveStatus(env) {
  const { results } = await env.DB.prepare(`
    SELECT e.employee_id, e.full_name, pm.member_status, gp.pass_number, gp.expected_return
    FROM pass_members pm
    JOIN employees e ON e.employee_id = pm.employee_id
    JOIN gate_passes gp ON gp.pass_id = pm.pass_id
    WHERE gp.status IN ('APPROVED', 'IN_PROGRESS')
      AND pm.member_status NOT IN ('RETURNED', 'CANCELLED', 'LEFT_FOR_DAY')
  `).all();

  const now = Date.now();
  const outside = [];
  let overdueCount = 0;

  for (const row of results) {
    const overdue = row.expected_return && new Date(row.expected_return).getTime() < now;
    if (overdue) overdueCount++;
    outside.push({ ...row, overdue });
  }

  const totalEmployees = await env.DB.prepare(`SELECT COUNT(*) AS c FROM employees WHERE status = 'ACTIVE'`).first();

  return {
    inside: (totalEmployees?.c ?? 0) - outside.length,
    outside: outside.filter((o) => o.member_status === "OUTSIDE").length,
    at_internal_location: outside.filter((o) => o.member_status === "AT_INTERNAL_LOCATION").length,
    at_external_location: outside.filter((o) => o.member_status === "AT_EXTERNAL_LOCATION").length,
    overdue: overdueCount,
    details: outside,
  };
}

// Super Admin "clean slate" tool for the dashboard: forcibly resolves every
// pass stuck in an unfinished state instead of requiring someone to hunt
// down and manually close each one.
//  - PENDING passes (never approved) are marked REJECTED.
//  - APPROVED / IN_PROGRESS passes have every unresolved member forced to
//    CANCELLED and the pass itself marked COMPLETED, dropping it off the
//    live status dashboard. "Unresolved" here uses the same
//    TERMINAL_MEMBER_STATUSES list above, so an Early Leave member sitting
//    at LEFT_FOR_DAY is correctly left alone.
// COMPLETED and REJECTED passes are already resolved and untouched.
export async function resetIncompletePasses(env, user, request) {
  const { results: activePasses } = await env.DB.prepare(
    `SELECT pass_id, status FROM gate_passes WHERE status IN ('PENDING', 'APPROVED', 'IN_PROGRESS')`
  ).all();

  let rejectedPending = 0;
  let closedInProgress = 0;
  let clearedMembers = 0;

  for (const p of activePasses) {
    if (p.status === "PENDING") {
      await env.DB.prepare(
        `UPDATE gate_passes SET status = 'REJECTED', updated_at = datetime('now') WHERE pass_id = ?`
      ).bind(p.pass_id).run();
      rejectedPending++;
      continue;
    }

    // APPROVED or IN_PROGRESS: force every unresolved member to CANCELLED,
    // then close the pass out as COMPLETED.
    const upd = await env.DB.prepare(
      `UPDATE pass_members SET member_status = 'CANCELLED'
       WHERE pass_id = ? AND member_status NOT IN ('RETURNED', 'CANCELLED', 'LEFT_FOR_DAY')`
    ).bind(p.pass_id).run();
    clearedMembers += upd.meta?.changes || 0;

    await env.DB.prepare(
      `UPDATE gate_passes SET status = 'COMPLETED', updated_at = datetime('now') WHERE pass_id = ?`
    ).bind(p.pass_id).run();
    closedInProgress++;
  }

  await writeAudit(env, {
    userId: user.userId,
    action: "SUPER_ADMIN_RESET_DASHBOARD",
    recordType: "gate_pass",
    details: { rejectedPending, closedInProgress, clearedMembers },
    request,
  });

  return { rejected_pending: rejectedPending, closed_in_progress: closedInProgress, cleared_members: clearedMembers };
}
