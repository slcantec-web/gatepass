// js/employees.js

function parseSpreadsheetFile(file) {
  return new Promise((resolve, reject) => {
    const isCsv = file.name.toLowerCase().endsWith(".csv");
    if (isCsv) {
      window.Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (result) => resolve(result.data),
        error: reject,
      });
    } else {
      const reader = new FileReader();
      reader.onload = (e) => {
        const workbook = window.XLSX.read(e.target.result, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        resolve(window.XLSX.utils.sheet_to_json(sheet, { defval: "" }));
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    }
  });
}

// Normalizes whatever headers the spreadsheet used (Emp Code, EmployeeID, etc.)
// down to the field names the import API expects.
function normalizeImportRow(raw) {
  const get = (...keys) => {
    for (const k of keys) {
      const found = Object.keys(raw).find((rk) => rk.trim().toLowerCase() === k);
      if (found && String(raw[found]).trim() !== "") return String(raw[found]).trim();
    }
    return "";
  };
  return {
    emp_code: get("emp_code", "empcode", "employee id", "employee_id", "code"),
    full_name: get("full_name", "name", "employee name", "fullname"),
    designation: get("designation", "title") || null,
    phone: get("phone", "mobile") || null,
    email: get("email") || null,
  };
}

// Upload -> Validate -> Preview -> Confirm Import (spec section 20)
async function handleEmployeeImport(event, screenContainer) {
  const file = event.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("import-status");
  statusEl.innerHTML = `<div class="loading">Parsing ${file.name}...</div>`;

  let rawRows;
  try {
    rawRows = await parseSpreadsheetFile(file);
  } catch (err) {
    statusEl.innerHTML = `<div class="error-text">Could not read file: ${err.message}</div>`;
    return;
  }

  const rows = rawRows.map(normalizeImportRow).filter((r) => r.emp_code || r.full_name);
  if (rows.length === 0) {
    statusEl.innerHTML = `<div class="error-text">No usable rows found. Expected columns like emp_code / full_name.</div>`;
    return;
  }

  statusEl.innerHTML = `
    <p>${rows.length} row(s) found. Preview:</p>
    <table class="data-table">
      <thead><tr><th>Emp Code</th><th>Full Name</th><th>Designation</th></tr></thead>
      <tbody>${rows.slice(0, 8).map((r) => `<tr><td data-label="Emp Code">${r.emp_code}</td><td data-label="Full Name">${r.full_name}</td><td data-label="Designation">${r.designation || "-"}</td></tr>`).join("")}</tbody>
    </table>
    ${rows.length > 8 ? `<p>...and ${rows.length - 8} more</p>` : ""}
    <button id="confirm-import-btn">Confirm Import</button>
  `;

  document.getElementById("confirm-import-btn").addEventListener("click", async () => {
    const btn = document.getElementById("confirm-import-btn");
    btn.disabled = true;
    btn.textContent = "IMPORTING...";
    try {
      const result = await Api.importEmployees(rows);
      statusEl.innerHTML = `
        <p>Imported ${result.imported} employee(s).</p>
        ${result.errors.length ? `
          <p class="error-text">${result.errors.length} row(s) skipped:</p>
          <ul>${result.errors.map((e) => `<li>Row ${e.row}: ${e.error}</li>`).join("")}</ul>
        ` : ""}
      `;
      renderEmployeeMaster(screenContainer);
    } catch (err) {
      statusEl.innerHTML = `<div class="error-text">Import failed: ${err.message}</div>`;
    }
  });
}

async function renderEmployeeMaster(container) {
  const [employees, departments] = await Promise.all([Api.listEmployees(), Api.listDepartments()]);
  const activeDepartments = departments.filter((d) => d.status === "ACTIVE");
  container.innerHTML = `
    <h2>Employee Master</h2>
    <form id="add-employee-form" class="inline-form">
      <input name="emp_code" placeholder="Emp Code (e.g. EMP010)" required />
      <input name="full_name" placeholder="Full Name" required />
      <input name="designation" placeholder="Designation" />
      <select name="department_id">
        <option value="">(no department)</option>
        ${activeDepartments.map((d) => `<option value="${d.department_id}">${d.department_name}</option>`).join("")}
      </select>
      <button type="submit">Add Employee</button>
    </form>
    <div id="add-employee-error" class="error-text"></div>

    <div class="import-box">
      <label>Import from CSV or XLSX
        <input type="file" id="import-file-input" accept=".csv,.xlsx,.xls" />
      </label>
      <div id="import-status"></div>
    </div>

    <button id="print-badges-btn" class="btn-secondary">Print Worker Badges</button>
    <div id="badge-sheet"></div>

    <table class="data-table">
      <thead><tr><th>Code</th><th>Name</th><th>Designation</th><th>Department</th><th>Status</th><th></th></tr></thead>
      <tbody>${employees.map((e) => `
        <tr>
          <td data-label="Code">${e.emp_code}</td>
          <td data-label="Name">${e.full_name}</td>
          <td data-label="Designation">${e.designation || "-"}</td>
          <td data-label="Department">${e.department_name || `<span class="hint-text">Not set</span>`}</td>
          <td data-label="Status">${e.status}</td>
          <td><button class="btn-link btn-change-dept" data-employee-id="${e.employee_id}" data-name="${e.full_name}" data-department-id="${e.department_id || ""}">Change Dept.</button></td>
        </tr>
      `).join("")}</tbody>
    </table>
  `;

  document.getElementById("import-file-input").addEventListener("change", (event) => handleEmployeeImport(event, container));

  document.getElementById("add-employee-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById("add-employee-error");
    errorEl.textContent = "";
    const form = new FormData(event.target);
    try {
      await Api.createEmployee({
        emp_code: form.get("emp_code").trim(),
        full_name: form.get("full_name").trim(),
        designation: form.get("designation") || null,
        department_id: form.get("department_id") ? Number(form.get("department_id")) : null,
      });
      renderEmployeeMaster(container);
    } catch (err) {
      errorEl.textContent = err.message; // e.g. "EMP001 already exists" (section 20)
    }
  });

  document.getElementById("print-badges-btn").addEventListener("click", () => renderBadgeSheet(employees));

  // Lets you assign a department to an employee that doesn't have one yet
  // (e.g. anyone created before Department Master existed), or move them to
  // a different department later - without needing a full "edit employee" form.
  container.querySelectorAll(".btn-change-dept").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const panel = document.getElementById("dept-assign-panel");
      if (panel) panel.remove();

      const wrapper = document.createElement("div");
      wrapper.id = "dept-assign-panel";
      wrapper.className = "inline-form";
      wrapper.innerHTML = `
        <span>Department for <strong>${btn.dataset.name}</strong>:</span>
        <select id="dept-assign-select">
          <option value="">(no department)</option>
          ${activeDepartments.map((d) => `<option value="${d.department_id}" ${String(d.department_id) === btn.dataset.departmentId ? "selected" : ""}>${d.department_name}</option>`).join("")}
        </select>
        <button id="dept-assign-save">Save</button>
        <button type="button" id="dept-assign-cancel" class="btn-secondary">Cancel</button>
      `;
      btn.closest("tr").after(wrapper);
      wrapper.scrollIntoView({ behavior: "smooth", block: "center" });

      document.getElementById("dept-assign-cancel").addEventListener("click", () => wrapper.remove());
      document.getElementById("dept-assign-save").addEventListener("click", async () => {
        const select = document.getElementById("dept-assign-select");
        try {
          await Api.setEmployeeDepartment(btn.dataset.employeeId, select.value ? Number(select.value) : null);
          renderEmployeeMaster(container);
        } catch (err) {
          alert(err.message);
        }
      });
    });
  });
}

// Prints a physical ID badge (QR + name + code) per employee - for workers
// without a smartphone (e.g. drivers), scanned by security/staff on their
// behalf instead of the worker self-reporting via the app.
function renderBadgeSheet(employees) {
  const sheet = document.getElementById("badge-sheet");
  const withBadges = employees.filter((e) => e.badge_qr_token);

  if (!window.QRCode) {
    sheet.innerHTML = `<div class="error-text">QR library failed to load, so badges can't be rendered. Check your network/CDN access and reload.</div>`;
    return;
  }

  sheet.innerHTML = withBadges.map((e) => `
    <div class="badge-card">
      <canvas id="badge-qr-${e.employee_id}"></canvas>
      <div class="badge-info">
        <div class="name">${e.full_name}</div>
        <div>${e.emp_code}</div>
      </div>
    </div>
  `).join("");
  withBadges.forEach((e) => {
    const canvas = document.getElementById(`badge-qr-${e.employee_id}`);
    window.QRCode.toCanvas(canvas, e.badge_qr_token, { width: 100, margin: 1 }, (err) => {
      if (err) console.error("Badge QR render failed", err);
    });
  });
  setTimeout(() => window.print(), 300);
}
