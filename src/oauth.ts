/**
 * OAuth resource-server mode for the hosted Worker (OAUTH_MODE "1").
 *
 * The Worker accepts access tokens issued by Edgegap's authorization server
 * (the dashboard backend): RFC 9068 JWTs, RS256, verified here against the
 * issuer's JWKS, then forwarded unchanged to the Edgegap API, which checks
 * them again and enforces the route's permission. The Worker's own check
 * exists so a client gets the right OAuth signal before anything runs: 401
 * with resource_metadata to sign in, 401 invalid_token to refresh, and 403
 * insufficient_scope to ask the developer for more (step-up).
 *
 * Everything here is pure: no module-level state except what a caller builds
 * (the JWKS cache), Web Crypto only, and an injectable clock and fetch, so
 * the same code runs in the Worker and in Node's test runner.
 *
 * Nothing per user lives beyond a request. A token, its claims and the API
 * client built from them are created for one request and dropped with it;
 * the JWKS cache holds public keys only.
 */

import { ConfigError } from './config.js';
import { TokenUnavailableError, type TokenSource } from './auth.js';

// ------------------------------------------------------------- settings ----

export interface OAuthSettings {
  /** The authorization server's issuer: the token's `iss` and the metadata's first authorization server. */
  issuer: string;
  /** Where the issuer publishes its signing keys. */
  jwksUrl: string;
  /** This Worker's own MCP URL: the RFC 9728 `resource`, and what a token's `aud` must contain. */
  resource: string;
  /** Where the protected-resource metadata is served, derived from `resource` (RFC 9728 section 3.1). */
  resourceMetadataUrl: string;
  /** Browser origins allowed to call /mcp. A request without an Origin header is not a browser's and passes. */
  allowedOrigins: Set<string>;
}

/** The OAuth wrangler vars. Every URL comes from here, so one build serves local, staging and beta. */
export interface OAuthEnv {
  OAUTH_MODE?: string;
  OAUTH_ISSUER?: string;
  OAUTH_JWKS_URL?: string;
  MCP_RESOURCE_URL?: string;
  ALLOWED_ORIGINS?: string;
}

export function oauthEnabled(env: OAuthEnv): boolean {
  return env.OAUTH_MODE === '1';
}

/**
 * Reads the OAuth vars. Throws ConfigError when one is missing or is not an
 * http(s) URL: a Worker in OAuth mode that can't verify tokens must refuse to
 * serve rather than fall back to anything.
 */
export function loadOAuthSettings(env: OAuthEnv): OAuthSettings {
  const issuer = requiredUrl(env, 'OAUTH_ISSUER');
  const jwksUrl = requiredUrl(env, 'OAUTH_JWKS_URL');
  const resource = requiredUrl(env, 'MCP_RESOURCE_URL');
  const url = new URL(resource);

  return {
    issuer,
    jwksUrl,
    resource,
    resourceMetadataUrl: `${url.origin}/.well-known/oauth-protected-resource${url.pathname === '/' ? '' : url.pathname}`,
    allowedOrigins: new Set(
      (env.ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  };
}

function requiredUrl(env: OAuthEnv, key: keyof OAuthEnv): string {
  const value = env[key]?.trim();
  if (!value) throw new ConfigError(`${key} is required while OAUTH_MODE is on.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${key} "${value}" is not a valid URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`${key} must be an http(s) URL, not ${url.protocol}`);
  }
  return value;
}

/** The paths the protected-resource metadata answers on: path-inserted first, then the bare one. */
export function resourceMetadataPaths(settings: OAuthSettings): string[] {
  const path = new URL(settings.resourceMetadataUrl).pathname;
  return [...new Set([path, '/.well-known/oauth-protected-resource'])];
}

// ------------------------------------------------------- tools to scopes ----

/**
 * The scopes a member is offered by default, and the only ones the metadata
 * advertises: a first sign-in asks for these, and anything more is asked for
 * when a tool needs it (step-up).
 */
export const MEMBER_DEFAULT_SCOPES = ['apps:read', 'deployments:read', 'registry:read', 'relays:read'] as const;

/** What a tool call needs: nothing (no account), these scopes, or something OAuth can't do. */
export type ToolNeed =
  | { kind: 'none' }
  | { kind: 'scopes'; scopes: string[] }
  | { kind: 'unavailable'; message: string };

type ToolRule = string[] | null | ((args: Record<string, unknown>) => ToolNeed);

const NONE: ToolNeed = { kind: 'none' };
const scopes = (...names: string[]): ToolNeed => ({ kind: 'scopes', scopes: names });

/**
 * Every tool whose calls an OAuth token can make, and the scopes it needs:
 * null for no account, a list, or a function of the call's arguments when
 * some arguments call the API and others don't. A `*:write` scope is always
 * granted with its `*:read`, so a tool lists only what it can't do without.
 *
 * A tool missing here calls at least one API route with no permission in the
 * catalogue, which the API refuses for every OAuth token. OAuth mode hides it
 * (oauthHiddenTool); adding it here, once its routes have permissions, is
 * what makes it appear.
 */
const TOOL_SCOPES: Record<string, ToolRule> = {
  edgegap_context: (args) => (args.check_token === true ? scopes('apps:read') : NONE),
  edgegap_list_skills: null,
  edgegap_get_skill: null,
  edgegap_update_skills: null,
  edgegap_generate_dockerfile: null,
  edgegap_validate_server_config: null,
  edgegap_build_matchmaker_config: (args) => (args.verify_version === false ? NONE : scopes('apps:read')),

  edgegap_list_apps: ['apps:read'],
  edgegap_list_app_versions: ['apps:read'],
  edgegap_get_app_version: ['apps:read'],
  edgegap_create_app: ['apps:write'],
  edgegap_create_app_version: ['apps:write'],

  edgegap_deploy: (args) =>
    Array.isArray(args.private_host_ids) && args.private_host_ids.length > 0
      ? {
          kind: 'unavailable',
          message:
            'Deploying to private fleet hosts is not available when signed in with Edgegap through OAuth yet. ' +
            'Deploy to the cloud without private_host_ids, or use the dashboard for private fleet deployments.',
        }
      : scopes('deployments:write', 'apps:read'),
  edgegap_get_deployment: ['deployments:read'],
  edgegap_wait_for_deployment: ['deployments:read'],
  edgegap_list_deployments: ['deployments:read'],
  edgegap_stop_deployment: ['deployments:write'],
  // Explaining a missing log reads the deployment's status.
  edgegap_get_deployment_logs: ['deployments:logs', 'deployments:read'],

  edgegap_get_registry_credentials: ['registry:credentials'],
  edgegap_list_registry_tags: ['registry:read'],

  edgegap_get_relay_session: ['relays:read'],
  edgegap_create_relay_session: ['relays:write'],
  edgegap_authorize_relay_user: ['relays:write'],
  edgegap_delete_relay_session: ['relays:write'],
};

/** What a call to `tool` with `args` needs. Undefined for a tool OAuth mode hides. */
export function toolNeed(tool: string, args: Record<string, unknown> = {}): ToolNeed | undefined {
  if (!Object.hasOwn(TOOL_SCOPES, tool)) return undefined;
  const rule = TOOL_SCOPES[tool];
  if (rule === null) return NONE;
  if (Array.isArray(rule)) return scopes(...rule);
  return rule(args);
}

/** True for a tool OAuth mode doesn't register: one of its routes has no scope yet. */
export function oauthHiddenTool(tool: string): boolean {
  return !Object.hasOwn(TOOL_SCOPES, tool);
}

/** The tool error for a call OAuth can't make (RegisterOptions.refuse). */
export function oauthRefusal(tool: string, args: Record<string, unknown>): string | undefined {
  const need = toolNeed(tool, args);
  return need?.kind === 'unavailable' ? need.message : undefined;
}

// ----------------------------------------------------------------- JWKS ----

/** The JWKS could not be fetched or read: the Worker answers 503, never 401, so clients keep their tokens. */
export class JwksUnavailableError extends Error {}

/** A fresh JWKS is trusted this long, so a key removed in an emergency stops verifying without a redeploy. */
export const JWKS_TTL_MS = 10 * 60 * 1000;
/** An unknown kid refetches the JWKS at most this often, so garbage kids can't hammer the issuer. */
export const JWKS_REFETCH_INTERVAL_MS = 60 * 1000;

export interface JwksCacheOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * The issuer's signing keys, by kid. The one piece of state the Worker keeps
 * across requests: public keys only. Refetched once the set is older than
 * JWKS_TTL_MS, and on an unknown kid when the last fetch is older than
 * JWKS_REFETCH_INTERVAL_MS. Fetched with cache "no-store": the issuer sends a
 * one-hour Cache-Control, and an edge cache in between would hold a removed key
 * past the TTL.
 */
export class JwksCache {
  private keys = new Map<string, CryptoKey>();
  private fetchedAt = -Infinity;
  private inFlight?: Promise<void>;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly url: string, options: JwksCacheOptions = {}) {
    this.fetchFn = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.now = options.now ?? Date.now;
  }

  /** The key for `kid`, or undefined when the issuer doesn't publish it. */
  async key(kid: string): Promise<CryptoKey | undefined> {
    const age = this.now() - this.fetchedAt;
    if (age >= JWKS_TTL_MS || (!this.keys.has(kid) && age >= JWKS_REFETCH_INTERVAL_MS)) {
      await this.refresh();
    }
    return this.keys.get(kid);
  }

  private refresh(): Promise<void> {
    // Concurrent requests share one fetch.
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async load(): Promise<void> {
    let body: unknown;
    try {
      const response = await this.fetchFn(this.url, { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.json();
    } catch (err) {
      // A failed fetch must not keep serving a set past its TTL; an expired set is dropped.
      if (this.now() - this.fetchedAt >= JWKS_TTL_MS) this.keys.clear();
      throw new JwksUnavailableError(`The issuer's JWKS could not be fetched: ${(err as Error).message}`);
    }
    const entries = (body as { keys?: unknown })?.keys;
    if (!Array.isArray(entries)) throw new JwksUnavailableError('The issuer\'s JWKS has no keys array.');

    const keys = new Map<string, CryptoKey>();
    for (const entry of entries as Array<Record<string, unknown>>) {
      if (entry?.kty !== 'RSA' || typeof entry.kid !== 'string') continue;
      if (entry.use !== undefined && entry.use !== 'sig') continue;
      if (entry.alg !== undefined && entry.alg !== SIGNING_ALGORITHM) continue;
      try {
        const key = await crypto.subtle.importKey(
          'jwk',
          { kty: 'RSA', n: entry.n as string, e: entry.e as string, alg: SIGNING_ALGORITHM, ext: true },
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify']
        );
        keys.set(entry.kid, key);
      } catch {
        // A malformed key is skipped; the others still verify.
      }
    }
    this.keys = keys;
    this.fetchedAt = this.now();
  }
}

// ---------------------------------------------------------- access token ----

const SIGNING_ALGORITHM = 'RS256';
const ACCESS_TOKEN_TYPE = 'at+jwt';

/** What the Worker reads from a verified access token. */
export interface AccessTokenClaims {
  /** The organization the connection is bound to, as the issuer wrote it. */
  org: string;
  /** The user. */
  sub: string;
  /** The scopes the token holds. */
  scopes: string[];
}

export type VerifyResult = { valid: true; claims: AccessTokenClaims } | { valid: false; reason: string };

/**
 * Verifies an access token the way the dashboard's verify does, plus the
 * Worker's own audience: RS256 only, header `typ` exactly `at+jwt`, a `kid`
 * the issuer's JWKS publishes (`jku` and `x5u` are never read), the signature,
 * `iss`, `aud` containing this Worker's resource, and `exp` in the future with
 * no leeway.
 *
 * @throws JwksUnavailableError when the keys can't be fetched.
 */
export async function verifyAccessToken(
  token: string,
  settings: Pick<OAuthSettings, 'issuer' | 'resource'>,
  jwks: JwksCache,
  now: () => number = Date.now
): Promise<VerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'not a JWT' };
  const [headerPart, payloadPart, signaturePart] = parts;

  const header = decodeJson(headerPart);
  if (!header) return { valid: false, reason: 'unreadable header' };
  if (header.alg !== SIGNING_ALGORITHM) return { valid: false, reason: 'algorithm' };
  if (header.typ !== ACCESS_TOKEN_TYPE) return { valid: false, reason: 'type' };
  if (typeof header.kid !== 'string' || !header.kid) return { valid: false, reason: 'kid' };

  const key = await jwks.key(header.kid);
  if (!key) return { valid: false, reason: 'unknown kid' };

  const signature = decodeBase64Url(signaturePart);
  if (!signature) return { valid: false, reason: 'signature encoding' };
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed);
  if (!ok) return { valid: false, reason: 'signature' };

  const claims = decodeJson(payloadPart);
  if (!claims) return { valid: false, reason: 'unreadable claims' };
  if (claims.iss !== settings.issuer) return { valid: false, reason: 'issuer' };
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(settings.resource)) return { valid: false, reason: 'audience' };
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now()) return { valid: false, reason: 'expired' };
  if ((typeof claims.org !== 'number' && typeof claims.org !== 'string') || claims.org === '') {
    return { valid: false, reason: 'organization' };
  }
  if (typeof claims.sub !== 'string' || !claims.sub) return { valid: false, reason: 'subject' };
  if (claims.scope !== undefined && typeof claims.scope !== 'string') return { valid: false, reason: 'scope' };

  return {
    valid: true,
    claims: {
      org: String(claims.org),
      sub: claims.sub,
      scopes: ((claims.scope as string | undefined) ?? '').split(' ').filter(Boolean),
    },
  };
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function decodeJson(value: string): Record<string, unknown> | undefined {
  const bytes = decodeBase64Url(value);
  if (!bytes) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ gate ----

/** What the HTTP handler does with a request: answer it here, or serve it as this principal. */
export type GateDecision =
  | { action: 'respond'; status: number; body: { error: string; message: string }; challenge?: string }
  | { action: 'serve'; token?: string; claims?: AccessTokenClaims };

export interface GateRequest {
  method: string;
  authorization: string | null;
  origin: string | null;
  /** The parsed JSON-RPC body, or undefined when there is none or it isn't JSON. */
  body: unknown;
}

/**
 * The OAuth checks on one /mcp request, in order: Origin; the credential, if
 * any (an invalid one is a 401 whatever the request, so the client refreshes);
 * then what the request's tool calls need. initialize, tools/list and calls to
 * no-account tools pass without a credential (lazy authentication). The 401 for
 * an account tool asks for the member default plus what the tool needs, so the
 * first sign-in covers it; the 403 lists what the token holds plus what's
 * missing, because a client may not carry earlier grants into a step-up.
 *
 * Bodies follow plan section 5.0: `{error, message}`, never naming a permission.
 */
export async function gate(
  request: GateRequest,
  settings: OAuthSettings,
  jwks: JwksCache,
  now: () => number = Date.now
): Promise<GateDecision> {
  if (request.origin !== null && !settings.allowedOrigins.has(request.origin)) {
    return respond(403, 'invalid_origin', 'Requests from this origin are not accepted.');
  }

  const needed = neededScopes(request.body);

  let token: string | undefined;
  let claims: AccessTokenClaims | undefined;
  if (request.authorization !== null && request.authorization.trim() !== '') {
    const match = request.authorization.match(/^Bearer\s+(\S+)\s*$/i);
    if (!match) return invalidToken(settings, 'This server accepts only Edgegap sign-in tokens. Reconnect to sign in again.');
    let result: VerifyResult;
    try {
      result = await verifyAccessToken(match[1], settings, jwks, now);
    } catch (err) {
      if (err instanceof JwksUnavailableError) {
        return respond(503, 'temporarily_unavailable', 'Sign-in can\'t be checked right now. Try again shortly.');
      }
      throw err;
    }
    if (!result.valid) return invalidToken(settings, 'The access token is invalid or expired.');
    token = match[1];
    claims = result.claims;
  }

  if (needed === undefined) return { action: 'serve', token, claims };

  if (!claims) {
    const scope = sortedUnion(MEMBER_DEFAULT_SCOPES, needed);
    return respond(401, 'missing_token', 'Sign in with Edgegap to use this tool.', challenge(settings, { scope }));
  }

  const granted = new Set(claims.scopes);
  if (needed.some((s) => !granted.has(s))) {
    const scope = sortedUnion(claims.scopes, needed);
    return respond(
      403,
      'insufficient_scope',
      'This connection does not allow this tool. Approve the additional access to continue.',
      challenge(settings, { error: 'insufficient_scope', scope })
    );
  }
  return { action: 'serve', token, claims };
}

/**
 * The scopes the body's tool calls need together, or undefined when they need
 * no account. Hidden or unknown tools and calls OAuth can't make need nothing
 * here: the MCP server answers them (unknown tool, or the refusal text).
 */
export function neededScopes(body: unknown): string[] | undefined {
  const messages = Array.isArray(body) ? body : [body];
  let needed: Set<string> | undefined;
  for (const message of messages) {
    const m = message as { method?: unknown; params?: { name?: unknown; arguments?: unknown } } | null;
    if (m?.method !== 'tools/call' || typeof m.params?.name !== 'string') continue;
    const args = m.params.arguments && typeof m.params.arguments === 'object' ? (m.params.arguments as Record<string, unknown>) : {};
    const need = toolNeed(m.params.name, args);
    if (need?.kind !== 'scopes') continue;
    needed ??= new Set();
    for (const s of need.scopes) needed.add(s);
  }
  return needed ? [...needed].sort() : undefined;
}

function sortedUnion(a: readonly string[], b: readonly string[]): string {
  return [...new Set([...a, ...b])].sort().join(' ');
}

function respond(status: number, error: string, message: string, challengeHeader?: string): GateDecision {
  return { action: 'respond', status, body: { error, message }, ...(challengeHeader ? { challenge: challengeHeader } : {}) };
}

function invalidToken(settings: OAuthSettings, message: string): GateDecision {
  return respond(401, 'invalid_token', message, challenge(settings, { error: 'invalid_token' }));
}

/** An RFC 6750 `WWW-Authenticate` value carrying RFC 9728's resource_metadata. */
function challenge(settings: OAuthSettings, params: { error?: string; scope?: string }): string {
  const fields = [
    ...(params.error ? [`error="${params.error}"`] : []),
    ...(params.scope ? [`scope="${params.scope}"`] : []),
    `resource_metadata="${settings.resourceMetadataUrl}"`,
  ];
  return `Bearer ${fields.join(', ')}`;
}

/** The RFC 9728 protected-resource metadata document. */
export function protectedResourceMetadata(settings: OAuthSettings): Record<string, unknown> {
  return {
    resource: settings.resource,
    authorization_servers: [settings.issuer],
    scopes_supported: [...MEMBER_DEFAULT_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Edgegap',
  };
}

// ------------------------------------------------------- token source ----

/** What an account tool sees when it is reached without a sign-in: only via a no-account tool's optional call. */
export const OAUTH_SIGN_IN_MESSAGE =
  'Not signed in to Edgegap on this connection. Calling a tool that needs the account starts the Edgegap ' +
  'sign-in in the MCP client.';

/**
 * The credential of one OAuth request: the verified access token, or none.
 * Built per request and dropped with it.
 */
export class OAuthTokenSource implements TokenSource {
  constructor(private readonly token: string | undefined) {}

  get current(): string | undefined {
    return this.token;
  }

  async get(): Promise<string> {
    if (!this.token) throw new TokenUnavailableError(OAUTH_SIGN_IN_MESSAGE, 'absent');
    return this.token;
  }

  invalidate(): void {
    // The client refreshes or signs in again; nothing is held here to forget.
  }

  consumeFirstUseNotice(): string | undefined {
    return undefined;
  }
}
