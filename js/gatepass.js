// js/gatepass.js

async function renderCreatePass(container) {
  const [employees, locations] = await Promise.all([Api.listEmployees(), Api.listLocations()]);
  container.innerHTML = `
    <h2>Create Movement Pass</h2>
    <form id="create-pass-form" class="stacked-form">
      <label>Pass Type</label>
      <div class="choice-buttons" id="pass-category-buttons">
        <button type="button" class="choice-btn active" data-value="MOVEMENT">
          <span>Movement Pass</span>
          <span class="choice-btn-sub">Leaves &amp; returns same day</span>
        </button>
        <button type="button" class="choice-btn" data-value="EARLY_LEAVE">
          <span>Early Leave</span>
          <span class="choice-btn-sub">Leaving before shift end, not returning today</span>
        </button>
      </div>
      <input type="hidden" name="pass_category" id="pass-category-hidden" value="MOVEMENT" />
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
      <label>Additional Members <span class="hint-text">(type to search by name or code)</span>
        <select name="member_employee_ids" id="member-select" multiple>
          ${employees.map((e) => `<option value="${e.employee_id}">${e.emp_code} - ${e.full_name}</option>`).join("")}
        </select>
      </label>
      <div id="route-fields">
        <label>Destination(s) / Route <span class="hint-text">(type to search - pick in the order you'll visit them)</span>
          <select name="route_location_ids" id="route-select" multiple>
            ${locations.map((l) => `<option value="${l.location_id}">${l.location_name} (${l.location_type})</option>`).join("")}
          </select>
        </label>
        <label>Other destination <span class="hint-text">(only if the actual place isn't listed above - e.g. a one-off customer/vendor site, or still to be decided)</span>
          <textarea name="destination_note" rows="2" placeholder="e.g. Client site visit - ABC Traders, No. 45 Galle Road, Colombo 03 (not yet in Location Master)"></textarea>
        </label>
      </div>
      <label>Purpose<input name="purpose" required /></label>
      <label>Expected Departure<input name="expected_departure" type="datetime-local" /></label>
      <div id="expected-return-field">
        <label>Expected Return<input name="expected_return" type="datetime-local" /></label>
      </div>
      <p id="early-leave-hint" class="hint-text" style="display:none;">
        No return time needed - the pass will close automatically as soon as Security records the gate-out.
      </p>
      <div id="create-pass-error" class="error-text"></div>
      <button type="submit">Submit for Approval</button>
    </form>
  `;

  // Enable type-to-search on the two long-list selects. Choices.js keeps the
  // underlying <select multiple> in sync as the real source of truth, so the
  // submit handler below (which reads event.target.member_employee_ids and
  // .route_location_ids directly) needs no changes at all.
  const choicesConfig = {
    removeItemButton: true,
    searchResultLimit: 30,
    shouldSort: false, // options already arrive alphabetically sorted from the API
    placeholderValue: "Type to search...",
    noResultsText: "No matches",
    itemSelectText: "",
  };
  if (window.Choices) {
    new window.Choices(document.getElementById("member-select"), choicesConfig);
    new window.Choices(document.getElementById("route-select"), { ...choicesConfig, placeholderValue: "Type to search locations..." });
  }
  // If the Choices.js CDN script hasn't finished loading yet (or failed),
  // the plain <select multiple> underneath is still fully functional as a
  // fallback - just without the search box and chip styling.

  const categoryButtons = document.querySelectorAll("#pass-category-buttons .choice-btn");
  const categoryHidden = document.getElementById("pass-category-hidden");
  const expectedReturnField = document.getElementById("expected-return-field");
  const earlyLeaveHint = document.getElementById("early-leave-hint");

  function applyCategoryVisibility() {
    const isEarlyLeave = categoryHidden.value === "EARLY_LEAVE";
    expectedReturnField.style.display = isEarlyLeave ? "none" : "";
    earlyLeaveHint.style.display = isEarlyLeave ? "block" : "none";
    if (isEarlyLeave) document.querySelector("[name=expected_return]").value = "";
  }
  categoryButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      categoryButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      categoryHidden.value = btn.dataset.value;
      applyCategoryVisibility();
    });
  });
  applyCategoryVisibility();

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
        destination_note: form.get("destination_note") || null,
        pass_category: form.get("pass_category"),
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

// For EMPLOYEE logins, Api.listGatePasses() returns only their own passes.
// For SUPER_ADMIN / ADMIN / HOD / SECURITY / MANAGEMENT_VIEWER, the same
// endpoint returns the full gate pass history (every pass, any status,
// any leader) - so this same screen doubles as the admin-facing history
// list, and shows a Leader column whenever that data is present.
async function renderMyPasses(container) {
  container.innerHTML = `<div class="loading">Loading...</div>`;
  const passes = await Api.listGatePasses();
  const isHistoryView = passes.some((p) => p.leader_name);
  const currentEmployeeId = window.CurrentUser && window.CurrentUser.employeeId;
  const isSuperAdmin = window.CurrentUser && window.CurrentUser.role === "SUPER_ADMIN";

  function canDelete(p) {
    if (p.status === "COMPLETED") return false;
    if (isSuperAdmin) return true;
    return p.leader_employee_id === currentEmployeeId && ["PENDING", "REJECTED"].includes(p.status);
  }

  container.innerHTML = `
    <h2>${isHistoryView ? "Gate Pass History" : "My Gate Passes"}</h2>
    <table class="data-table">
      <thead><tr>
        <th>Pass #</th>${isHistoryView ? "<th>Leader</th>" : ""}<th>Purpose</th><th>Status</th><th>Created</th><th></th>
      </tr></thead>
      <tbody>
        ${passes.map((p) => `
          <tr>
            <td class="clickable-row" data-pass-id="${p.pass_id}" data-label="Pass #">${p.pass_number}</td>
            ${isHistoryView ? `<td class="clickable-row" data-pass-id="${p.pass_id}" data-label="Leader">${p.leader_name || "-"}</td>` : ""}
            <td class="clickable-row" data-pass-id="${p.pass_id}" data-label="Purpose">${p.purpose}</td>
            <td class="clickable-row" data-pass-id="${p.pass_id}" data-label="Status">${p.status}</td>
            <td class="clickable-row" data-pass-id="${p.pass_id}" data-label="Created">${new Date(p.created_at).toLocaleString()}</td>
            <td>${canDelete(p) ? `<button class="btn-link btn-delete-pass" data-pass-id="${p.pass_id}" data-pass-number="${p.pass_number}">Delete</button>` : ""}</td>
          </tr>
        `).join("") || `<tr><td colspan="${isHistoryView ? 6 : 5}">No gate passes yet.</td></tr>`}
      </tbody>
    </table>
  `;

  container.querySelectorAll(".clickable-row").forEach((cell) => {
    cell.addEventListener("click", () => {
      window.location.hash = `#/passes/${cell.dataset.passId}`;
      renderApp();
    });
  });

  container.querySelectorAll(".btn-delete-pass").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!confirm(`Delete gate pass ${btn.dataset.passNumber}? This cannot be undone.`)) return;
      btn.disabled = true;
      try {
        await Api.deleteGatePass(btn.dataset.passId);
        renderMyPasses(container);
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
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
  const isRejected = pass.status === "REJECTED";

  const currentEmployeeId = window.CurrentUser && window.CurrentUser.employeeId;
  const isSuperAdmin = window.CurrentUser && window.CurrentUser.role === "SUPER_ADMIN";
  const isOwner = pass.leader_employee_id === currentEmployeeId;
  const canDelete = pass.status !== "COMPLETED" &&
    (isSuperAdmin || (isOwner && ["PENDING", "REJECTED"].includes(pass.status)));

  container.innerHTML = `
    <h2>${pass.pass_number} <span class="badge">${pass.status}</span>${pass.pass_category === "EARLY_LEAVE" ? ` <span class="badge" style="background: var(--warning-light); color: var(--warning);">EARLY LEAVE - NO RETURN</span>` : ""}</h2>
    <p>${pass.purpose}</p>
    ${pass.destination_note ? `<p class="hint-text"><strong>Other destination:</strong> ${pass.destination_note}</p>` : ""}
    ${isRejected ? `<p class="error-text">This pass was rejected - its QR code and print slip are no longer available.</p>` : `
      <button id="show-pass-qr" class="btn-secondary">Show QR Code</button>
      ${printEnabled ? `<button id="print-pass-slip" class="btn-secondary">Print Pass Slip</button>` : ""}
    `}
    ${canDelete ? `<button id="delete-pass-btn" class="btn-secondary" style="color: var(--danger); border-color: var(--danger);">Delete Gate Pass</button>` : ""}
    <h3>Members</h3>
    <table class="data-table">
      <thead><tr><th>Employee</th><th>Status</th></tr></thead>
      <tbody>${members.map((m) => `<tr><td data-label="Employee">${m.emp_code} - ${m.full_name}</td><td data-label="Status">${formatMemberStatus(pass.status, m.member_status)}</td></tr>`).join("")}</tbody>
    </table>
    <h3>Route</h3>
    <ol>${route.map((r) => `<li>${r.location_name}</li>`).join("")}</ol>
    <h3>Movement Events</h3>
    <table class="data-table">
      <thead><tr><th>Time</th><th>Employee</th><th>Event</th><th>Location</th></tr></thead>
      <tbody>${events.map((e) => `<tr><td data-label="Time">${new Date(e.event_time).toLocaleString()}</td><td data-label="Employee">${e.full_name}</td><td data-label="Event">${e.event_type}</td><td data-label="Location">${e.location_name || "-"}</td></tr>`).join("") || `<tr><td colspan="4">No movement recorded yet.</td></tr>`}</tbody>
    </table>
  `;

  if (!isRejected) {
    document.getElementById("show-pass-qr").addEventListener("click", () => {
      renderQrModal(`Pass ${pass.pass_number}`, pass.qr_code_token);
    });

    if (printEnabled) {
      document.getElementById("print-pass-slip").addEventListener("click", () => {
        printPassSlip(pass, members, route, settings);
      });
    }
  }

  if (canDelete) {
    document.getElementById("delete-pass-btn").addEventListener("click", async () => {
      if (!confirm(`Delete gate pass ${pass.pass_number}? This cannot be undone.`)) return;
      const btn = document.getElementById("delete-pass-btn");
      btn.disabled = true;
      btn.textContent = "Deleting...";
      try {
        await Api.deleteGatePass(passId);
        window.location.hash = "#/my-passes";
        renderApp();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
        btn.textContent = "Delete Gate Pass";
      }
    });
  }
}

// Optional physical paper copy of an approved pass - for a driver/worker to
// carry when they don't have the app on their own device, or as a backup to
// the on-screen QR. Opens a separate print-only window so it never disturbs
// the SPA's own layout/state. Paper size comes from Super Admin settings.
function printPassSlip(pass, members, route, settings) {
  if (!window.QRCode) {
    alert("QR library failed to load, so the pass slip can't include a QR code. Check your network/CDN access and try again.");
    return;
  }

  const qrCanvas = document.createElement("canvas");
  window.QRCode.toCanvas(qrCanvas, pass.qr_code_token, { width: 160, margin: 1 }, (err) => {
    if (err) {
      console.error("Pass slip QR render failed", err);
      alert("Could not render the QR code for this pass slip.");
      return;
    }
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
        <div class="subtitle">Status: ${pass.status}${pass.pass_category === "EARLY_LEAVE" ? " - EARLY LEAVE (no return expected today)" : ""}</div>

        <div class="meta-grid">
          <div><span class="label">Purpose:</span> ${pass.purpose}</div>
          <div><span class="label">Pass Type:</span> ${pass.pass_type}</div>
          <div><span class="label">Expected Departure:</span> ${pass.expected_departure ? new Date(pass.expected_departure).toLocaleString() : "-"}</div>
          <div><span class="label">Expected Return:</span> ${pass.pass_category === "EARLY_LEAVE" ? "Not applicable (Early Leave)" : (pass.expected_return ? new Date(pass.expected_return).toLocaleString() : "-")}</div>
          ${pass.destination_note ? `<div style="grid-column: 1 / -1;"><span class="label">Other Destination:</span> ${pass.destination_note}</div>` : ""}
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
          ${pass.pass_category === "EARLY_LEAVE" ? "" : `<div class="sign-box"><div class="sign-line">Security Gate In - Signature &amp; Time</div></div>`}
        </div>
      </body>
      </html>
    `);
    win.document.close();
    win.focus();
  });
}
