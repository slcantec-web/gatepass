// js/movement.js
// Employee self-service location check-in / check-out / external in/out on an
// approved pass they're a member of. Every submit uses a fresh idempotency key
// and the button is disabled immediately (duplicate-prevention level 1, section 17).

async function renderLocationCheck(container) {
  const passes = (await Api.listGatePasses()).filter((p) => p.status === "IN_PROGRESS" || p.status === "APPROVED");
  const locations = await Api.listLocations();

  container.innerHTML = `
    <h2>Location Check-In / Check-Out</h2>
    <button id="scan-location-qr" class="btn-secondary">Scan Location QR</button>
    <form id="location-check-form" class="stacked-form">
      <label>Pass
        <select name="pass_id" required>
          ${passes.map((p) => `<option value="${p.pass_id}">${p.pass_number} - ${p.purpose}</option>`).join("")}
        </select>
      </label>
      <label>Location
        <select name="location_id" required>
          ${locations.map((l) => `<option value="${l.location_id}">${l.location_name} (${l.location_type})</option>`).join("")}
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
      <div id="location-check-error" class="error-text"></div>
      <button type="submit">Record Movement</button>
    </form>
  `;

  document.getElementById("scan-location-qr").addEventListener("click", () => {
    const errorEl = document.getElementById("location-check-error");
    openQrScanner(async (token) => {
      try {
        const resolved = await Api.resolveQr(token);
        const form = document.getElementById("location-check-form");
        if (resolved.type === "location") {
          form.location_id.value = resolved.location.location_id;
        } else if (resolved.type === "pass") {
          form.pass_id.value = resolved.pass.pass_id;
        }
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });
  });

  document.getElementById("location-check-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const btn = event.target.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "SUBMITTING...";
    const errorEl = document.getElementById("location-check-error");
    errorEl.textContent = "";

    const form = new FormData(event.target);
    try {
      await Api.recordMovement({
        pass_id: Number(form.get("pass_id")),
        employee_id: window.CurrentUser.employeeId,
        location_id: Number(form.get("location_id")),
        event_type: form.get("event_type"),
        idempotency_key: window.newIdempotencyKey(),
      });
      btn.textContent = "Recorded";
      setTimeout(() => { btn.disabled = false; btn.textContent = "Record Movement"; }, 1500);
    } catch (err) {
      errorEl.textContent = err.message;
      btn.disabled = false;
      btn.textContent = "Record Movement";
    }
  });
}
