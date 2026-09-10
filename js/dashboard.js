// js/dashboard.js
async function renderDashboard(container) {
  container.innerHTML = `<div class="loading">Loading live status...</div>`;
  try {
    const status = await Api.liveStatus();
    container.innerHTML = `
      <h2>Live Employee Status</h2>
      <div class="status-cards">
        <div class="status-card status-inside"><span class="count">${status.inside}</span><span class="label">INSIDE</span></div>
        <div class="status-card status-outside"><span class="count">${status.outside}</span><span class="label">OUTSIDE</span></div>
        <div class="status-card status-internal"><span class="count">${status.at_internal_location}</span><span class="label">INTERNAL LOCATION</span></div>
        <div class="status-card status-external"><span class="count">${status.at_external_location}</span><span class="label">EXTERNAL VISIT</span></div>
        <div class="status-card status-overdue"><span class="count">${status.overdue}</span><span class="label">OVERDUE</span></div>
      </div>
      <h3>Currently Outside</h3>
      <table class="data-table">
        <thead><tr><th>Employee</th><th>Status</th><th>Pass</th><th>Expected Return</th></tr></thead>
        <tbody>
          ${status.details.map((d) => `
            <tr class="${d.overdue ? "row-overdue" : ""}">
              <td>${d.full_name}</td>
              <td>${d.member_status}</td>
              <td>${d.pass_number}</td>
              <td>${d.expected_return ? new Date(d.expected_return).toLocaleString() : "-"}</td>
            </tr>
          `).join("") || `<tr><td colspan="4">No one is currently outside.</td></tr>`}
        </tbody>
      </table>
    `;
  } catch (err) {
    container.innerHTML = `<div class="error-text">Could not load dashboard: ${err.message}</div>`;
  }
}
