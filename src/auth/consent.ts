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
 * BE HONEST ABOUT WHAT THIS PAGE CAN AND CANNOT TELL A READER. An earlier
 * version of this comment implied the redirect URI is the decisive signal. It
 * is not. The allowlist in provider.ts means the only non-loopback address any
 * remote party can register is Anthropic's own callback, and the client name is
 * whatever the registering party typed, so on a hostile request both fields
 * read exactly as they do on a legitimate one.
 *
 * What actually carries weight, in order:
 *
 *   1. The warning below. "If you did not just start this yourself, close this
 *      page" is a human check, and on a remote attacker's flow it is the only
 *      one this screen offers.
 *   2. The registration age. A client registered seconds ago, when the owner
 *      has been using the same connector for months, is the one field that
 *      genuinely differs between the two cases - so it is shown, with the
 *      client id beside it.
 *   3. The redirect URI, which is decisive only in the loopback case: a local
 *      client asks for a port on this machine, and the owner is the one who
 *      knows whether they just started something local.
 */
export function consentPage(options: {
  clientName: string;
  clientId: string;
  /** Unix seconds, as the library records it. Null if the client is unknown. */
  registeredAt: number | null;
  redirectUri: string;
  handle: string;
  /** The cookie that binds this page's handle to the browser reading it. */
  setCookie: string;
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
    <dt>Client ID</dt><dd>${escapeHtml(options.clientId)}</dd>
    <dt>Registered</dt><dd>${escapeHtml(describeRegistration(options.registeredAt))}</dd>
    <dt>Will receive the authorization at</dt><dd>${escapeHtml(options.redirectUri)}</dd>
  </dl>
  <p class="warn"><strong>If you did not just start this yourself, close this page.</strong>
     Approving it gives whoever controls that address the same access to your PRM
     that you have. A client registered moments ago, when you did not just add
     one, is the clearest sign that someone else started this.</p>
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
      // The other half of the browser binding. The handle in this page's form
      // is useless without the secret in this cookie, so a party who fetched
      // this page from a server cannot get somebody else's browser to submit it.
      "set-cookie": options.setCookie,
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
 * How old the registration is, in the plainest terms available.
 *
 * The absolute timestamp is there so the line means something to a reader who
 * comes back to a screenshot later; the relative age is there because "34
 * seconds ago" is the part a person can act on while the page is in front of
 * them.
 */
function describeRegistration(registeredAt: number | null): string {
  if (registeredAt === null) return "unknown";

  const when = new Date(registeredAt * 1000);
  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - registeredAt);
  return `${when.toISOString().replace(/\.\d{3}Z$/, "Z")} (${describeAge(ageSeconds)})`;
}

function describeAge(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
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
