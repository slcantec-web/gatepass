// js/users.js
const USER_ROLES = ["SUPER_ADMIN", "ADMIN", "HOD", "EMPLOYEE", "SECURITY", "MANAGEMENT_VIEWER"];

async function renderUserManagement(container) {
  const [users, employees] = await Promise.all([Api.listUsers(), Api.listEmployees()]);

  container.innerHTML = `
    <h2>User Management</h2>
    <form id="add-user-form" class="inline-form">
      <input name="username" placeholder="Username" required />
      <input name="password" type="password" placeholder="Password (min 8 chars)" required minlength="8" />
      <select name="role" required>
        ${USER_ROLES.map((r) => `<option value="${r}">${r}</option>`).join("")}
      </select>
      <select name="employee_id">
        <option value="">(no linked employee)</option>
        ${employees.map((e) => `<option value="${e.employee_id}">${e.emp_code} - ${e.full_name}</option>`).join("")}
      </select>
      <button type="submit">Add User</button>
    </form>
    <div id="add-user-error" class="error-text"></div>
    <table class="data-table">
      <thead><tr><th>Username</th><th>Role</th><th>Employee</th><th>Status</th><th>Last Login</th><th></th></tr></thead>
      <tbody>
        ${users.map((u) => `
          <tr>
            <td>${u.username}</td>
            <td>${u.role}</td>
            <td>${u.employee_name || "-"}</td>
            <td>${u.status}</td>
            <td>${u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "Never"}</td>
            <td><button class="btn-link btn-toggle-status" data-user-id="${u.user_id}" data-status="${u.status}">
              ${u.status === "ACTIVE" ? "Deactivate" : "Activate"}
            </button></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  document.getElementById("add-user-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById("add-user-error");
    errorEl.textContent = "";
    const form = new FormData(event.target);
    try {
      await Api.createUser({
        username: form.get("username").trim(),
        password: form.get("password"),
        role: form.get("role"),
        employee_id: form.get("employee_id") ? Number(form.get("employee_id")) : null,
      });
      renderUserManagement(container);
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  container.querySelectorAll(".btn-toggle-status").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const newStatus = btn.dataset.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
      try {
        await Api.setUserStatus(btn.dataset.userId, newStatus);
        renderUserManagement(container);
      } catch (err) {
        alert(err.message);
      }
    });
  });
}
