interface LoginPageOptions {
  loginRequest?: string;
  clientName?: string;
  error?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The sign-in page shown during the OAuth authorization step. It gets used on
 * a phone as often as a laptop, so it stays a single centred column and picks
 * up the device's colour scheme.
 */
export function renderLoginPage({ loginRequest, clientName, error }: LoginPageOptions): string {
  const app = clientName ? escapeHtml(clientName) : 'An application';

  const form = loginRequest
    ? `<form method="post" action="/login">
        <input type="hidden" name="login_request" value="${escapeHtml(loginRequest)}">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
        <button type="submit">Sign in</button>
      </form>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in - Oura MCP</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; margin: 0; padding: 1.5rem; box-sizing: border-box;
    background: Canvas; color: CanvasText;
  }
  main { width: 100%; max-width: 22rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { margin: 0 0 1.5rem; opacity: 0.75; font-size: 0.9rem; line-height: 1.45; }
  label { display: block; font-size: 0.85rem; margin-bottom: 0.35rem; }
  input, button {
    width: 100%; box-sizing: border-box; font-size: 1rem;
    padding: 0.65rem 0.75rem; border-radius: 0.5rem;
    border: 1px solid color-mix(in srgb, CanvasText 30%, transparent);
    background: Field; color: FieldText;
  }
  button {
    margin-top: 1rem; border: none; cursor: pointer;
    background: AccentColor; color: AccentColorText; font-weight: 600;
  }
  .error {
    margin-bottom: 1rem; padding: 0.65rem 0.75rem; border-radius: 0.5rem;
    font-size: 0.85rem; background: color-mix(in srgb, #d33 18%, transparent);
  }
</style>
</head>
<body>
<main>
  <h1>Oura MCP</h1>
  <p>${app} is requesting access to your Oura Ring data.</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
  ${form}
</main>
</body>
</html>`;
}
