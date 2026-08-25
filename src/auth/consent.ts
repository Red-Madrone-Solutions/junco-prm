/**
 * The consent screen.
 *
 * Cloudflare's provider documentation requires the application to authenticate
 * the user, show consent, and decide scopes before completeAuthorization. The
 * previous version of this task leaned on GitHub's consent screen instead,
 * which is a different consent for a different thing: it authorizes sharing a
 * GitHub identity with Junco, not giving some downstream MCP client access to
 * the owner's contacts. GitHub also shows it once and auto-approves forever.
 *
 * It is deliberately plain. It has one job - let a person read a hostname
 * before approving it - and a redirect URI pointing somewhere unexpected is the
 * single most useful thing on the page.
 */
export function consentPage(options: {
  clientName: string;
  redirectUri: string;
  handle: string;
  githubLoginUrl: string;
}): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize access to your Junco PRM</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; }
    dl { background: #f4f4f5; padding: 1rem; border-radius: .5rem; }
    dt { font-weight: 600; font-size: .875rem; color: #52525b; }
    dd { margin: 0 0 .75rem; font-family: ui-monospace, monospace; word-break: break-all; }
    dd:last-child { margin-bottom: 0; }
    button { font: inherit; padding: .625rem 1.25rem; border-radius: .375rem; border: 0; cursor: pointer; }
    .go { background: #18181b; color: white; }
    .no { background: transparent; color: #52525b; text-decoration: underline; }
    .warn { color: #991b1b; }
  </style>
</head>
<body>
  <h1>Authorize access to your Junco PRM</h1>
  <p>An application is asking for access to your personal relationship manager -
     every person, note, encounter and contact detail it holds.</p>
  <dl>
    <dt>Application</dt><dd>${escapeHtml(options.clientName)}</dd>
    <dt>Will receive the authorization at</dt><dd>${escapeHtml(options.redirectUri)}</dd>
  </dl>
  <p class="warn"><strong>If you did not just start this yourself, or that address
     is not one you recognize, close this page.</strong> Approving it gives whoever
     controls that address the same access to your PRM that you have.</p>
  <form method="POST" action="/authorize/approve">
    <input type="hidden" name="handle" value="${escapeHtml(options.handle)}">
    <button class="go" type="submit">Approve and sign in with GitHub</button>
  </form>
  <p><a class="no" href="/authorize/deny">Cancel</a></p>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // This page names a redirect URI and carries a transaction handle.
      // Nothing should be able to frame it or load anything into it.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
    },
  });
}

/**
 * The client name and redirect URI are attacker-controlled: anyone can register
 * a client through DCR and choose both. They are rendered as text, never as
 * markup.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
