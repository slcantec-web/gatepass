// js/app.js
const NAV_ITEMS = [
  { hash: "#/dashboard", label: "Dashboard", roles: ["SUPER_ADMIN", "ADMIN", "HOD", "SECURITY", "MANAGEMENT_VIEWER"] },
  { hash: "#/my-passes", label: "My Gate Passes", roles: ["SUPER_ADMIN", "ADMIN", "HOD", "EMPLOYEE"] },
  { hash: "#/create-pass", label: "Create Pass", roles: ["SUPER_ADMIN", "ADMIN", "HOD", "EMPLOYEE"] },
  { hash: "#/approvals", label: "HOD Approval", roles: ["SUPER_ADMIN", "ADMIN", "HOD"] },
  { hash: "#/security/out", label: "Security Gate Out", roles: ["SUPER_ADMIN", "ADMIN", "SECURITY"] },
  { hash: "#/security/in", label: "Security Gate In", roles: ["SUPER_ADMIN", "ADMIN", "SECURITY"] },
  { hash: "#/location-check", label: "Location Check", roles: ["SUPER_ADMIN", "ADMIN", "EMPLOYEE"] },
  { hash: "#/assisted-check", label: "Assisted Check", roles: ["SUPER_ADMIN", "ADMIN", "SECURITY"] },
  { hash: "#/employees", label: "Employee Master", roles: ["SUPER_ADMIN", "ADMIN"] },
  { hash: "#/locations", label: "Location Master", roles: ["SUPER_ADMIN", "ADMIN"] },
  { hash: "#/users", label: "User Management", roles: ["SUPER_ADMIN", "ADMIN"] },
  { hash: "#/audit", label: "Audit Log", roles: ["SUPER_ADMIN", "ADMIN"] },
];

function renderNav() {
  const nav = document.getElementById("app-nav");
  if (!window.CurrentUser) { nav.innerHTML = ""; return; }
  const items = NAV_ITEMS.filter((item) => item.roles.includes(window.CurrentUser.role));
  nav.innerHTML = items.map((item) => `<a href="${item.hash}" class="nav-link">${item.label}</a>`).join("") +
    `<a href="#" id="logout-link" class="nav-link nav-link-logout">Logout</a>`;
  document.getElementById("logout-link").addEventListener("click", (e) => { e.preventDefault(); handleLogout(); });
}

async function renderApp() {
  const main = document.getElementById("app-main");
  const hash = window.location.hash || "#/dashboard";

  if (!window.CurrentUser) {
    document.getElementById("app-nav").innerHTML = "";
    renderLoginScreen(main);
    return;
  }

  renderNav();

  const passMatch = hash.match(/^#\/passes\/(\d+)$/);

  try {
    if (hash === "#/dashboard") return renderDashboard(main);
    if (hash === "#/my-passes") return renderMyPasses(main);
    if (hash === "#/create-pass") return renderCreatePass(main);
    if (hash === "#/approvals") return renderApprovals(main);
    if (hash === "#/security/out") return renderSecurityGate(main, "out");
    if (hash === "#/security/in") return renderSecurityGate(main, "in");
    if (hash === "#/location-check") return renderLocationCheck(main);
    if (hash === "#/assisted-check") return renderAssistedCheck(main);
    if (hash === "#/employees") return renderEmployeeMaster(main);
    if (hash === "#/locations") return renderLocationMaster(main);
    if (hash === "#/users") return renderUserManagement(main);
    if (hash === "#/audit") return renderAuditLog(main);
    if (passMatch) return renderPassDetails(main, passMatch[1]);

    window.location.hash = "#/dashboard";
  } catch (err) {
    main.innerHTML = `<div class="error-text">Something went wrong: ${err.message}</div>`;
  }
}

window.addEventListener("hashchange", renderApp);

window.addEventListener("DOMContentLoaded", async () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  await tryRestoreSession();
  renderApp();
});
