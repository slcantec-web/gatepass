// js/movementcheck.js
// One screen for every kind of movement event, instead of three separate
// tabs (Security Gate Out, Security Gate In, Location Check, Assisted Check)
// that all boiled down to the same Api.recordMovement() call with different
// pre-filled roles. What you see here adapts to who's logged in:
//   - EMPLOYEE: Location/External/Return events, always for themselves.
//   - SECURITY / ADMIN / SUPER_ADMIN: everything, including Gate In/Out, and
//     an employee picker (scan a badge or pick manually) since staff are
//     usually recording a movement on someone else's behalf.
// A single "Scan QR" button resolves whatever gets scanned - pass, location,
// or worker badge - via the same GET /api/qr/:token the old screens each
// called separately, and fills in whichever field it matches.
//
// Shortcuts on top of that:
//  - Single-member pass: scanning/selecting the pass leaves exactly one
//    person eligible, so they're auto-selected - no separate badge scan.
//  - Multi-member (GROUP) pass: rather than scan/select each member one at a
//    time, the form defaults to "whole group" mode - one submit records the
//    event for every eligible member on the pass at once. Unchecking that
//    switches back to picking a single person, for when only one member of
//    the group needs to be recorded separately.
//  - If the logged-in Security account has a default_location_id set (see
//    User Management > Set Default Location), that location is sent along
//    automatically with gate events, which otherwise carry no location_id.

const MOVEMENT_EVENT_DEFS = [
  { value: "GATE_OUT", label: "Gate Out (Security)", gate: true },
  { value: "GATE_IN", label: "Gate In (Security)", gate: true },
  { value: "LOCATION_IN", label: "Location In", gate: false },
  { value: "LOCATION_OUT", label: "Location Out", gate: false },
  { value: "EXTERNAL_IN", label: "External In", gate: false },
  { value: "EXTERNAL_OUT", label: "External Out", gate: false },
  { value: "RETURN", label: "Return to Company Location", gate: false },
];

// Only members who are actually in a valid starting state for the chosen
// event show up in the picker / group batch. This is what stops someone
// being gated out (or gated in) a second time from this screen: once
// they're OUTSIDE, they simply won't appear in the GATE_OUT list any more.
// Non-gate events are only filtered down to "not already terminal" - the
// exact state machine for location/external/return is looser and the
// backend is the real guard there.
function eligibleMembersFor(eventType, members) {
  const TERMINAL = ["RETURNED", "CANCELLED", "LEFT_FOR_DAY"];
  if (eventType === "GATE_OUT") {
    return members.filter((m) => m.member_status === "PENDING");
  }
  if (eventType === "GATE_IN") {
    return members.filter((m) => ["OUTSIDE", "AT_INTERNAL_LOCATION", "AT_EXTERNAL_LOCATION"].includes(m.member_status));
  }
  return members.filter((m) => !TERMINAL.includes(m.member_status));
}

async function renderMovementCheck(container) {
  const role = window.CurrentUser.role;
  const isEmployee = role === "EMPLOYEE";
  const canDoGateEvents = ["SECURITY", "ADMIN", "SUPER_ADMIN"].includes(role);
  const eventDefs = MOVEMENT_EVENT_DEFS.filter((e) => !e.gate || canDoGateEvents);

  // login() returns default_location_id (snake_case); a session restored via
  // Api.me() -> getCurrentUser() returns defaultLocationId (camelCase) - read
  // whichever is present so this works right after login and after a refresh.
  const defaultLocationId = window.CurrentUser.default_location_id ?? window.CurrentUser.defaultLocationId ?? null;

  const [allPasses, allLocations] = await Promise.all([Api.listGatePasses(), Api.listLocations()]);
  const relevantPasses = allPasses.filter((p) => p.status === "APPROVED" || p.status === "IN_PROGRESS");
  const activeLocations = allLocations.filter((l) => l.status === "ACTIVE");
  const defaultLocation = activeLocations.find((l) => String(l.location_id) === String(defaultLocationId)) || null;

  // Tracks who's actually eligible for the currently-selected pass + event,
  // so the submit handler knows exactly who "whole group" means without
  // re-deriving it (and without a stale DOM read).
  let currentEligibleMembers = [];

  container.innerHTML = `
    <h2>Record Movement</h2>
    <p class="hint-text">
      ${isEmployee
        ? "Check yourself in or out of a location on one of your approved passes."
        : "Scan or select a pass - a single eligible person is picked automatically, and a group pass defaults to recording everyone eligible at once."}
    </p>

    <div class="assisted-scan-row">
      <button type="button" id="movement-scan-btn" class="btn-secondary">Scan QR</button>
      <span id="movement-scan-label" class="scan-label"></span>
    </div>

    <form id="movement-form" class="stacked-form">
      <label>Pass
        <select name="pass_id" id="movement-pass-select" required>
          <option value="">-- select or scan --</option>
          ${relevantPasses.map((p) => `<option value="${p.pass_id}">${p.pass_number} - ${p.purpose}${p.leader_name ? ` (${p.leader_name})` : ""}${p.pass_category === "EARLY_LEAVE" ? " - Early Leave" : ""}</option>`).join("")}
        </select>
      </label>

      <label>Event</label>
      <div class="choice-buttons" id="movement-event-buttons">
        ${eventDefs.map((e, i) => `<button type="button" class="choice-btn${i === 0 ? " active" : ""}" data-value="${e.value}">${e.label}</button>`).join("")}
      </div>
      <input type="hidden" name="event_type" id="movement-event-hidden" value="${eventDefs[0] ? eventDefs[0].value : ""}" />

      ${isEmployee ? "" : `
        <div id="movement-group-toggle" style="display:none;">
          <label style="flex-direction: row; align-items: center; gap: 0.5rem;">
            <input type="checkbox" id="movement-apply-group" style="width:auto;" checked />
            Record for the whole group (<span id="movement-group-count">0</span> people eligible) - no per-person scan needed
          </label>
        </div>

        <div id="movement-employee-field">
          <label>Employee <span class="hint-text">(scan their badge, or select)</span>
            <select name="employee_id" id="movement-employee-select">
              <option value="">-- scan badge or select --</option>
            </select>
          </label>
        </div>
      `}

      <div id="movement-location-field">
        <label>Location
          <select name="location_id" id="movement-location-select">
            ${activeLocations.map((l) => `<option value="${l.location_id}" ${defaultLocation && l.location_id === defaultLocation.location_id ? "selected" : ""}>${l.location_name} (${l.location_type})</option>`).join("")}
          </select>
        </label>
      </div>
      ${defaultLocation ? `<p id="gate-location-hint" class="hint-text" style="display:none;">Recording at your assigned location: <strong>${defaultLocation.location_name}</strong></p>` : ""}

      <div id="movement-error" class="error-text"></div>
      <button type="submit">Record Movement</button>
    </form>
  `;

  const passSelect = document.getElementById("movement-pass-select");
  const eventButtons = document.querySelectorAll("#movement-event-buttons .choice-btn");
  const eventHidden = document.getElementById("movement-event-hidden");
  const employeeSelect = document.getElementById("movement-employee-select"); // null for EMPLOYEE role
  const employeeField = document.getElementById("movement-employee-field"); // null for EMPLOYEE role
  const groupToggleWrap = document.getElementById("movement-group-toggle"); // null for EMPLOYEE role
  const groupCheckbox = document.getElementById("movement-apply-group"); // null for EMPLOYEE role
  const groupCountEl = document.getElementById("movement-group-count"); // null for EMPLOYEE role
  const locationField = document.getElementById("movement-location-field");
  const gateLocationHint = document.getElementById("gate-location-hint");
  const errorEl = document.getElementById("movement-error");
  const scanLabel = document.getElementById("movement-scan-label");
  const submitBtn = document.querySelector("#movement-form button[type=submit]");

  function currentEventDef() {
    return eventDefs.find((e) => e.value === eventHidden.value);
  }

  // Shows/hides the individual employee picker depending on whether "whole
  // group" mode is on, and keeps the submit button's label honest about
  // what pressing it will actually do.
  function applyGroupVisibility() {
    if (isEmployee) return;
    const groupActive = currentEligibleMembers.length > 1 && groupCheckbox.checked;
    if (employeeField) employeeField.style.display = groupActive ? "none" : "";
    submitBtn.textContent = groupActive
      ? `Record for All ${currentEligibleMembers.length}`
      : "Record Movement";
  }

  // Gate events don't take a manually-picked location (the gate isn't one of
  // the registered locations) - hide the picker. If the logged-in account has
  // a default location, show a hint instead so it's clear it's still being
  // recorded, just automatically.
  function applyEventVisibility() {
    const def = currentEventDef();
    const isGate = !!(def && def.gate);
    locationField.style.display = isGate ? "none" : "";
    if (gateLocationHint) gateLocationHint.style.display = isGate ? "block" : "none";
  }
  eventButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      eventButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      eventHidden.value = btn.dataset.value;
      applyEventVisibility();
      loadPassMembers(); // eligible people depend on which event is selected
    });
  });
  applyEventVisibility();

  if (groupCheckbox) {
    groupCheckbox.addEventListener("change", applyGroupVisibility);
  }

  async function loadPassMembers() {
    if (isEmployee || !employeeSelect) return; // self only - no picker to populate
    if (!passSelect.value) {
      employeeSelect.innerHTML = `<option value="">-- scan badge or select --</option>`;
      currentEligibleMembers = [];
      groupToggleWrap.style.display = "none";
      applyGroupVisibility();
      return;
    }
    const { pass, members } = await Api.getGatePass(passSelect.value);
    const eligible = eligibleMembersFor(eventHidden.value, members);
    currentEligibleMembers = eligible;

    if (eligible.length === 0) {
      employeeSelect.innerHTML = `<option value="">-- no one eligible for this event --</option>`;
      groupToggleWrap.style.display = "none";
      applyGroupVisibility();
      return;
    }

    employeeSelect.innerHTML = `<option value="">-- scan badge or select --</option>` +
      eligible.map((m) => `<option value="${m.employee_id}">${m.emp_code} - ${m.full_name} (${formatMemberStatus(pass.status, m.member_status)})</option>`).join("");

    if (eligible.length === 1) {
      // Scanning/selecting the pass already identifies the one person it can
      // possibly be - no need to also scan or pick their badge separately.
      employeeSelect.value = eligible[0].employee_id;
      scanLabel.textContent = `✓ ${eligible[0].emp_code} - ${eligible[0].full_name} (auto-selected)`;
      groupToggleWrap.style.display = "none";
    } else {
      // GROUP pass with more than one person still eligible for this event -
      // default to recording all of them in one go instead of making
      // Security scan/select each member individually.
      groupToggleWrap.style.display = "";
      groupCountEl.textContent = eligible.length;
      groupCheckbox.checked = true;
    }
    applyGroupVisibility();
  }
  passSelect.addEventListener("change", loadPassMembers);

  document.getElementById("movement-scan-btn").addEventListener("click", () => {
    errorEl.textContent = "";
    openQrScanner(async (token) => {
      try {
        const resolved = await Api.resolveQr(token);

        if (resolved.type === "pass") {
          const belongs = [...passSelect.options].some((o) => o.value === String(resolved.pass.pass_id));
          if (!belongs) {
            errorEl.textContent = `Pass ${resolved.pass.pass_number} isn't currently available for a movement.`;
            return;
          }
          passSelect.value = resolved.pass.pass_id;
          scanLabel.textContent = `✓ Pass ${resolved.pass.pass_number}`;
          await loadPassMembers();
          return;
        }

        if (resolved.type === "location") {
          document.getElementById("movement-location-select").value = resolved.location.location_id;
          scanLabel.textContent = `✓ Location: ${resolved.location.location_name}`;
          return;
        }

        if (resolved.type === "employee") {
          if (isEmployee) {
            errorEl.textContent = "You're already identified by your login - no need to scan your own badge.";
            return;
          }
          if (!passSelect.value) {
            errorEl.textContent = "Select or scan the pass first.";
            return;
          }
          const belongs = [...employeeSelect.options].some((o) => o.value === String(resolved.employee.employee_id));
          if (!belongs) {
            errorEl.textContent = `${resolved.employee.full_name} is not eligible for this event on this pass (already recorded, or not a member).`;
            return;
          }
          // Scanning a specific person's badge means "just this one" - drop
          // out of whole-group mode so the form does exactly that.
          if (groupCheckbox) groupCheckbox.checked = false;
          applyGroupVisibility();
          employeeSelect.value = resolved.employee.employee_id;
          scanLabel.textContent = `✓ ${resolved.employee.emp_code} - ${resolved.employee.full_name}`;
        }
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });
  });

  document.getElementById("movement-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const btn = event.target.querySelector("button[type=submit]");
    const originalLabel = btn.textContent;
    errorEl.textContent = "";

    const form = new FormData(event.target);
    const eventType = form.get("event_type");
    const def = eventDefs.find((e) => e.value === eventType);
    const passId = Number(form.get("pass_id"));

    if (!passId) {
      errorEl.textContent = "Select or scan a pass first.";
      return;
    }

    // Gate events carry no manually-picked location field, but if this
    // account has a default location assigned, send that along instead of
    // leaving the event with no location_id at all.
    const locationId = def && def.gate
      ? (defaultLocationId || undefined)
      : (Number(form.get("location_id")) || undefined);

    const groupActive = !isEmployee && groupCheckbox && currentEligibleMembers.length > 1 && groupCheckbox.checked;

    if (groupActive) {
      if (currentEligibleMembers.length === 0) {
        errorEl.textContent = "There's no one left on this pass eligible for this event.";
        return;
      }
      btn.disabled = true;
      const results = [];
      for (const member of currentEligibleMembers) {
        btn.textContent = `Recording ${results.length + 1}/${currentEligibleMembers.length}...`;
        try {
          await Api.recordMovement({
            pass_id: passId,
            employee_id: member.employee_id,
            location_id: locationId,
            event_type: eventType,
            idempotency_key: window.newIdempotencyKey(),
          });
          results.push({ ok: true, name: member.full_name });
        } catch (err) {
          results.push({ ok: false, name: member.full_name, error: err.message });
        }
      }
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) {
        btn.textContent = `Recorded for all ${results.length}`;
        setTimeout(() => renderMovementCheck(container), 1200);
      } else {
        errorEl.textContent = `Recorded ${results.length - failed.length}/${results.length}. Failed: ${failed.map((f) => `${f.name} (${f.error})`).join("; ")}`;
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
      return;
    }

    // Single-person path: EMPLOYEE self-service, or Security/Admin with
    // group mode off (or only one person eligible in the first place).
    if (!isEmployee && !form.get("employee_id")) {
      errorEl.textContent = "There's no one left on this pass eligible for this event.";
      return;
    }

    btn.disabled = true;
    btn.textContent = "SUBMITTING...";
    try {
      await Api.recordMovement({
        pass_id: passId,
        employee_id: isEmployee ? window.CurrentUser.employeeId : Number(form.get("employee_id")),
        location_id: locationId,
        event_type: eventType,
        idempotency_key: window.newIdempotencyKey(),
      });
      btn.textContent = "Recorded";
      setTimeout(() => renderMovementCheck(container), 1000);
    } catch (err) {
      errorEl.textContent = err.message;
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });
}
