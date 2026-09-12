// js/dashboard.js
let __dashboardChart = null;

async function renderDashboard(container) {
  container.innerHTML = `<div class="loading">Loading live status...</div>`;
  try {
    const status = await Api.liveStatus();
    container.innerHTML = `
      <div class="status-cards">
        <div class="status-card status-inside"><span class="count">${status.inside}</span><span class="label">Inside</span></div>
        <div class="status-card status-outside"><span class="count">${status.outside}</span><span class="label">Outside</span></div>
        <div class="status-card status-internal"><span class="count">${status.at_internal_location}</span><span class="label">Internal Location</span></div>
        <div class="status-card status-external"><span class="count">${status.at_external_location}</span><span class="label">External Visit</span></div>
        <div class="status-card status-overdue"><span class="count">${status.overdue}</span><span class="label">Overdue</span></div>
      </div>

      <div class="dashboard-grid">
        <div class="chart-card">
          <h3>Status Breakdown</h3>
          <canvas id="status-chart"></canvas>
        </div>
        <div class="chart-card">
          <h3>Currently Outside</h3>
          <table class="data-table">
            <thead><tr><th>Employee</th><th>Status</th><th>Pass</th><th>Expected Return</th></tr></thead>
            <tbody>
              ${status.details.map((d) => `
                <tr class="${d.overdue ? "row-overdue" : ""}">
                  <td>${d.full_name}</td>
                  <td>${formatMemberStatus("APPROVED", d.member_status)}</td>
                  <td>${d.pass_number}</td>
                  <td>${d.expected_return ? new Date(d.expected_return).toLocaleString() : "-"}</td>
                </tr>
              `).join("") || `<tr><td colspan="4">No one is currently outside.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;

    renderStatusChart(status);
  } catch (err) {
    container.innerHTML = `<div class="error-text">Could not load dashboard: ${err.message}</div>`;
  }
}

function renderStatusChart(status) {
  const canvas = document.getElementById("status-chart");
  if (!canvas || !window.Chart) return;

  const data = {
    labels: ["Inside", "Outside", "Internal Location", "External Visit", "Overdue"],
    datasets: [{
      data: [status.inside, status.outside, status.at_internal_location, status.at_external_location, status.overdue],
      backgroundColor: ["#10b981", "#4f46e5", "#f59e0b", "#f59e0b", "#ef4444"],
      borderWidth: 0,
    }],
  };

  if (__dashboardChart) __dashboardChart.destroy();
  __dashboardChart = new window.Chart(canvas, {
    type: "doughnut",
    data,
    options: {
      responsive: true,
      cutout: "65%",
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } },
      },
    },
  });
}
