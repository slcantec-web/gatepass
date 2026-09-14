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

const MOVEMENT_EVENT_DEFS = [
  { value: "GATE_OUT", label: "Gate Out (Security)", gate: true },
  { value: "GATE_IN", label: "Gate In (Security)", gate: true },
  { value: "LOCATION_IN", label: "Location In", gate: false },
  { value: "LOCATION_OUT", label: "Location Out", gate: false },
  { value: "EXTERNAL_IN", label: "External In", gate: false },
  { value: "EXTERNAL_OUT", label: "External Out", gate: false },
  { value: "RETURN", label: "Return to Company Location", gate: false },
];

async function renderMovementCheck(container) {
  const role = window.CurrentUser.role;
  const isEmployee = role === "EMPLOYEE";
  const canDoGateEvents = ["SECURITY", "ADMIN", "SUPER_ADMIN"].includes(role);
  const eventDefs = MOVEMENT_EVENT_DEFS.filter((e) => !e.gate || canDoGateEvents);

  const [allPasses, allLocations] = await Promise.all([Api.listGatePasses(), Api.listLocations()]);
  const relevantPasses = allPasses.filter((p) => p.status === "APPROVED" || p.status === "IN_PROGRESS");
  const activeLocations = allLocations.filter((l) => l.status === "ACTIVE");

  container.innerHTML = `
    <h2>Record Movement</h2>
    <p class="hint-text">
      ${isEmployee
        ? "Check yourself in or out of a location on one of your approved passes."
        : "Scan or select a pass, then a person and an event - covers gate in/out and location check-in/out for anyone on the pass."}
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

      <label>Event
        <select name="event_type" id="movement-event-select" required>
          ${eventDefs.map((e) => `<option value="${e.value}">${e.label}</option>`).join("")}
        </select>
      </label>

      ${isEmployee ? "" : `
        <label>Employee <span class="hint-text">(scan their badge, or select)</span>
          <select name="employee_id" id="movement-employee-select" required>
            <option value="">-- scan badge or select --</option>
          </select>
        </label>
      `}

      <div id="movement-location-field">
        <label>Location
          <select name="location_id" id="movement-location-select">
            ${activeLocations.map((l) => `<option value="${l.location_id}">${l.location_name} (${l.location_type})</option>`).join("")}
          </select>
        </label>
      </div>

      <div id="movement-error" class="error-text"></div>
      <button type="submit">Record Movement</button>
    </form>
  `;

  const passSelect = document.getElementById("movement-pass-select");
  const eventSelect = document.getElementById("movement-event-select");
  const employeeSelect = document.getElementById("movement-employee-select"); // null for EMPLOYEE role
  const locationField = document.getElementById("movement-location-field");
  const errorEl = document.getElementById("movement-error");
  const scanLabel = document.getElementById("movement-scan-label");

  function currentEventDef() {
    return eventDefs.find((e) => e.value === eventSelect.value);
  }

  // Gate events don't take a location (the gate isn't one of the registered
  // locations) - hide the field entirely rather than leave a misleading one
  // sitting there unused.
  function applyEventVisibility() {
    const def = currentEventDef();
    locationField.style.display = def && def.gate ? "none" : "";
  }
  eventSelect.addEventListener("change", applyEventVisibility);
  applyEventVisibility();

  async function loadPassMembers() {
    if (isEmployee || !employeeSelect) return; // self only - no picker to populate
    if (!passSelect.value) {
      employeeSelect.innerHTML = `<option value="">-- scan badge or select --</option>`;
      return;
    }
    const { pass, members } = await Api.getGatePass(passSelect.value);
    employeeSelect.innerHTML = `<option value="">-- scan badge or select --</option>` +
      members.map((m) => `<option value="${m.employee_id}">${m.emp_code} - ${m.full_name} (${formatMemberStatus(pass.status, m.member_status)})</option>`).join("");
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
            errorEl.textContent = `${resolved.employee.full_name} is not a member of this pass.`;
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

    try {
      await Api.recordMovement({
        pass_id: Number(form.get("pass_id")),
        employee_id: isEmployee ? window.CurrentUser.employeeId : Number(form.get("employee_id")),
        location_id: def && def.gate ? undefined : (Number(form.get("location_id")) || undefined),
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
