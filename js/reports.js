// js/reports.js
// V1 placeholder - section 22 lists the full future report set (Daily Gate Pass,
// Employee Movement, Department Movement, Overdue, etc). This renders the raw
// audit log for now; dedicated report queries can be added without changing
// the core movement model.

async function renderAuditLog(container) {
  container.innerHTML = `<div class="loading">Loading audit log...</div>`;
  const rows = await Api.auditLog();
  container.innerHTML = `
    <h2>Audit Log</h2>
    <table class="data-table">
      <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Record</th></tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td>${new Date(r.created_at).toLocaleString()}</td>
            <td>${r.user_id ?? "-"}</td>
            <td>${r.action}</td>
            <td>${r.record_type ? `${r.record_type} #${r.record_id}` : "-"}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}
