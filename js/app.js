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
  { hash: "#/settings", label: "System Settings", roles: ["SUPER_ADMIN"] },
  { hash: "#/audit", label: "Audit Log", roles: ["SUPER_ADMIN", "ADMIN"] },
];

function pageTitleFor(hash) {
  const item = NAV_ITEMS.find((i) => i.hash === hash);
  if (item) return item.label;
  if (/^#\/passes\/\d+$/.test(hash)) return "Pass Details";
  return "Gate Pass System";
}

function renderNav() {
  const nav = document.getElementById("app-nav");
  const footer = document.getElementById("sidebar-footer");
  const backBtn = document.getElementById("back-button");
  if (!window.CurrentUser) { nav.innerHTML = ""; footer.innerHTML = ""; if (backBtn) backBtn.style.display = "none"; return; }

  const currentHash = window.location.hash || "#/dashboard";
  const items = NAV_ITEMS.filter((item) => item.roles.includes(window.CurrentUser.role));
  nav.innerHTML = items.map((item) =>
    `<a href="${item.hash}" class="nav-link${item.hash === currentHash ? " active" : ""}">${item.label}</a>`
  ).join("");

  // Hide the Back button on whatever counts as "home" for this role (their
  // first nav item) - there's nothing useful to go back to from there.
  if (backBtn) {
    const landingHash = items[0] ? items[0].hash : "#/dashboard";
    backBtn.style.display = currentHash === landingHash ? "none" : "inline-flex";
  }

  footer.innerHTML = `<a href="#" id="logout-link" class="nav-link nav-link-logout">Logout</a>`;
  document.getElementById("logout-link").addEventListener("click", (e) => { e.preventDefault(); handleLogout(); });

  document.getElementById("topbar-user").innerHTML = window.CurrentUser
    ? `${window.CurrentUser.username}<span class="user-role">${window.CurrentUser.role.replace("_", " ")}</span>`
    : "";
}

function closeMobileSidebar() {
  document.getElementById("app-sidebar").classList.remove("open");
  document.getElementById("sidebar-backdrop").classList.remove("open");
}

async function renderApp() {
  const main = document.getElementById("app-main");
  const hash = window.location.hash || "#/dashboard";
  closeMobileSidebar();

  if (!window.CurrentUser) {
    document.getElementById("app-nav").innerHTML = "";
    document.getElementById("sidebar-footer").innerHTML = "";
    document.getElementById("topbar-user").innerHTML = "";
    document.getElementById("page-title").textContent = "";
    document.getElementById("back-button").style.display = "none";
    renderLoginScreen(main);
    return;
  }

  renderNav();
  document.getElementById("page-title").textContent = pageTitleFor(hash);

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
    if (hash === "#/settings") return renderSystemSettings(main);
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
    let refreshed = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshed) return;
      refreshed = true;
      window.location.reload();
    });
  }

  document.getElementById("sidebar-toggle").addEventListener("click", () => {
    document.getElementById("app-sidebar").classList.toggle("open");
    document.getElementById("sidebar-backdrop").classList.toggle("open");
  });
  document.getElementById("sidebar-backdrop").addEventListener("click", closeMobileSidebar);

  // Every hash change (including the ones this app sets programmatically,
  // e.g. after creating a pass) pushes a real history entry, so browser-style
  // Back works reliably here even though the app has no visible browser
  // chrome once installed as a standalone PWA.
  document.getElementById("back-button").addEventListener("click", () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.hash = "#/dashboard";
    }
  });

  await tryRestoreSession();
  renderApp();
});
