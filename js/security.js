// js/security.js
// Security scans/selects a pass and an employee within it, and records a
// GATE_OUT or GATE_IN. In production this form is driven by a QR scan that
// resolves directly to pass_id + employee_id; the manual selects here are the
// fallback / v1 baseline.

async function renderSecurityGate(container, direction) {
  const eventType = direction === "out" ? "GATE_OUT" : "GATE_IN";
  const passes = await Api.listGatePasses();
  const relevant = passes.filter((p) => p.status === "APPROVED" || p.status === "IN_PROGRESS");

  container.innerHTML = `
    <h2>Security Gate ${direction === "out" ? "Out" : "In"}</h2>
    <button id="scan-pass-qr" class="btn-secondary">Scan Pass QR</button>
    <form id="security-gate-form" class="stacked-form">
      <label>Pass
        <select name="pass_id" required>
          ${relevant.map((p) => `<option value="${p.pass_id}">${p.pass_number} - ${p.purpose}${p.pass_category === "EARLY_LEAVE" ? " (Early Leave - No Return)" : ""}</option>`).join("")}
        </select>
      </label>
      <div id="pass-members-container"></div>
      <div id="security-gate-error" class="error-text"></div>
      <button type="submit">Record Gate ${direction === "out" ? "Out" : "In"}</button>
    </form>
  `;

  const passSelect = container.querySelector("[name=pass_id]");
  const membersContainer = document.getElementById("pass-members-container");
  const errorEl0 = document.getElementById("security-gate-error");

  document.getElementById("scan-pass-qr").addEventListener("click", () => {
    openQrScanner(async (token) => {
      try {
        const resolved = await Api.resolveQr(token);
        if (resolved.type !== "pass") {
          errorEl0.textContent = "That QR code belongs to a location, not a pass.";
          return;
        }
        if (![...passSelect.options].some((o) => o.value === String(resolved.pass.pass_id))) {
          errorEl0.textContent = `Pass ${resolved.pass.pass_number} is not awaiting gate ${direction}.`;
          return;
        }
        passSelect.value = resolved.pass.pass_id;
        passSelect.dispatchEvent(new Event("change"));
      } catch (err) {
        errorEl0.textContent = err.message;
      }
    });
  });

  async function loadMembers() {
    if (!passSelect.value) return;
    const { pass, members } = await Api.getGatePass(passSelect.value);
    membersContainer.innerHTML = `
      <label>Employee
        <select name="employee_id" required>
          ${members.map((m) => `<option value="${m.employee_id}">${m.emp_code} - ${m.full_name} (${formatMemberStatus(pass.status, m.member_status)})</option>`).join("")}
        </select>
      </label>
    `;
  }
  passSelect.addEventListener("change", loadMembers);
  await loadMembers();

  document.getElementById("security-gate-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const btn = event.target.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "SUBMITTING...";
    const errorEl = document.getElementById("security-gate-error");
    errorEl.textContent = "";

    const form = new FormData(event.target);
    try {
      await Api.recordMovement({
        pass_id: Number(form.get("pass_id")),
        employee_id: Number(form.get("employee_id")),
        event_type: eventType,
        idempotency_key: window.newIdempotencyKey(),
      });
      btn.textContent = "Recorded";
      setTimeout(() => renderSecurityGate(container, direction), 1000);
    } catch (err) {
      errorEl.textContent = err.message;
      btn.disabled = false;
      btn.textContent = `Record Gate ${direction === "out" ? "Out" : "In"}`;
    }
  });
}
