// js/auth.js
window.CurrentUser = null;

async function tryRestoreSession() {
  try {
    const { user } = await Api.me();
    window.CurrentUser = user;
    return user;
  } catch {
    window.CurrentUser = null;
    return null;
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const submitBtn = form.querySelector("button[type=submit]");
  const errorEl = document.getElementById("login-error");
  errorEl.textContent = "";
  submitBtn.disabled = true;
  submitBtn.textContent = "Signing in...";

  try {
    const username = form.username.value.trim();
    const password = form.password.value;
    const user = await Api.login(username, password);
    window.CurrentUser = user;
    window.location.hash = "#/dashboard";
    renderApp();
  } catch (err) {
    errorEl.textContent = err.message || "Login failed";
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Sign In";
  }
}

async function handleLogout() {
  await Api.logout().catch(() => {});
  window.CurrentUser = null;
  window.location.hash = "#/login";
  renderApp();
}

function renderLoginScreen(container) {
  container.innerHTML = `
    <div class="login-screen">
      <form id="login-form" class="login-card">
        <h1>Gate Pass System</h1>
        <p class="subtitle">Sign in to continue</p>
        <label>Username
          <input
            name="username"
            autocomplete="username"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            required
          />
        </label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required /></label>
        <div id="login-error" class="error-text"></div>
        <button type="submit">Sign In</button>
      </form>
    </div>
  `;
  document.getElementById("login-form").addEventListener("submit", handleLoginSubmit);
}
