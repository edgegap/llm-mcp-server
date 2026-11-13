/**
 * Cloudflare Worker — remote Streamable HTTP transport for the Edgegap MCP server.
 *
 * Read worker/DECISION.md before deploying. Summary of the trade: the
 * developer's Edgegap API token passes through Edgegap infrastructure on every
 * call. Nothing is stored — no KV, no D1, no Durable Object, no logs, no cache
 * — but "not stored" is a weaker claim than "never seen", and the local server
 * (npx @edgegap/mcp) makes the stronger one.
 *
 * Run this when you need what local cannot do: web and mobile MCP clients with
 * no local process, shared demo environments, or a URL you can put in a deck.
 *
 * AUTH SHAPE — read this before adding a gate back.
 *
 * There is deliberately no HTTP 401 gate on /mcp. A transport-level 401 is the
 * spec's way of saying "go authenticate over there", and it is only useful when
 * there is an OAuth authorization server to point at. There is not one yet (see
 * DECISION.md), so a blanket 401 produced three bad outcomes:
 *
 *   1. initialize and tools/list failed, so no client could even see what this
 *      server does without a credential. Tool listings are not secret — the
 *      whole repo is public — and discovery has no business requiring a token.
 *   2. Clients that cannot attach a static header (claude.ai custom connectors,
 *      for one) sent their OWN bearer token, which satisfied a bare
 *      "is the header present" check and got relayed to the Edgegap API, which
 *      rejected it with an opaque 401 the developer could not act on.
 *   3. Clients rendered "sign-in: not required" anyway, because the challenge
 *      carried no RFC 9728 resource_metadata pointing at an authorization
 *      server. The badge was right; the gate was the broken part.
 *
 * So: every request reaches the MCP handler. Discovery works anonymously. Tools
 * that need a credential fail per-call through TokenUnavailableError, which
 * surfaces as readable text in the agent's transcript instead of a dead socket.
 *
 * OAUTH MODE (OAUTH_MODE "1", the staging and beta environments). There IS an
 * authorization server now, so the 401 comes back, but only where it means
 * something: a tool call that needs the account, or a token that no longer
 * verifies. Discovery and the no-account tools still work signed out (lazy
 * authentication). Pasted API tokens are refused: the only credential is an
 * Edgegap access token, verified here (src/oauth.ts) and forwarded unchanged.
 */

import { createMcpHandler } from 'agents/mcp/server';
import { McpServer } from '@modelcontextprotocol/server';
import type { McpServer as McpServerV1 } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EdgegapClient } from '../src/client.js';
import { StaticTokenProvider, type TokenSource } from '../src/auth.js';
import { registerTools, serverInstructions, type RegisterOptions } from '../src/tools.js';
import { skillsCheckFromEnv } from '../src/skillsversion.js';
import { ConfigError, parseBaseUrl, type Config } from '../src/config.js';
import { extractToken, unavailableMessage } from '../src/hosted.js';
import {
  JwksCache,
  OAuthTokenSource,
  gate,
  loadOAuthSettings,
  oauthEnabled,
  oauthHiddenTool,
  oauthRefusal,
  protectedResourceMetadata,
  resourceMetadataPaths,
  type AccessTokenClaims,
  type OAuthEnv,
  type OAuthSettings,
} from '../src/oauth.js';
import { VERSION } from '../src/version.js';
import { createAnalytics, type TelemetryEnv } from './telemetry.js';

export interface Env extends TelemetryEnv, OAuthEnv {
  /** The Edgegap API base URL. Default https://api.edgegap.com. */
  EDGEGAP_API_URL?: string;
  EDGEGAP_APP_ALLOWLIST?: string;
  EDGEGAP_MAX_DURATION_MINUTES?: string;
  EDGEGAP_MAX_AGENT_DEPLOYMENTS?: string;
  EDGEGAP_STOP_OWN_ONLY?: string;
  EDGEGAP_READ_ONLY?: string;
  /** "off" stops the skill tools from reading the latest skills version on GitHub. */
  EDGEGAP_SKILLS_CHECK?: string;
}

/**
 * Config for a single request. envToken is always undefined: the hosted server
 * has no ambient credential of its own, by design. If you ever find yourself
 * adding one, stop and re-read DECISION.md.
 */
function configForRequest(env: Env, credential: Config['credential']): Config {
  const base = parseBaseUrl(env.EDGEGAP_API_URL);
  return {
    envToken: undefined,
    baseUrlV1: base,
    baseUrlV2: `${base}/v2`,
    readOnly: env.EDGEGAP_READ_ONLY === '1',
    appAllowlist: (env.EDGEGAP_APP_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    maxDurationCeiling: Number.parseInt(env.EDGEGAP_MAX_DURATION_MINUTES ?? '60', 10) || 60,
    maxAgentDeployments: Number.parseInt(env.EDGEGAP_MAX_AGENT_DEPLOYMENTS ?? '5', 10) || 5,
    stopOwnOnly: env.EDGEGAP_STOP_OWN_ONLY === '1',
    requestTimeoutMs: 25_000, // inside the Worker subrequest budget
    transport: 'hosted',
    credential,
  };
}

/**
 * The issuer's public keys, shared by the requests this isolate serves. The
 * only state kept across requests: never a token, a principal or a client.
 */
let jwks: { url: string; cache: JwksCache } | undefined;
function jwksCache(url: string): JwksCache {
  if (jwks?.url !== url) jwks = { url, cache: new JwksCache(url) };
  return jwks.cache;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/** What one request's MCP server is built from. */
interface Session {
  config: Config;
  auth: TokenSource;
  instructions: string;
  token: string | undefined;
  /** Token mode: why there is no usable token. */
  authProblem?: 'absent' | 'foreign';
  /** OAuth mode: the verified token's claims. */
  claims?: AccessTokenClaims;
  options: Pick<RegisterOptions, 'hidden' | 'refuse'>;
  /**
   * Browser origins the MCP handler accepts by hostname: its default (localhost
   * only) in token mode, every one in OAuth mode, where the gate has already
   * checked the exact origin against ALLOWED_ORIGINS.
   */
  allowedOriginHostnames?: '*';
}

/** Serves one MCP request with a server built for it alone, and dropped with it. */
async function serveMcp(request: Request, env: Env, ctx: ExecutionContext, session: Session): Promise<Response> {
  const { config, auth } = session;

  // PostHog MCP Analytics (@posthog/mcp), off unless POSTHOG_API_KEY is set.
  // See telemetry.ts for exactly what is sent; never the token or arguments.
  const analytics = createAnalytics(env, request, ctx, {
    serverVersion: VERSION,
    readOnly: config.readOnly,
    token: session.token,
    authProblem: session.authProblem,
    identity: session.claims ? { org: session.claims.org, user: session.claims.sub } : undefined,
  });
  if (analytics && request.method === 'POST') {
    analytics.observeRpc(await request.clone().json().catch(() => undefined));
  }

  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'edgegap', version: VERSION }, { instructions: session.instructions });

    // The tool definitions are shared verbatim with the local server.
    // The cast bridges SDK v1 (which src/tools.ts is typed against) and v2:
    // registerTool's raw-zod-shape overload still exists in v2, so the call
    // shape is identical at runtime. When src/ moves to v2, delete the cast.
    //
    // Registration does not need a token — that is the point. The tools are
    // described to any client that asks, and only fail when one is CALLED
    // without a credential.
    registerTools(
      server as unknown as McpServerV1,
      new EdgegapClient(config, auth, {
        // The stateless handler sees one request per server, so the client
        // name is only known on initialize; the User-Agent omits it otherwise.
        clientName: () => (server as unknown as McpServerV1).server.getClientVersion?.()?.name,
      }),
      config,
      auth,
      {
        skillsCheck: skillsCheckFromEnv({ EDGEGAP_SKILLS_CHECK: env.EDGEGAP_SKILLS_CHECK }),
        onToolCall: analytics ? (report) => analytics.recordToolCall(report) : undefined,
        ...session.options,
      }
    );

    // After registration, so the SDK sees every tool.
    analytics?.instrument(server);

    return server;
  }, session.allowedOriginHostnames ? { allowedOriginHostnames: session.allowedOriginHostnames } : undefined);

  const response = await handler(request, env, ctx);
  analytics?.flush();
  return response;
}

/** Token mode: the developer's Edgegap API token on each request, as before OAuth. */
async function tokenMode(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { token, problem } = extractToken(request.headers.get('Authorization'));
  return serveMcp(request, env, ctx, {
    config: configForRequest(env, 'api_token'),
    auth: new StaticTokenProvider(token, problem ? unavailableMessage(problem) : undefined, problem),
    instructions: serverInstructions('hosted'),
    token,
    authProblem: problem,
    options: {},
  });
}

/** OAuth mode: the request passes the gate in src/oauth.ts, then runs as the token's principal. */
async function oauthMode(request: Request, env: Env, ctx: ExecutionContext, settings: OAuthSettings): Promise<Response> {
  const body = request.method === 'POST' ? await request.clone().json().catch(() => undefined) : undefined;
  const decision = await gate(
    {
      method: request.method,
      authorization: request.headers.get('Authorization'),
      origin: request.headers.get('Origin'),
      body,
    },
    settings,
    jwksCache(settings.jwksUrl)
  );
  if (decision.action === 'respond') {
    return json(decision.status, decision.body, decision.challenge ? { 'WWW-Authenticate': decision.challenge } : {});
  }

  return serveMcp(request, env, ctx, {
    config: configForRequest(env, 'oauth'),
    auth: new OAuthTokenSource(decision.token),
    instructions: serverInstructions('oauth'),
    token: decision.token,
    claims: decision.claims,
    options: { hidden: oauthHiddenTool, refuse: oauthRefusal },
    allowedOriginHostnames: '*',
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Token-free, so uptime checks need no credential.
    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    let settings: OAuthSettings | undefined;
    try {
      if (oauthEnabled(env)) settings = loadOAuthSettings(env);
      parseBaseUrl(env.EDGEGAP_API_URL);
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      // The message names a var, never a value a client sent.
      console.error(`[edgegap-mcp] configuration: ${err.message}`);
      return json(500, { error: 'server_misconfigured', message: 'This server is misconfigured.' });
    }

    // RFC 9728: public, so any origin may read it.
    if (settings && request.method === 'GET' && resourceMetadataPaths(settings).includes(url.pathname)) {
      return json(200, protectedResourceMetadata(settings), { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' });
    }

    // startsWith, not strict equality: Streamable HTTP uses subpaths and an
    // equality check breaks the connection in a way that is hard to debug.
    if (!url.pathname.startsWith('/mcp')) {
      return new Response('Not found', { status: 404 });
    }

    return settings ? oauthMode(request, env, ctx, settings) : tokenMode(request, env, ctx);
  },
};
