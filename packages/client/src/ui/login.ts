/// <reference lib="dom" />
/**
 * Minimal login / register overlay.
 *
 * Shown whenever the client has no valid session token. On successful
 * login or registration the returned token is stored in localStorage and
 * the supplied `onAuthenticated(token)` callback fires, at which point
 * `main.ts` can proceed to start the game.
 *
 * Zero framework — this is a one-screen modal rendered imperatively into
 * a root element. The game's main UI uses Preact, but pulling that in for
 * a two-field form adds complexity without leverage, and this file runs
 * before the game's renderer boots.
 */

export const TOKEN_STORAGE_KEY = "voxim.session_token";

export interface LoginScreenConfig {
  /** Gateway base URL, e.g. "https://localhost:8080". */
  gatewayUrl: string;
  /** Mount point; contents are replaced. */
  container: HTMLElement;
  /** Called with the raw token on successful login/register. */
  onAuthenticated: (token: string) => void;
}

interface AuthResponse {
  userId: string;
  token: string;
  activeDynastyId: string;
  lastTileId?: string | null;
}

export function storeToken(token: string): void {
  try { localStorage.setItem(TOKEN_STORAGE_KEY, token); }
  catch { /* private-mode / disabled storage — token lives in memory for this tab only */ }
}

export function clearToken(): void {
  try { localStorage.removeItem(TOKEN_STORAGE_KEY); } catch { /* ignore */ }
}

export function loadToken(): string | null {
  try { return localStorage.getItem(TOKEN_STORAGE_KEY); } catch { return null; }
}

/**
 * Check a stored token with GET /account/me. Returns true if the token is
 * still accepted; false on 401 (in which case we clear storage and show
 * login). Network errors return null — caller decides whether to show
 * login or an offline message.
 */
export async function validateStoredToken(gatewayUrl: string, token: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${gatewayUrl}/account/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      clearToken();
      return false;
    }
    return res.ok;
  } catch {
    return null;
  }
}

export function showLoginScreen(config: LoginScreenConfig): void {
  const { gatewayUrl, container, onAuthenticated } = config;

  container.innerHTML = "";
  container.appendChild(buildRoot(gatewayUrl, onAuthenticated));
}

// ---- DOM construction ----
//
// Styles here inline the small amount the login page needs; they read from
// the same --col-* custom properties the game UI uses so palette changes
// propagate automatically.

const STYLES = `
.login-root {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--col-bg, #16130e);
  font-family: system-ui, sans-serif;
  color: var(--col-text, #d4c9a8);
  z-index: 100;
}
.login-card {
  background: var(--col-bg-raised, #1f1b14);
  border: 1px solid var(--col-border, #3d3428);
  border-radius: 8px;
  padding: 32px;
  width: 360px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.login-card h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.login-tabs {
  display: flex;
  border-bottom: 1px solid var(--col-border, #3d3428);
}
.login-tab {
  flex: 1;
  padding: 8px 0;
  background: transparent;
  border: none;
  color: var(--col-text-dim, #7a6f58);
  cursor: pointer;
  font: inherit;
}
.login-tab.active {
  color: var(--col-text, #d4c9a8);
  border-bottom: 2px solid var(--col-accent, #c8953a);
  margin-bottom: -1px;
}
.login-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--col-text-dim, #7a6f58);
}
.login-field input {
  padding: 8px;
  background: var(--col-bg, #16130e);
  border: 1px solid var(--col-border, #3d3428);
  border-radius: 4px;
  color: var(--col-text, #d4c9a8);
  font-size: 14px;
}
.login-field input:focus {
  outline: none;
  border-color: var(--col-border-bright, #5c4f38);
}
.login-submit {
  padding: 10px;
  background: var(--col-accent, #c8953a);
  border: none;
  border-radius: 4px;
  color: var(--col-bg, #16130e);
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
}
.login-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.login-error {
  color: var(--col-danger, #c04040);
  font-size: 12px;
  min-height: 16px;
}
`;

function buildRoot(gatewayUrl: string, onAuthenticated: (token: string) => void): HTMLElement {
  ensureStyles();

  const root = document.createElement("div");
  root.className = "login-root";

  const card = document.createElement("div");
  card.className = "login-card";
  root.appendChild(card);

  const title = document.createElement("h1");
  title.textContent = "Voxim";
  card.appendChild(title);

  // tabs
  const tabs = document.createElement("div");
  tabs.className = "login-tabs";
  const loginTab = makeTab("Log in", true);
  const registerTab = makeTab("Register", false);
  tabs.appendChild(loginTab);
  tabs.appendChild(registerTab);
  card.appendChild(tabs);

  // form
  const form = document.createElement("form");
  form.noValidate = true;
  card.appendChild(form);

  const { wrap: loginWrap, input: loginInput } = makeField("Login name", "text");
  const { wrap: pwWrap, input: pwInput } = makeField("Password", "password");
  form.appendChild(loginWrap);
  form.appendChild(pwWrap);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "login-submit";
  submit.textContent = "Log in";
  form.appendChild(submit);

  const error = document.createElement("div");
  error.className = "login-error";
  card.appendChild(error);

  let mode: "login" | "register" = "login";
  const setMode = (next: "login" | "register") => {
    mode = next;
    loginTab.classList.toggle("active", next === "login");
    registerTab.classList.toggle("active", next === "register");
    submit.textContent = next === "login" ? "Log in" : "Create account";
    error.textContent = "";
  };
  loginTab.addEventListener("click", () => setMode("login"));
  registerTab.addEventListener("click", () => setMode("register"));

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    error.textContent = "";
    const loginName = loginInput.value.trim();
    const password = pwInput.value;
    if (!loginName || !password) {
      error.textContent = "Both fields are required.";
      return;
    }
    if (mode === "register" && password.length < 6) {
      error.textContent = "Password must be at least 6 characters.";
      return;
    }

    submit.disabled = true;
    try {
      const path = mode === "login" ? "/account/login" : "/account/register";
      const res = await fetch(`${gatewayUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginName, password }),
      });

      if (res.status === 409) {
        error.textContent = "That login name is taken. Try another or log in.";
        return;
      }
      if (res.status === 401) {
        error.textContent = "Invalid login name or password.";
        return;
      }
      if (!res.ok) {
        error.textContent = `Unexpected error (${res.status}). Try again.`;
        return;
      }

      const data = await res.json() as AuthResponse;
      storeToken(data.token);
      // Remove ourselves from the DOM before starting the game — the game's
      // renderer wants the canvas uncovered.
      root.remove();
      onAuthenticated(data.token);
    } catch (err) {
      console.error("[login] network error:", err);
      error.textContent = "Could not reach the server. Check your connection and retry.";
    } finally {
      submit.disabled = false;
    }
  });

  // Focus the login field so users can just start typing.
  setTimeout(() => loginInput.focus(), 0);

  return root;
}

function makeTab(label: string, active: boolean): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "login-tab" + (active ? " active" : "");
  b.textContent = label;
  return b;
}

function makeField(label: string, type: "text" | "password"): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = document.createElement("label");
  wrap.className = "login-field";
  wrap.textContent = label;
  const input = document.createElement("input");
  input.type = type;
  input.autocomplete = type === "password" ? "current-password" : "username";
  wrap.appendChild(input);
  return { wrap, input };
}

let stylesInjected = false;
function ensureStyles(): void {
  if (stylesInjected) return;
  const s = document.createElement("style");
  s.textContent = STYLES;
  document.head.appendChild(s);
  stylesInjected = true;
}
