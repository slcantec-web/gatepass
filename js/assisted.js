// js/assisted.js
// For workers with no smartphone (e.g. drivers): a security officer or location
// marshal uses this screen on a shared device to log the movement on the
// worker's behalf, identifying them by their printed badge QR instead of
// requiring the worker to have their own phone/app.

async function renderAssistedCheck(container) {
  const passes = (await Api.listGatePasses()).filter((p) => p.status === "IN_PROGRESS" || p.status === "APPROVED");

  container.innerHTML = `
    <h2>Staff-Assisted Movement Check</h2>
    <p class="hint-text">For workers without a smartphone: scan the pass, then scan the worker's badge, then record the event.</p>

    <div class="assisted-scan-row">
      <button id="scan-pass-btn" class="btn-secondary">1. Scan Pass QR</button>
      <span id="scanned-pass-label" class="scan-label"></span>
    </div>

    <form id="assisted-form" class="stacked-form">
      <label>Pass
        <select name="pass_id" id="assisted-pass-select" required>
          <option value="">-- select or scan --</option>
          ${passes.map((p) => `<option value="${p.pass_id}">${p.pass_number} - ${p.purpose}</option>`).join("")}
        </select>
      </label>

      <div class="assisted-scan-row">
        <button type="button" id="scan-badge-btn" class="btn-secondary">2. Scan Worker Badge</button>
        <span id="scanned-employee-label" class="scan-label"></span>
      </div>

      <label>Worker (auto-filled by badge scan, or pick manually)
        <select name="employee_id" id="assisted-employee-select" required>
          <option value="">-- scan badge or select --</option>
        </select>
      </label>

      <label>Location
        <select name="location_id" required id="assisted-location-select">
        </select>
      </label>

      <label>Event
        <select name="event_type" required>
          <option value="LOCATION_IN">Location In</option>
          <option value="LOCATION_OUT">Location Out</option>
          <option value="EXTERNAL_IN">External In</option>
          <option value="EXTERNAL_OUT">External Out</option>
          <option value="RETURN">Return to Company Location</option>
        </select>
      </label>

      <div id="assisted-error" class="error-text"></div>
      <button type="submit">Record Movement</button>
    </form>
  `;

  const locations = await Api.listLocations();
  document.getElementById("assisted-location-select").innerHTML =
    locations.map((l) => `<option value="${l.location_id}">${l.location_name} (${l.location_type})</option>`).join("");

  const passSelect = document.getElementById("assisted-pass-select");
  const employeeSelect = document.getElementById("assisted-employee-select");
  const errorEl = document.getElementById("assisted-error");

  async function loadPassMembers() {
    if (!passSelect.value) { employeeSelect.innerHTML = `<option value="">-- scan badge or select --</option>`; return; }
    const { pass, members } = await Api.getGatePass(passSelect.value);
    employeeSelect.innerHTML = `<option value="">-- scan badge or select --</option>` +
      members.map((m) => `<option value="${m.employee_id}">${m.emp_code} - ${m.full_name} (${formatMemberStatus(pass.status, m.member_status)})</option>`).join("");
  }
  passSelect.addEventListener("change", loadPassMembers);

  document.getElementById("scan-pass-btn").addEventListener("click", () => {
    errorEl.textContent = "";
    openQrScanner(async (token) => {
      try {
        const resolved = await Api.resolveQr(token);
        if (resolved.type !== "pass") { errorEl.textContent = "That's not a pass QR."; return; }
        passSelect.value = resolved.pass.pass_id;
        document.getElementById("scanned-pass-label").textContent = `✓ ${resolved.pass.pass_number}`;
        await loadPassMembers();
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });
  });

  document.getElementById("scan-badge-btn").addEventListener("click", () => {
    errorEl.textContent = "";
    if (!passSelect.value) { errorEl.textContent = "Select or scan the pass first."; return; }
    openQrScanner(async (token) => {
      try {
        const resolved = await Api.resolveQr(token);
        if (resolved.type !== "employee") { errorEl.textContent = "That's not a worker badge."; return; }
        const belongs = [...employeeSelect.options].some((o) => o.value === String(resolved.employee.employee_id));
        if (!belongs) {
          errorEl.textContent = `${resolved.employee.full_name} is not a member of this pass.`;
          return;
        }
        employeeSelect.value = resolved.employee.employee_id;
        document.getElementById("scanned-employee-label").textContent = `✓ ${resolved.employee.emp_code} - ${resolved.employee.full_name}`;
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });
  });

  document.getElementById("assisted-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const btn = event.target.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "SUBMITTING...";
    errorEl.textContent = "";
    const form = new FormData(event.target);
    try {
      await Api.recordMovement({
        pass_id: Number(form.get("pass_id")),
        employee_id: Number(form.get("employee_id")),
        location_id: Number(form.get("location_id")),
        event_type: form.get("event_type"),
        idempotency_key: window.newIdempotencyKey(),
      });
      btn.textContent = "Recorded";
      setTimeout(() => renderAssistedCheck(container), 1200);
    } catch (err) {
      errorEl.textContent = err.message;
      btn.disabled = false;
      btn.textContent = "Record Movement";
    }
  });
}
