// js/approvals.js
async function renderApprovals(container) {
  container.innerHTML = `<div class="loading">Loading pending approvals...</div>`;
  const pending = await Api.listPendingApprovals();
  container.innerHTML = `
    <h2>HOD Approval</h2>
    <table class="data-table">
      <thead><tr><th>Pass #</th><th>Leader</th><th>Department</th><th>Purpose</th><th>Actions</th></tr></thead>
      <tbody>
        ${pending.map((p) => `
          <tr>
            <td data-label="Pass #">${p.pass_number}</td>
            <td data-label="Leader">${p.leader_name}</td>
            <td data-label="Department">${p.leader_department || "-"}</td>
            <td data-label="Purpose">${p.purpose}</td>
            <td>
              <button class="btn-approve" data-pass-id="${p.pass_id}">Approve</button>
              <button class="btn-reject" data-pass-id="${p.pass_id}">Reject</button>
            </td>
          </tr>
        `).join("") || `<tr><td colspan="5">Nothing pending approval.</td></tr>`}
      </tbody>
    </table>
  `;

  container.querySelectorAll(".btn-approve, .btn-reject").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const decision = btn.classList.contains("btn-approve") ? "APPROVED" : "REJECTED";
      try {
        await Api.decidePass(btn.dataset.passId, decision, null);
        renderApprovals(container);
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });
}
