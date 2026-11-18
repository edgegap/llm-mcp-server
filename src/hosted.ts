/**
 * Per-request token handling shared by the two hosted transports: the
 * Cloudflare Worker (worker/worker.ts) and the Node HTTP server (src/http.ts).
 *
 * Neither has an ambient credential. Each request carries the developer's own
 * Edgegap token in its Authorization header, and it is used for that request
 * and discarded. See worker/DECISION.md.
 */

import { stripTokenPrefix } from './config.js';

const TOKEN_URL = 'https://app.edgegap.com/user-settings?tab=tokens';

/**
 * Edgegap API tokens are UUIDs: the dashboard issues one kind of token, and the
 * API docs show it as "token xxxxxxxx-e458-4592-b607-c2c28afd8b62". Anything
 * else in the header is not an Edgegap token.
 *
 * The point of this check is NOT security — an invalid token fails upstream
 * anyway. It is to tell a foreign credential apart from an Edgegap one BEFORE
 * relaying it, so the developer gets "your client sent its own token" instead
 * of Edgegap's generic 401, and telemetry records auth_problem "foreign". MCP
 * clients mint JWTs for themselves (dots, never in a UUID) but also plain
 * opaque strings, which an earlier, looser check let through to the API.
 *
 * If Edgegap ever issues another token format, add it here: until then the
 * hosted server refuses it as foreign. The stdio server (npx @edgegap/mcp)
 * does not run this check.
 */
const EDGEGAP_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeEdgegapToken(value: string): boolean {
  return EDGEGAP_TOKEN.test(value);
}

export type TokenResult =
  | { token: string; problem?: undefined }
  | { token: undefined; problem: 'absent' | 'foreign' };

export function extractToken(header: string | null | undefined): TokenResult {
  if (!header) return { token: undefined, problem: 'absent' };

  // Any run of "Bearer "/"token ", so "token token <uuid>" still works.
  const value = stripTokenPrefix(header);
  if (!value) return { token: undefined, problem: 'absent' };
  if (!looksLikeEdgegapToken(value)) return { token: undefined, problem: 'foreign' };

  return { token: value };
}

/**
 * The message an agent sees when it calls a tool without a usable credential.
 * It is the only place the developer is told what to do, so it says it in full
 * rather than pointing at docs.
 */
export function unavailableMessage(problem: 'absent' | 'foreign'): string {
  const common =
    `Get a token at ${TOKEN_URL} (no Edgegap account yet? Sign up free at https://app.edgegap.com). ` +
    'Until then, edgegap_context, edgegap_list_skills, edgegap_get_skill, edgegap_generate_dockerfile and ' +
    'edgegap_validate_server_config work without one, so you can prepare the server build first.\n\n' +
    'The token is used for the request and discarded — ' +
    'never stored. Edgegap tokens are organization-wide and cannot be scoped, ' +
    'so prefer the local server (npx -y @edgegap/mcp), which keeps the token ' +
    'on your own machine and never sends it through Edgegap infrastructure.';

  if (problem === 'foreign') {
    return (
      'The Authorization header on this connection does not contain an Edgegap ' +
      'API token (those look like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) — it ' +
      'looks like a credential your MCP client issued for itself. That ' +
      'happens with clients that connect by URL alone and have no field for a ' +
      'custom header. This server was not going to relay it to the ' +
      'Edgegap API, because the only thing that produces is a confusing 401.\n\n' +
      'If your client cannot attach your own Edgegap token to the connection, ' +
      'it cannot use this hosted server: run the local one instead ' +
      '(npx -y @edgegap/mcp).\n\n' +
      common
    );
  }

  return (
    'No Edgegap API token on this request. Send it as an Authorization header ' +
    'on the MCP connection.\n\n' +
    common
  );
}

/** Shown as the allowlist when the connection's and the server's lists share no application. */
export const NO_SHARED_APPS = '(none: the X-Edgegap-App-Allowlist header and the server allowlist share no application)';

/**
 * Narrows a hosted request's config from its headers, so a developer on the
 * hosted endpoint gets the same limits EDGEGAP_READ_ONLY and
 * EDGEGAP_APP_ALLOWLIST give the local server:
 *
 *   X-Edgegap-Read-Only: 1             no write tool is registered
 *   X-Edgegap-App-Allowlist: a,b       writes only in these applications
 *
 * Headers can only narrow: read-only cannot be switched off, and an allowlist
 * already set on the server is intersected, never widened. The token is still
 * organization-wide; this limits what this connection's tools will do with it.
 */
export function narrowConfig<T extends { readOnly: boolean; appAllowlist: string[] }>(
  config: T,
  header: (name: string) => string | null | undefined
): T {
  const ro = header('x-edgegap-read-only')?.trim().toLowerCase();
  const readOnly = config.readOnly || ro === '1' || ro === 'true';
  const raw = header('x-edgegap-app-allowlist');
  let appAllowlist = config.appAllowlist;
  if (raw !== null && raw !== undefined && raw.trim() !== '') {
    const asked = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9._-]{1,128}$/.test(s)))].slice(0, 50);
    const narrowed = config.appAllowlist.length ? asked.filter((a) => config.appAllowlist.includes(a)) : asked;
    // A header naming no valid or shared application must not fall back to "all".
    appAllowlist = narrowed.length ? narrowed : [NO_SHARED_APPS];
  }
  return { ...config, readOnly, appAllowlist };
}
