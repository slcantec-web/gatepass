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
// Two shortcuts on top of that:
//  - If scanning/selecting the pass leaves exactly one person eligible for
//    the chosen event, that person is auto-selected - no separate badge scan
//    needed on a single-member pass (the common case).
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
// event show up in the picker. This is what stops someone being gated out
// (or gated in) a second time from this screen: once they're OUTSIDE, they
// simply won't appear in the GATE_OUT list any more. Non-gate events are
// only filtered down to "not already terminal" - the exact state machine
// for location/external/return is looser and the backend is the real guard
// there.
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

  container.innerHTML = `
    <h2>Record Movement</h2>
    <p class="hint-text">
      ${isEmployee
        ? "Check yourself in or out of a location on one of your approved passes."
        : "Scan or select a pass - if only one person on it is eligible for the chosen event, they're picked automatically."}
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
        <label>Employee <span class="hint-text">(auto-selected when only one person on the pass is eligible)</span>
          <select name="employee_id" id="movement-employee-select" required>
            <option value="">-- scan badge or select --</option>
          </select>
        </label>
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
  const locationField = document.getElementById("movement-location-field");
  const gateLocationHint = document.getElementById("gate-location-hint");
  const errorEl = document.getElementById("movement-error");
  const scanLabel = document.getElementById("movement-scan-label");

  function currentEventDef() {
    return eventDefs.find((e) => e.value === eventHidden.value);
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

  async function loadPassMembers() {
    if (isEmployee || !employeeSelect) return; // self only - no picker to populate
    if (!passSelect.value) {
      employeeSelect.innerHTML = `<option value="">-- scan badge or select --</option>`;
      return;
    }
    const { pass, members } = await Api.getGatePass(passSelect.value);
    const eligible = eligibleMembersFor(eventHidden.value, members);

    if (eligible.length === 0) {
      employeeSelect.innerHTML = `<option value="">-- no one eligible for this event --</option>`;
      return;
    }

    employeeSelect.innerHTML = `<option value="">-- scan badge or select --</option>` +
      eligible.map((m) => `<option value="${m.employee_id}">${m.emp_code} - ${m.full_name} (${formatMemberStatus(pass.status, m.member_status)})</option>`).join("");

    // Scanning/selecting the pass already identifies the one person it can
    // possibly be when there's only one eligible member on it - no need to
    // also scan or pick their badge separately.
    if (eligible.length === 1) {
      employeeSelect.value = eligible[0].employee_id;
      scanLabel.textContent = `✓ ${eligible[0].emp_code} - ${eligible[0].full_name} (auto-selected)`;
    }
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
    btn.disabled = true;
    btn.textContent = "SUBMITTING...";
    errorEl.textContent = "";

    const form = new FormData(event.target);
    const eventType = form.get("event_type");
    const def = eventDefs.find((e) => e.value === eventType);

    if (!isEmployee && !form.get("employee_id")) {
      errorEl.textContent = "There's no one left on this pass eligible for this event.";
      btn.disabled = false;
      btn.textContent = "Record Movement";
      return;
    }

    // Gate events carry no manually-picked location field, but if this
    // account has a default location assigned, send that along instead of
    // leaving the event with no location_id at all.
    const locationId = def && def.gate
      ? (defaultLocationId || undefined)
      : (Number(form.get("location_id")) || undefined);

    try {
      await Api.recordMovement({
        pass_id: Number(form.get("pass_id")),
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
      btn.textContent = "Record Movement";
    }
  });
}
