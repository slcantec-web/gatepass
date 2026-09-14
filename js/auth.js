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
    // Passwords can legitimately contain spaces, so this doesn't trim
    // whitespace generally - but a single-line input can never hold an
    // actually-*typed* newline/carriage-return, so any that show up here
    // only got in via a copy-paste (e.g. from a Notes app or a chat message)
    // and stripping them can't break a real password. This is the classic
    // "works on PC, fails on mobile" bug: a password pasted on a phone from
    // somewhere else often carries an invisible trailing line-break that
    // typing the same password on a PC keyboard never introduces.
    const password = form.password.value.replace(/^[\r\n]+|[\r\n]+$/g, "");
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
