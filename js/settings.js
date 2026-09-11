// js/settings.js
// System Settings (Super Admin only): toggle whether the "Print Pass Slip"
// feature is offered at all, and what paper size it prints to. Shared with
// gatepass.js, which reads these same presets when building the print window.

const PAPER_PRESETS = {
  A4: { label: "A4 (210 x 297 mm)", width: 210, height: 297 },
  A5: { label: "A5 (148 x 210 mm)", width: 148, height: 210 },
  LETTER: { label: "Letter (215.9 x 279.4 mm)", width: 215.9, height: 279.4 },
  THERMAL_80MM: { label: "Thermal receipt printer (80mm roll)", width: 80, height: null },
  THERMAL_58MM: { label: "Thermal receipt printer (58mm roll)", width: 58, height: null },
  CUSTOM: { label: "Custom size" },
};

// Builds the CSS value for @page { size: ... } from the current settings.
// A null height (thermal rolls) becomes "auto" - continuous-feed paper.
function paperSizeCss(settings) {
  const key = settings.print_paper_size || "A4";
  if (key === "CUSTOM") {
    const w = settings.print_custom_width_mm || "80";
    const h = settings.print_custom_height_mm || "150";
    return `${w}mm ${h}mm`;
  }
  const preset = PAPER_PRESETS[key];
  if (!preset) return "A4";
  return preset.height == null ? `${preset.width}mm auto` : `${preset.width}mm ${preset.height}mm`;
}

async function renderSystemSettings(container) {
  const settings = await Api.getSettings();
  container.innerHTML = `
    <h2>System Settings</h2>
    <form id="settings-form" class="stacked-form">
      <label style="flex-direction: row; align-items: center; gap: 0.5rem;">
        <input type="checkbox" name="print_enabled" ${settings.print_enabled === "true" ? "checked" : ""} style="width:auto;" />
        Enable Gate Pass printing ("Print Pass Slip" button on Pass Details)
      </label>

      <label>Paper Size
        <select name="print_paper_size">
          ${Object.entries(PAPER_PRESETS).map(([key, p]) =>
            `<option value="${key}" ${settings.print_paper_size === key ? "selected" : ""}>${p.label}</option>`
          ).join("")}
        </select>
      </label>

      <div id="custom-size-fields" style="display: ${settings.print_paper_size === "CUSTOM" ? "flex" : "none"}; gap: 1rem;">
        <label style="flex: 1;">Custom Width (mm)<input type="number" min="10" name="print_custom_width_mm" value="${settings.print_custom_width_mm}" /></label>
        <label style="flex: 1;">Custom Height (mm)<input type="number" min="10" name="print_custom_height_mm" value="${settings.print_custom_height_mm}" /></label>
      </div>

      <div id="settings-error" class="error-text"></div>
      <button type="submit">Save Settings</button>
    </form>
  `;

  const paperSelect = document.querySelector("[name=print_paper_size]");
  paperSelect.addEventListener("change", () => {
    document.getElementById("custom-size-fields").style.display = paperSelect.value === "CUSTOM" ? "flex" : "none";
  });

  document.getElementById("settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById("settings-error");
    errorEl.style.color = "";
    errorEl.textContent = "";
    const form = new FormData(event.target);
    try {
      await Api.updateSettings({
        print_enabled: form.get("print_enabled") ? "true" : "false",
        print_paper_size: form.get("print_paper_size"),
        print_custom_width_mm: form.get("print_custom_width_mm"),
        print_custom_height_mm: form.get("print_custom_height_mm"),
      });
      errorEl.style.color = "var(--success)";
      errorEl.textContent = "Settings saved.";
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}
