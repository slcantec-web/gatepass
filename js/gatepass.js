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
  const [{ pass, members, route, events }, settings] = await Promise.all([
    Api.getGatePass(passId),
    Api.getSettings().catch(() => ({ print_enabled: "true" })), // fail open if settings fetch has trouble
  ]);
  const printEnabled = settings.print_enabled !== "false";

  container.innerHTML = `
    <h2>${pass.pass_number} <span class="badge">${pass.status}</span></h2>
    <p>${pass.purpose}</p>
    <button id="show-pass-qr" class="btn-secondary">Show QR Code</button>
    ${printEnabled ? `<button id="print-pass-slip" class="btn-secondary">Print Pass Slip</button>` : ""}
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

  if (printEnabled) {
    document.getElementById("print-pass-slip").addEventListener("click", () => {
      printPassSlip(pass, members, route, settings);
    });
  }
}

// Optional physical paper copy of an approved pass - for a driver/worker to
// carry when they don't have the app on their own device, or as a backup to
// the on-screen QR. Opens a separate print-only window so it never disturbs
// the SPA's own layout/state. Paper size comes from Super Admin settings.
function printPassSlip(pass, members, route, settings) {
  const qrCanvas = document.createElement("canvas");
  window.QRCode.toCanvas(qrCanvas, pass.qr_code_token, { width: 160, margin: 1 }, () => {
    const qrDataUrl = qrCanvas.toDataURL("image/png");
    const pageSize = paperSizeCss(settings);
    const win = window.open("", "_blank", "width=650,height=850");
    if (!win) {
      alert("Your browser blocked the print window. Please allow pop-ups for this site and try again.");
      return;
    }

    win.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8" />
        <title>Gate Pass ${pass.pass_number}</title>
        <style>
          @page { size: ${pageSize}; margin: 10mm; }
          body { font-family: Arial, Helvetica, sans-serif; color: #111; padding: 28px; }
          h1 { font-size: 19px; margin: 0 0 4px; }
          .subtitle { color: #555; font-size: 12px; margin-bottom: 18px; }
          .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 20px; font-size: 13px; margin-bottom: 16px; }
          .meta-grid .label { color: #666; }
          .qr-block { text-align: center; margin: 18px 0; }
          .qr-block img { width: 140px; height: 140px; }
          .qr-block small { display: block; font-family: monospace; color: #777; margin-top: 4px; font-size: 10px; }
          table { width: 100%; border-collapse: collapse; margin: 10px 0 18px; }
          th, td { border: 1px solid #999; padding: 6px 9px; font-size: 12px; text-align: left; }
          th { background: #f2f2f2; }
          h3 { font-size: 13px; margin: 16px 0 6px; }
          .sign-row { display: flex; justify-content: space-between; margin-top: 50px; }
          .sign-box { width: 46%; text-align: center; font-size: 11px; color: #444; }
          .sign-line { border-top: 1px solid #333; margin-bottom: 4px; padding-top: 34px; }
          @media print { .no-print { display: none; } }
        </style>
      </head>
      <body>
        <button class="no-print" onclick="window.print()" style="margin-bottom:16px;padding:8px 16px;">Print</button>
        <h1>Gate Pass - ${pass.pass_number}</h1>
        <div class="subtitle">Status: ${pass.status}</div>

        <div class="meta-grid">
          <div><span class="label">Purpose:</span> ${pass.purpose}</div>
          <div><span class="label">Pass Type:</span> ${pass.pass_type}</div>
          <div><span class="label">Expected Departure:</span> ${pass.expected_departure ? new Date(pass.expected_departure).toLocaleString() : "-"}</div>
          <div><span class="label">Expected Return:</span> ${pass.expected_return ? new Date(pass.expected_return).toLocaleString() : "-"}</div>
        </div>

        <div class="qr-block">
          <img src="${qrDataUrl}" alt="Pass QR code" />
          <small>${pass.qr_code_token}</small>
        </div>

        <h3>Members</h3>
        <table>
          <thead><tr><th>Emp Code</th><th>Name</th></tr></thead>
          <tbody>${members.map((m) => `<tr><td>${m.emp_code}</td><td>${m.full_name}</td></tr>`).join("")}</tbody>
        </table>

        <h3>Route</h3>
        <table>
          <thead><tr><th>#</th><th>Destination</th></tr></thead>
          <tbody>${route.map((r, i) => `<tr><td>${i + 1}</td><td>${r.location_name}</td></tr>`).join("") || `<tr><td colspan="2">-</td></tr>`}</tbody>
        </table>

        <div class="sign-row">
          <div class="sign-box"><div class="sign-line">Security Gate Out - Signature &amp; Time</div></div>
          <div class="sign-box"><div class="sign-line">Security Gate In - Signature &amp; Time</div></div>
        </div>
      </body>
      </html>
    `);
    win.document.close();
    win.focus();
  });
}
