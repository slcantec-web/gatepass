// js/departments.js

async function renderDepartmentMaster(container) {
  const [departments, employees] = await Promise.all([Api.listDepartments(), Api.listEmployees()]);

  container.innerHTML = `
    <h2>Department Master</h2>
    <form id="add-department-form" class="inline-form">
      <input name="department_code" placeholder="Code (e.g. SALES)" required />
      <input name="department_name" placeholder="Name (e.g. Sales)" required />
      <select name="hod_employee_id">
        <option value="">(no HOD assigned yet)</option>
        ${employees.map((e) => `<option value="${e.employee_id}">${e.emp_code} - ${e.full_name}</option>`).join("")}
      </select>
      <button type="submit">Add Department</button>
    </form>
    <div id="add-department-error" class="error-text"></div>

    <table class="data-table">
      <thead><tr><th>Code</th><th>Name</th><th>HOD</th><th>Employees</th><th>Status</th><th></th></tr></thead>
      <tbody>${departments.map((d) => `
        <tr class="${d.status === "INACTIVE" ? "row-inactive" : ""}">
          <td data-label="Code">${d.department_code}</td>
          <td data-label="Name">${d.department_name}</td>
          <td data-label="HOD">${d.hod_name || `<span class="hint-text">Not set</span>`}</td>
          <td data-label="Employees">${d.employee_count}</td>
          <td data-label="Status">${d.status}</td>
          <td>
            <button class="btn-link btn-edit-dept" data-department-id="${d.department_id}" data-name="${d.department_name}" data-hod-id="${d.hod_employee_id || ""}">Edit</button>
            <button class="btn-link btn-toggle-dept-status" data-department-id="${d.department_id}" data-status="${d.status}" data-name="${d.department_name}">
              ${d.status === "ACTIVE" ? "Delete" : "Restore"}
            </button>
          </td>
        </tr>
      `).join("") || `<tr><td colspan="6">No departments yet - add one above.</td></tr>`}</tbody>
    </table>
    <div id="edit-department-panel"></div>
  `;

  document.getElementById("add-department-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById("add-department-error");
    errorEl.textContent = "";
    const form = new FormData(event.target);
    try {
      await Api.createDepartment({
        department_code: form.get("department_code").trim(),
        department_name: form.get("department_name").trim(),
        hod_employee_id: form.get("hod_employee_id") ? Number(form.get("hod_employee_id")) : null,
      });
      renderDepartmentMaster(container);
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  container.querySelectorAll(".btn-edit-dept").forEach((btn) => {
    btn.addEventListener("click", () => {
      const panel = document.getElementById("edit-department-panel");
      panel.innerHTML = `
        <form id="edit-department-form" class="inline-form">
          <span>Editing <strong>${btn.dataset.name}</strong>:</span>
          <input name="department_name" value="${btn.dataset.name}" required />
          <select name="hod_employee_id">
            <option value="">(no HOD assigned)</option>
            ${employees.map((e) => `<option value="${e.employee_id}" ${String(e.employee_id) === btn.dataset.hodId ? "selected" : ""}>${e.emp_code} - ${e.full_name}</option>`).join("")}
          </select>
          <button type="submit">Save</button>
          <button type="button" id="cancel-edit-dept" class="btn-secondary">Cancel</button>
        </form>
        <div id="edit-department-error" class="error-text"></div>
      `;
      panel.scrollIntoView({ behavior: "smooth", block: "center" });

      document.getElementById("cancel-edit-dept").addEventListener("click", () => { panel.innerHTML = ""; });

      document.getElementById("edit-department-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const errorEl = document.getElementById("edit-department-error");
        errorEl.textContent = "";
        const form = new FormData(event.target);
        try {
          await Api.updateDepartment(btn.dataset.departmentId, {
            department_name: form.get("department_name").trim(),
            hod_employee_id: form.get("hod_employee_id") ? Number(form.get("hod_employee_id")) : null,
          });
          renderDepartmentMaster(container);
        } catch (err) {
          errorEl.textContent = err.message;
        }
      });
    });
  });

  // "Delete" is a soft delete (status -> INACTIVE): departments referenced by
  // employees can't be safely hard-deleted, and the backend already blocks
  // this if active employees are still assigned - reassign them first.
  container.querySelectorAll(".btn-toggle-dept-status").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const deleting = btn.dataset.status === "ACTIVE";
      if (deleting && !confirm(`Delete "${btn.dataset.name}"? This only works if no active employees are assigned to it, and can be undone with Restore.`)) {
        return;
      }
      btn.disabled = true;
      try {
        await Api.setDepartmentStatus(btn.dataset.departmentId, deleting ? "INACTIVE" : "ACTIVE");
        renderDepartmentMaster(container);
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });
}
