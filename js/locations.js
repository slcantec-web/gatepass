// js/locations.js
const LOCATION_TYPES = ["HEAD_OFFICE", "FACTORY", "WAREHOUSE", "BRANCH", "INTERNAL", "CUSTOMER", "SUPPLIER", "EXTERNAL", "OTHER"];

async function renderLocationMaster(container) {
  const locations = await Api.listLocations();
  container.innerHTML = `
    <h2>Location Master</h2>
    <form id="add-location-form" class="inline-form">
      <input name="location_code" placeholder="Code (e.g. FAC-A)" required />
      <input name="location_name" placeholder="Name" required />
      <select name="location_type" required>
        ${LOCATION_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("")}
      </select>
      <button type="submit">Add Location</button>
    </form>
    <div id="add-location-error" class="error-text"></div>
    <table class="data-table">
      <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Status</th><th>QR Code</th><th></th></tr></thead>
      <tbody>${locations.map((l) => `
        <tr class="${l.status === "INACTIVE" ? "row-inactive" : ""}">
          <td data-label="Code">${l.location_code}</td>
          <td data-label="Name">${l.location_name}</td>
          <td data-label="Type">${l.location_type}</td>
          <td data-label="Status">${l.status}</td>
          <td data-label="QR Code">
            ${l.qr_code_token
              ? `<button class="btn-link btn-show-qr" data-token="${l.qr_code_token}" data-name="${l.location_name}">Show QR</button>`
              : `<span class="hint-text">No QR yet</span>`}
            <button class="btn-link btn-regen-qr" data-location-id="${l.location_id}" data-name="${l.location_name}">${l.qr_code_token ? "Regenerate" : "Generate"} QR</button>
          </td>
          <td>
            <button class="btn-link btn-toggle-location-status" data-location-id="${l.location_id}" data-status="${l.status}" data-name="${l.location_name}">
              ${l.status === "ACTIVE" ? "Delete" : "Restore"}
            </button>
          </td>
        </tr>
      `).join("")}</tbody>
    </table>
  `;

  container.querySelectorAll(".btn-show-qr").forEach((btn) => {
    btn.addEventListener("click", () => renderQrModal(btn.dataset.name, btn.dataset.token));
  });

  // Backfills a token for locations created before QR support existed (still
  // NULL in the DB), or rotates the existing one if you want to invalidate
  // whatever was printed/shown before.
  container.querySelectorAll(".btn-regen-qr").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const originalLabel = btn.textContent;
      btn.textContent = "Working...";
      try {
        const result = await Api.regenerateLocationQr(btn.dataset.locationId);
        await renderLocationMaster(container);
        renderQrModal(btn.dataset.name, result.qr_code_token);
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    });
  });

  // "Delete" is a soft delete (status -> INACTIVE): it hides the location from
  // pass creation and check-in pickers everywhere else, but keeps history for
  // any past gate passes/movement events intact, and can be undone with Restore.
  container.querySelectorAll(".btn-toggle-location-status").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const deleting = btn.dataset.status === "ACTIVE";
      if (deleting && !confirm(`Delete "${btn.dataset.name}"? It will be hidden from pass creation and check-in screens, but its history is kept and it can be restored later.`)) {
        return;
      }
      btn.disabled = true;
      try {
        await Api.setLocationStatus(btn.dataset.locationId, deleting ? "INACTIVE" : "ACTIVE");
        renderLocationMaster(container);
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });

  document.getElementById("add-location-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById("add-location-error");
    errorEl.textContent = "";
    const form = new FormData(event.target);
    try {
      await Api.createLocation({
        location_code: form.get("location_code").trim(),
        location_name: form.get("location_name").trim(),
        location_type: form.get("location_type"),
      });
      renderLocationMaster(container);
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}
