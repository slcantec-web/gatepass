// js/users.js
const USER_ROLES = ["SUPER_ADMIN", "ADMIN", "HOD", "EMPLOYEE", "SECURITY", "MANAGEMENT_VIEWER"];

async function renderUserManagement(container) {
  const [users, employees] = await Promise.all([Api.listUsers(), Api.listEmployees()]);

  container.innerHTML = `
    <h2>User Management</h2>
    <form id="add-user-form" class="inline-form">
      <input name="username" placeholder="Username" required />
      <input name="password" type="password" placeholder="Password (min 8 chars)" required minlength="8" autocapitalize="none" autocorrect="off" spellcheck="false" />
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
      <thead><tr><th>Username</th><th>Role</th><th>Employee</th><th>Department</th><th>Status</th><th>Last Login</th><th></th></tr></thead>
      <tbody>
        ${users.map((u) => `
          <tr>
            <td data-label="Username">${u.username}</td>
            <td data-label="Role">${u.role}</td>
            <td data-label="Employee">${u.employee_name || "-"}</td>
            <td data-label="Department">${u.department_name || (u.role === "HOD" ? `<span class="hint-text">Set via Employee Master</span>` : "-")}</td>
            <td data-label="Status">${u.status}</td>
            <td data-label="Last Login">${u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "Never"}</td>
            <td>
              <button class="btn-link btn-toggle-status" data-user-id="${u.user_id}" data-status="${u.status}">
                ${u.status === "ACTIVE" ? "Deactivate" : "Activate"}
              </button>
              <button class="btn-link btn-reset-password" data-user-id="${u.user_id}" data-username="${u.username}">Reset Password</button>
              ${u.user_id !== window.CurrentUser.userId ? `<button class="btn-link btn-delete-user" data-user-id="${u.user_id}" data-username="${u.username}" style="color: var(--danger);">Delete</button>` : ""}
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    <div id="reset-password-panel"></div>
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

  container.querySelectorAll(".btn-reset-password").forEach((btn) => {
    btn.addEventListener("click", () => {
      const panel = document.getElementById("reset-password-panel");
      panel.innerHTML = `
        <form id="reset-password-form" class="inline-form">
          <span>New password for <strong>${btn.dataset.username}</strong>:</span>
          <input name="new_password" type="text" placeholder="New password (min 8 chars)" minlength="8" required autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" />
          <button type="submit">Set New Password</button>
          <button type="button" id="cancel-reset-password" class="btn-secondary">Cancel</button>
        </form>
        <div id="reset-password-error" class="error-text"></div>
      `;
      panel.scrollIntoView({ behavior: "smooth", block: "center" });

      document.getElementById("cancel-reset-password").addEventListener("click", () => { panel.innerHTML = ""; });

      document.getElementById("reset-password-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const errorEl = document.getElementById("reset-password-error");
        errorEl.textContent = "";
        const newPassword = new FormData(event.target).get("new_password");
        try {
          await Api.resetPassword(btn.dataset.userId, newPassword);
          panel.innerHTML = `<p style="color: var(--success); font-weight: 600;">Password updated for ${btn.dataset.username}. They'll need to log in again with the new password.</p>`;
        } catch (err) {
          errorEl.textContent = err.message;
        }
      });
    });
  });

  // Hard delete - the backend refuses (409) if the account has any audit-trail
  // history (created a gate pass, recorded a movement, or made an approval
  // decision) and tells you to deactivate instead. So this is safe to offer
  // on every account: it either removes an unused login cleanly, or gives
  // you a clear reason it won't.
  container.querySelectorAll(".btn-delete-user").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm(`Delete user '${btn.dataset.username}'? This cannot be undone.`)) return;
      btn.disabled = true;
      try {
        await Api.deleteUser(btn.dataset.userId);
        renderUserManagement(container);
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });
}
