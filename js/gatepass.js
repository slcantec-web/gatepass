// js/gatepass.js

async function renderCreatePass(container) {
  const [employees, locations] = await Promise.all([Api.listEmployees(), Api.listLocations()]);
  container.innerHTML = `
    <h2>Create Movement Pass</h2>
    <form id="create-pass-form" class="stacked-form">
      <label>From Location
        <select name="from_location_id" required>
          ${locations.map((l) => `<option value="${l.location_id}">${l.location_name} (${l.location_type})</option>`).join("")}
        </select>
      </label>
      <label>Leader (Employee)
        <select name="leader_employee_id" required>
          ${employees.map((e) => `<option value="${e.employee_id}">${e.emp_code} - ${e.full_name}</option>`).join("")}
        </select>
      </label>
      <label>Additional Members (hold Ctrl/Cmd to multi-select)
        <select name="member_employee_ids" multiple size="6">
          ${employees.map((e) => `<option value="${e.employee_id}">${e.emp_code} - ${e.full_name}</option>`).join("")}
        </select>
      </label>
      <label>Destination(s) / Route (hold Ctrl/Cmd to multi-select, in order)
        <select name="route_location_ids" multiple size="6">
          ${locations.map((l) => `<option value="${l.location_id}">${l.location_name}</option>`).join("")}
        </select>
      </label>
      <label>Purpose<input name="purpose" required /></label>
      <label>Expected Departure<input name="expected_departure" type="datetime-local" /></label>
      <label>Expected Return<input name="expected_return" type="datetime-local" /></label>
      <div id="create-pass-error" class="error-text"></div>
      <button type="submit">Submit for Approval</button>
    </form>
  `;

  document.getElementById("create-pass-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const btn = event.target.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "SUBMITTING...";
    const errorEl = document.getElementById("create-pass-error");
    errorEl.textContent = "";

    const form = new FormData(event.target);
    const memberIds = Array.from(event.target.member_employee_ids.selectedOptions).map((o) => Number(o.value));
    const routeIds = Array.from(event.target.route_location_ids.selectedOptions).map((o) => Number(o.value));

    try {
      const result = await Api.createGatePass({
        from_location_id: Number(form.get("from_location_id")),
        leader_employee_id: Number(form.get("leader_employee_id")),
        member_employee_ids: memberIds,
        route_location_ids: routeIds,
        purpose: form.get("purpose"),
        expected_departure: form.get("expected_departure") || null,
        expected_return: form.get("expected_return") || null,
      });
      window.location.hash = `#/passes/${result.pass_id}`;
      renderApp();
    } catch (err) {
      errorEl.textContent = err.message;
      btn.disabled = false;
      btn.textContent = "Submit for Approval";
    }
  });
}

async function renderMyPasses(container) {
  container.innerHTML = `<div class="loading">Loading...</div>`;
  const passes = await Api.listGatePasses();
  container.innerHTML = `
    <h2>My Gate Passes</h2>
    <table class="data-table">
      <thead><tr><th>Pass #</th><th>Purpose</th><th>Status</th><th>Created</th></tr></thead>
      <tbody>
        ${passes.map((p) => `
          <tr class="clickable-row" data-pass-id="${p.pass_id}">
            <td>${p.pass_number}</td><td>${p.purpose}</td><td>${p.status}</td>
            <td>${new Date(p.created_at).toLocaleString()}</td>
          </tr>
        `).join("") || `<tr><td colspan="4">No gate passes yet.</td></tr>`}
      </tbody>
    </table>
  `;
  container.querySelectorAll(".clickable-row").forEach((row) => {
    row.addEventListener("click", () => {
      window.location.hash = `#/passes/${row.dataset.passId}`;
      renderApp();
    });
  });
}

async function renderPassDetails(container, passId) {
  container.innerHTML = `<div class="loading">Loading...</div>`;
  const { pass, members, route, events } = await Api.getGatePass(passId);
  container.innerHTML = `
    <h2>${pass.pass_number} <span class="badge">${pass.status}</span></h2>
    <p>${pass.purpose}</p>
    <button id="show-pass-qr" class="btn-secondary">Show QR Code</button>
    <h3>Members</h3>
    <table class="data-table">
      <thead><tr><th>Employee</th><th>Status</th></tr></thead>
      <tbody>${members.map((m) => `<tr><td>${m.emp_code} - ${m.full_name}</td><td>${m.member_status}</td></tr>`).join("")}</tbody>
    </table>
    <h3>Route</h3>
    <ol>${route.map((r) => `<li>${r.location_name}</li>`).join("")}</ol>
    <h3>Movement Events</h3>
    <table class="data-table">
      <thead><tr><th>Time</th><th>Employee</th><th>Event</th><th>Location</th></tr></thead>
      <tbody>${events.map((e) => `<tr><td>${new Date(e.event_time).toLocaleString()}</td><td>${e.full_name}</td><td>${e.event_type}</td><td>${e.location_name || "-"}</td></tr>`).join("") || `<tr><td colspan="4">No movement recorded yet.</td></tr>`}</tbody>
    </table>
  `;

  document.getElementById("show-pass-qr").addEventListener("click", () => {
    renderQrModal(`Pass ${pass.pass_number}`, pass.qr_code_token);
  });
}
