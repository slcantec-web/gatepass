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
      <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Status</th><th></th></tr></thead>
      <tbody>${locations.map((l) => `
        <tr>
          <td>${l.location_code}</td><td>${l.location_name}</td><td>${l.location_type}</td><td>${l.status}</td>
          <td><button class="btn-link btn-show-qr" data-token="${l.qr_code_token}" data-name="${l.location_name}">Show QR</button></td>
        </tr>
      `).join("")}</tbody>
    </table>
  `;

  container.querySelectorAll(".btn-show-qr").forEach((btn) => {
    btn.addEventListener("click", () => renderQrModal(btn.dataset.name, btn.dataset.token));
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
