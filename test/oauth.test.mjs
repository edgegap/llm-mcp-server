// The hosted Worker's OAuth mode (src/oauth.ts), against the built dist/:
// token verification, the JWKS cache, the request gate and its response
// shapes, the tool-to-scope table, and the tools OAuth mode hides or refuses.
// worker-oauth.mjs checks the same behaviour over HTTP under wrangler dev.
// Run with: node --test test/oauth.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  JwksCache,
  JwksUnavailableError,
  JWKS_TTL_MS,
  JWKS_REFETCH_INTERVAL_MS,
  JWKS_RETRY_AFTER_FAILURE_MS,
  MEMBER_DEFAULT_SCOPES,
  OAuthTokenSource,
  gate,
  loadOAuthSettings,
  neededScopes,
  oauthHiddenTool,
  protectedResourceMetadata,
  securitySchemes,
  resourceMetadataPaths,
  toolNeed,
  verifyAccessToken,
} from '../dist/oauth.js';
import { ConfigError } from '../dist/config.js';
import { EdgegapClient } from '../dist/client.js';
import { registerTools, serverInstructions } from '../dist/tools.js';
import { accessToken, signingKey } from './oauth-keys.mjs';

const ISSUER = 'https://auth.example.test';
const RESOURCE = 'https://mcp.example.test/mcp';
const API_AUDIENCE = 'https://api.example.test';
const ENV = {
  OAUTH_MODE: '1',
  OAUTH_ISSUER: ISSUER,
  OAUTH_JWKS_URL: `${ISSUER}/oauth2/.well-known/jwks.json`,
  MCP_RESOURCE_URL: RESOURCE,
  ALLOWED_ORIGINS: 'https://allowed.example.test',
};
const settings = loadOAuthSettings(ENV, RESOURCE);

const KEY = await signingKey('key-1');
const OTHER_KEY = await signingKey('key-2');
const MEMBER_SCOPE = MEMBER_DEFAULT_SCOPES.join(' ');
const claims = (extra = {}) => ({ iss: ISSUER, aud: [RESOURCE, API_AUDIENCE], sub: 'user-footprint-1', org: 42, client_id: 'https://claude.ai/oauth/claude-code-client-metadata', scope: MEMBER_SCOPE, ...extra });

/** A JWKS endpoint stand-in: serves `keys`, counts fetches, can fail. */
function jwksServer(keys) {
  const state = { keys, fetches: 0, fail: false, init: [] };
  state.fetch = async (url, init) => {
    state.fetches++;
    state.init.push(init);
    if (state.fail) throw new Error('connection refused');
    return new Response(JSON.stringify({ keys: state.keys }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return state;
}

function clock(start = 1_800_000_000_000) {
  const c = { t: start };
  c.now = () => c.t;
  return c;
}

function freshJwks(keys = [KEY.jwk]) {
  const server = jwksServer(keys);
  const time = clock(Date.now());
  return { server, time, cache: new JwksCache(ENV.OAUTH_JWKS_URL, { fetch: server.fetch, now: time.now }) };
}

const call = (name, args = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

// ------------------------------------------------------------- settings ----

test('settings: every URL var is required in OAuth mode, and the metadata URL is path-inserted', () => {
  for (const key of ['OAUTH_ISSUER', 'OAUTH_JWKS_URL', 'MCP_RESOURCE_URL']) {
    assert.throws(() => loadOAuthSettings({ ...ENV, [key]: '' }, RESOURCE), ConfigError, key);
    assert.throws(() => loadOAuthSettings({ ...ENV, [key]: 'ftp://x' }, RESOURCE), ConfigError, key);
  }
  assert.equal(settings.resourceMetadataUrl, 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp');
  assert.deepEqual(resourceMetadataPaths(settings), ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']);
  const local = loadOAuthSettings({ ...ENV, MCP_RESOURCE_URL: 'http://localhost:8787/mcp', ALLOWED_ORIGINS: undefined }, 'http://localhost:8787/mcp');
  assert.equal(local.resourceMetadataUrl, 'http://localhost:8787/.well-known/oauth-protected-resource/mcp');
  assert.equal(local.allowedOrigins.size, 0);
});

test('protected-resource metadata: exact resource, the issuer first, the member-default read scopes only', () => {
  const doc = protectedResourceMetadata(settings);
  assert.equal(doc.resource, RESOURCE);
  assert.deepEqual(doc.authorization_servers, [ISSUER]);
  assert.deepEqual(doc.scopes_supported, ['apps:read', 'deployments:read', 'locations:read', 'registry:read']);
  assert.ok(!doc.scopes_supported.includes('offline_access'));
});

// ---------------------------------------------------------- verification ----

test('settings: a Worker on several hostnames takes the resource of the one the request came to', async () => {
  const OTHER = 'https://mcp.other.example.test/mcp';
  const both = { ...ENV, MCP_RESOURCE_URL: `${RESOURCE}, ${OTHER}` };

  const other = loadOAuthSettings(both, 'https://mcp.other.example.test/mcp/sse');
  assert.equal(other.resource, OTHER);
  assert.equal(other.resourceMetadataUrl, 'https://mcp.other.example.test/.well-known/oauth-protected-resource/mcp');
  assert.equal(protectedResourceMetadata(other).resource, OTHER);
  assert.equal(loadOAuthSettings(both, 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp').resource, RESOURCE);
  assert.equal(loadOAuthSettings(both, 'https://edgegap-mcp.example.workers.dev/mcp').resource, RESOURCE, 'any other origin gets the first');
  assert.throws(() => loadOAuthSettings({ ...ENV, MCP_RESOURCE_URL: `${RESOURCE},ftp://x` }, RESOURCE), ConfigError);
  assert.throws(() => loadOAuthSettings({ ...ENV, MCP_RESOURCE_URL: ' , ' }, RESOURCE), ConfigError);

  // A token is bound to the hostname it was issued for.
  const { cache } = freshJwks();
  assert.equal((await verifyAccessToken(await accessToken(KEY, claims({ aud: OTHER })), other, cache)).valid, true);
  assert.deepEqual(await verifyAccessToken(await accessToken(KEY, claims({ aud: RESOURCE })), other, cache), { valid: false, reason: 'audience' });
});

test('verifyAccessToken accepts an issuer token for this resource and reads org, sub and scopes', async () => {
  const { cache } = freshJwks();
  const result = await verifyAccessToken(await accessToken(KEY, claims()), settings, cache);
  assert.deepEqual(result, { valid: true, claims: { org: '42', sub: 'user-footprint-1', scopes: [...MEMBER_DEFAULT_SCOPES] } });
  const single = await verifyAccessToken(await accessToken(KEY, claims({ aud: RESOURCE })), settings, cache);
  assert.equal(single.valid, true, 'a single-string aud naming the resource');
});

test('verifyAccessToken is pinned: RS256, typ at+jwt, a published kid, iss, aud with this resource, exp', async () => {
  const { cache } = freshJwks();
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    ['HS256 header', await accessToken(KEY, claims(), { alg: 'HS256' }), 'algorithm'],
    ['alg none', await accessToken(KEY, claims(), { alg: 'none' }), 'algorithm'],
    ['no typ', await accessToken(KEY, claims(), { typ: undefined }), 'type'],
    ['typ JWT', await accessToken(KEY, claims(), { typ: 'JWT' }), 'type'],
    ['no kid', await accessToken(KEY, claims(), { kid: undefined }), 'kid'],
    ['kid not in the JWKS', await accessToken(OTHER_KEY, claims()), 'unknown kid'],
    ['signed by another key under a published kid', await accessToken(OTHER_KEY, claims(), { kid: 'key-1' }), 'signature'],
    ['another issuer', await accessToken(KEY, claims({ iss: 'https://evil.example.test' })), 'issuer'],
    ['aud is only the API', await accessToken(KEY, claims({ aud: [API_AUDIENCE] })), 'audience'],
    ['aud is another Worker', await accessToken(KEY, claims({ aud: ['https://mcp-beta.example.test/mcp', API_AUDIENCE] })), 'audience'],
    ['expires now', await accessToken(KEY, claims({ exp: now })), 'expired'],
    ['no exp', await accessToken(KEY, claims({ exp: undefined })), 'expired'],
    ['no org', await accessToken(KEY, claims({ org: undefined })), 'organization'],
    ['no sub', await accessToken(KEY, claims({ sub: undefined })), 'subject'],
    ['not a JWT', 'a.b', 'not a JWT'],
  ];
  for (const [label, token, reason] of cases) {
    const result = await verifyAccessToken(token, settings, cache);
    assert.deepEqual(result, { valid: false, reason }, label);
  }
});

test('verifyAccessToken refuses a token before its nbf, and an nbf that is not a number', async () => {
  const { cache, time } = freshJwks();
  const nowSeconds = Math.floor(time.t / 1000);
  const future = await accessToken(KEY, claims({ exp: nowSeconds + 600, nbf: nowSeconds + 60 }));
  assert.deepEqual(await verifyAccessToken(future, settings, cache, time.now), { valid: false, reason: 'not yet valid' });
  const text = await accessToken(KEY, claims({ exp: nowSeconds + 600, nbf: 'soon' }));
  assert.deepEqual(await verifyAccessToken(text, settings, cache, time.now), { valid: false, reason: 'not yet valid' });
  const past = await accessToken(KEY, claims({ exp: nowSeconds + 600, nbf: nowSeconds - 1 }));
  assert.equal((await verifyAccessToken(past, settings, cache, time.now)).valid, true);
});

test('verifyAccessToken never reads jku or x5u: a token pointing at its own key is still refused', async () => {
  const { cache, server } = freshJwks();
  const evil = await accessToken(OTHER_KEY, claims(), { kid: 'key-2', jku: 'https://evil.example.test/jwks.json', x5u: 'https://evil.example.test/cert.pem' });
  assert.deepEqual(await verifyAccessToken(evil, settings, cache), { valid: false, reason: 'unknown kid' });
  assert.equal(server.fetches, 1, 'only the configured JWKS URL was fetched');
});

test('a tampered payload fails the signature', async () => {
  const { cache } = freshJwks();
  const [h, , s] = (await accessToken(KEY, claims())).split('.');
  const payload = Buffer.from(JSON.stringify({ ...claims(), scope: 'apps:write', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
  assert.deepEqual(await verifyAccessToken(`${h}.${payload}.${s}`, settings, cache), { valid: false, reason: 'signature' });
});

// ------------------------------------------------------------------ JWKS ----

test('JWKS cache: fetched once while fresh, refetched after 10 minutes, a removed key stops verifying', async () => {
  const { cache, server, time } = freshJwks();
  const token = await accessToken(KEY, claims({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  for (let i = 0; i < 3; i++) assert.equal((await verifyAccessToken(token, settings, cache, time.now)).valid, true);
  assert.equal(server.fetches, 1);
  assert.equal(server.init[0].cache, 'no-store', 'fetched past any edge cache');

  server.keys = [];
  time.t += JWKS_TTL_MS - 1;
  assert.equal(server.fetches, 1);
  assert.equal((await verifyAccessToken(token, settings, cache, () => time.t)).valid, true, 'still inside the TTL');
  time.t += 1;
  assert.deepEqual(await verifyAccessToken(token, settings, cache, () => time.t), { valid: false, reason: 'unknown kid' });
  assert.equal(server.fetches, 2);
});

test('JWKS cache: an unknown kid refetches at most once a minute, and picks up a new key', async () => {
  const { cache, server, time } = freshJwks();
  const rotated = await accessToken(OTHER_KEY, claims());
  assert.equal((await verifyAccessToken(rotated, settings, cache, time.now)).valid, false);
  assert.equal(server.fetches, 1);
  server.keys = [KEY.jwk, OTHER_KEY.jwk];
  time.t += JWKS_REFETCH_INTERVAL_MS - 1;
  for (let i = 0; i < 5; i++) assert.equal((await verifyAccessToken(rotated, settings, cache, time.now)).valid, false);
  assert.equal(server.fetches, 1, 'no refetch within the minute');
  time.t += 1;
  assert.equal((await verifyAccessToken(rotated, settings, cache, time.now)).valid, true);
  assert.equal(server.fetches, 2);
});

test('JWKS cache: concurrent misses share one fetch; failures raise JwksUnavailableError and drop an expired set', async () => {
  const { cache, server, time } = freshJwks();
  await Promise.all(Array.from({ length: 10 }, () => cache.key('key-1')));
  assert.equal(server.fetches, 1);

  server.fail = true;
  time.t += JWKS_TTL_MS;
  await assert.rejects(cache.key('key-1'), JwksUnavailableError);
  server.fail = false;
  server.keys = [];
  time.t += JWKS_REFETCH_INTERVAL_MS;
  assert.equal(await cache.key('key-1'), undefined, 'the expired key did not survive the failed refresh');
});

test('JWKS cache: a fetch that hangs is abandoned after the timeout as unavailable', { timeout: 2000 }, async () => {
  // A request that never answers: it ends only when its signal aborts, so without
  // a timeout signal this test runs into its own 2 s limit. A real request keeps
  // the process alive while it waits; AbortSignal.timeout's own timer doesn't, so
  // this stand-in holds one until the abort.
  const hanging = (url, init) => new Promise((_, reject) => {
    const pending = setTimeout(() => {}, 10_000);
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(pending);
      reject(init.signal.reason);
    });
  });
  const cache = new JwksCache(ENV.OAUTH_JWKS_URL, { fetch: hanging, fetchTimeoutMs: 20 });
  await assert.rejects(cache.key('key-1'), JwksUnavailableError);
});

test('JWKS cache: after a failed fetch, requests wait before the next fetch and answer unavailable meanwhile', async () => {
  const server = jwksServer([KEY.jwk]);
  server.fail = true;
  const time = clock();
  const cache = new JwksCache(ENV.OAUTH_JWKS_URL, { fetch: server.fetch, now: time.now });
  await assert.rejects(cache.key('key-1'), JwksUnavailableError);
  for (let i = 0; i < 5; i++) await assert.rejects(cache.key('key-1'), JwksUnavailableError);
  assert.equal(server.fetches, 1, 'no refetch during the wait');
  server.fail = false;
  time.t += JWKS_RETRY_AFTER_FAILURE_MS;
  assert.ok(await cache.key('key-1'));
  assert.equal(server.fetches, 2);
});

test('JWKS cache: an unknown kid during the wait after a failed fetch is unavailable, never an unknown key', async () => {
  const { cache, server, time } = freshJwks();
  assert.ok(await cache.key('key-1'));
  server.fail = true;
  time.t += JWKS_REFETCH_INTERVAL_MS;
  await assert.rejects(cache.key('key-2'), JwksUnavailableError);
  time.t += 1000;
  await assert.rejects(cache.key('key-2'), JwksUnavailableError, 'a rotated key inside the wait is a 503, so clients keep their tokens');
  assert.ok(await cache.key('key-1'), 'a known key in a fresh set still verifies');
  assert.equal(server.fetches, 2);
});

test('JWKS cache: keys that are not RS256 signing keys are skipped', async () => {
  const { cache } = freshJwks([
    { ...KEY.jwk, kid: 'enc', use: 'enc' },
    { ...KEY.jwk, kid: 'ps256', alg: 'PS256' },
    { kty: 'EC', kid: 'ec', crv: 'P-256', x: 'x', y: 'y' },
    { ...KEY.jwk, kid: 'broken', n: undefined },
    KEY.jwk,
  ]);
  for (const kid of ['enc', 'ps256', 'ec', 'broken']) assert.equal(await cache.key(kid), undefined, kid);
  assert.ok(await cache.key('key-1'));
});

// ------------------------------------------------------------------ gate ----

const request = (body, authorization = null, origin = null) => ({ method: 'POST', authorization, origin, body });

test('gate: discovery and no-account tools pass signed out (lazy authentication)', async () => {
  const { cache } = freshJwks();
  for (const body of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    call('edgegap_generate_dockerfile', { engine: 'unity' }),
    call('edgegap_context'),
    call('edgegap_build_matchmaker_config', { application: 'a', version: 'v', verify_version: false }),
    call('edgegap_not_a_tool'),
    undefined,
  ]) {
    assert.deepEqual(await gate(request(body), settings, cache), { action: 'serve', token: undefined, claims: undefined }, JSON.stringify(body));
  }
});

test('gate: an account tool signed out is a 401 missing_token naming the metadata and member default plus the tool\'s scopes', async () => {
  const { cache } = freshJwks();
  const read = await gate(request(call('edgegap_list_apps')), settings, cache);
  assert.equal(read.status, 401);
  assert.deepEqual(read.body.error, 'missing_token');
  assert.equal(
    read.challenge,
    `Bearer scope="${MEMBER_SCOPE}", resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"`
  );
  const write = await gate(request(call('edgegap_create_app', { name: 'x' })), settings, cache);
  assert.match(write.challenge, /scope="apps:read apps:write deployments:read locations:read registry:read"/);
  const check = await gate(request(call('edgegap_context', { check_token: true })), settings, cache);
  assert.equal(check.status, 401, 'check_token calls the API');
  const verify = await gate(request(call('edgegap_build_matchmaker_config', { application: 'a', version: 'v' })), settings, cache);
  assert.equal(verify.status, 401, 'the version check calls the API');
});

test('gate: an invalid credential is a 401 invalid_token on any request, so the client refreshes', async () => {
  const { cache } = freshJwks();
  const expired = await accessToken(KEY, claims({ exp: Math.floor(Date.now() / 1000) - 1 }));
  for (const authorization of [`Bearer ${expired}`, 'Bearer 0f8b3c1e-e458-4592-b607-c2c28afd8b62', 'token 0f8b3c1e-e458-4592-b607-c2c28afd8b62', 'Basic dXNlcjpwYXNz']) {
    const decision = await gate(request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, authorization), settings, cache);
    assert.equal(decision.status, 401, authorization);
    assert.equal(decision.body.error, 'invalid_token');
    assert.equal(decision.challenge, 'Bearer error="invalid_token", resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"');
    assert.deepEqual(Object.keys(decision.body), ['error', 'message']);
  }
});

test('gate: an API token, as a token header or a bearer that is not a JWT, is told to remove the header or use the local server', async () => {
  const { cache } = freshJwks();
  for (const authorization of ['token 0f8b3c1e-e458-4592-b607-c2c28afd8b62', 'Bearer 0f8b3c1e-e458-4592-b607-c2c28afd8b62']) {
    const decision = await gate(request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, authorization), settings, cache);
    assert.equal(decision.body.error, 'invalid_token');
    assert.match(decision.body.message, /no longer accepts API tokens/, authorization);
    assert.match(decision.body.message, /Remove the Authorization header/);
    assert.match(decision.body.message, /npx -y @edgegap\/mcp/);
  }
  const expired = await accessToken(KEY, claims({ exp: Math.floor(Date.now() / 1000) - 1 }));
  const decision = await gate(request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, `Bearer ${expired}`), settings, cache);
  assert.equal(decision.body.message, 'The access token is invalid or expired.');
});

test('gate: a token with the scopes is served as its principal; without them, a 403 step-up listing granted plus needed', async () => {
  const { cache } = freshJwks();
  const member = await accessToken(KEY, claims());
  const served = await gate(request(call('edgegap_list_apps'), `Bearer ${member}`), settings, cache);
  assert.equal(served.action, 'serve');
  assert.equal(served.token, member, 'forwarded unchanged');
  assert.deepEqual(served.claims, { org: '42', sub: 'user-footprint-1', scopes: [...MEMBER_DEFAULT_SCOPES] });

  const stop = await gate(request(call('edgegap_stop_deployment', { request_id: 'r' }), `Bearer ${member}`), settings, cache);
  assert.equal(stop.status, 403);
  assert.equal(stop.body.error, 'insufficient_scope');
  assert.equal(stop.challenge, `Bearer error="insufficient_scope", scope="apps:read deployments:read deployments:write locations:read registry:read", resource_metadata="${settings.resourceMetadataUrl}"`);
  assert.doesNotMatch(JSON.stringify(stop), /deployment\.stop/, 'never names a permission');

  const writer = await accessToken(KEY, claims({ scope: 'deployments:read deployments:write' }));
  const deploy = await gate(request(call('edgegap_deploy', { application: 'a', version: 'v' }), `Bearer ${writer}`), settings, cache);
  assert.equal(deploy.status, 403, 'deploy needs apps:read too');
  assert.match(deploy.challenge, /scope="apps:read deployments:read deployments:write"/);

  const logs = await gate(request(call('edgegap_get_deployment_logs', { request_id: 'r' }), `Bearer ${member}`), settings, cache);
  assert.equal(logs.action, 'serve', 'container logs are in deployments:read');
});

test('gate: a batch needs the union of its calls', async () => {
  assert.deepEqual(neededScopes([call('edgegap_list_apps'), call('edgegap_list_endpoint_storage'), call('edgegap_get_skill')]), ['apps:read', 'storage:read']);
  assert.equal(neededScopes([call('edgegap_get_skill'), { jsonrpc: '2.0', method: 'tools/list' }]), undefined);
});

test('gate: Origin must be listed when present; absent passes', async () => {
  const { cache } = freshJwks();
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const refused = await gate(request(list, null, 'https://evil.example.test'), settings, cache);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'invalid_origin');
  assert.equal(refused.challenge, undefined);
  assert.equal((await gate(request(list, null, 'https://allowed.example.test'), settings, cache)).action, 'serve');
  assert.equal((await gate(request(list, null, null), settings, cache)).action, 'serve');
});

test('gate: an unreachable JWKS is a 503, never a 401', async () => {
  const { cache, server } = freshJwks();
  server.fail = true;
  const decision = await gate(request(call('edgegap_list_apps'), `Bearer ${await accessToken(KEY, claims())}`), settings, cache);
  assert.equal(decision.status, 503);
  assert.equal(decision.body.error, 'temporarily_unavailable');
  assert.equal(decision.challenge, undefined);
});

// ------------------------------------------------------- tools to scopes ----

const SNAPSHOT_TOOLS = JSON.parse(readFileSync(new URL('./tools.snapshot.json', import.meta.url))).normal.tools.map((t) => t.name);
// The tools whose API routes take no OAuth token yet: the relay routes
// authorize through the relay profile. Each leaves this list when its routes
// take one and it is added to TOOL_SCOPES; the change is deliberate, so this
// test names them.
const RELAY_TOOLS = [
  'edgegap_authorize_relay_user', 'edgegap_create_relay_session', 'edgegap_delete_relay_session',
  'edgegap_get_relay_session', 'edgegap_list_relay_sessions', 'edgegap_revoke_relay_user',
];
const HIDDEN = [...RELAY_TOOLS].sort((a, b) => SNAPSHOT_TOOLS.indexOf(a) - SNAPSHOT_TOOLS.indexOf(b));

test('tool table: every tool is mapped or hidden, the hidden set is exactly the unscoped ones, and no mapping is stale', () => {
  assert.deepEqual(SNAPSHOT_TOOLS.filter(oauthHiddenTool), HIDDEN);
  for (const tool of SNAPSHOT_TOOLS.filter((t) => !oauthHiddenTool(t))) assert.ok(toolNeed(tool), tool);
  for (const tool of ['edgegap_list_apps', 'edgegap_deploy', 'edgegap_get_skill']) assert.equal(oauthHiddenTool(tool), false);
});

test('tool table: per-tool scopes, write tools without their read, the no-account tools need nothing', () => {
  const expect = {
    edgegap_list_apps: ['apps:read'], edgegap_list_app_versions: ['apps:read'], edgegap_get_app_version: ['apps:read'],
    edgegap_create_app: ['apps:write'], edgegap_create_app_version: ['apps:write'],
    edgegap_deploy: ['deployments:write', 'apps:read'], edgegap_get_deployment: ['deployments:read'],
    edgegap_wait_for_deployment: ['deployments:read'], edgegap_list_deployments: ['deployments:read'],
    edgegap_stop_deployment: ['deployments:write'], edgegap_get_deployment_logs: ['deployments:read'],
    edgegap_list_registry_tags: ['registry:read'],
    edgegap_update_app: ['apps:write'], edgegap_update_app_version: ['apps:write'],
    edgegap_delete_app: ['apps:write', 'deployments:read'], edgegap_delete_app_version: ['apps:write', 'deployments:read'],
    edgegap_list_locations: ['locations:read'], edgegap_list_ping_beacons: ['locations:read'],
    edgegap_list_fleet_hosts: ['fleets:read'], edgegap_get_deployment_metrics: ['deployments:read'],
    edgegap_tag_deployment: ['deployments:write'], edgegap_report_deployment: ['deployments:write'],
    edgegap_delete_registry_tag: ['registry:write'], edgegap_list_endpoint_storage: ['storage:read'],
    edgegap_create_endpoint_storage: ['storage:write'], edgegap_delete_endpoint_storage: ['storage:write'],
    edgegap_create_pull_profile: ['storage:write'], edgegap_link_pull_profile: ['storage:write'],
    edgegap_delete_pull_profile: ['storage:write'],
    edgegap_search_deployment_logs: ['deployments:read'], edgegap_fleet_health: ['deployments:read'],
    edgegap_compare_versions: ['apps:read', 'deployments:read'],
  };
  for (const [tool, scopes] of Object.entries(expect)) assert.deepEqual(toolNeed(tool), { kind: 'scopes', scopes }, tool);
  for (const tool of ['edgegap_context', 'edgegap_list_skills', 'edgegap_get_skill', 'edgegap_update_skills', 'edgegap_generate_dockerfile', 'edgegap_validate_server_config', 'edgegap_get_registry_credentials']) {
    assert.deepEqual(toolNeed(tool), { kind: 'none' }, tool);
  }
  // A private fleet deployment needs the same scopes as a cloud one: the route takes deployment.create.
  assert.deepEqual(toolNeed('edgegap_deploy', { private_host_ids: ['h1'] }), { kind: 'scopes', scopes: ['deployments:write', 'apps:read'] });
});

// ---------------------------------------------- the MCP server in OAuth mode ----

const text = (result) => result.content.map((c) => c.text).join('\n');

/**
 * The MCP server as the Worker builds it in OAuth mode, against a local API
 * that records each call and answers `reply` (default: one application).
 */
async function oauthServer(token, reply = { status: 200, body: { applications: [{ name: 'game', is_active: true }], total_count: 1 } }, organization = token ? '42' : undefined) {
  const calls = [];
  const api = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${api.address().port}`;
  const config = {
    envToken: undefined, baseUrlV1: base, baseUrlV2: `${base}/v2`, readOnly: false, appAllowlist: [], maxDurationCeiling: 60,
    maxAgentDeployments: 5, stopOwnOnly: false, requestTimeoutMs: 5000, transport: 'hosted', credential: 'oauth',
  };
  const auth = new OAuthTokenSource(token);
  const server = new McpServer({ name: 'edgegap', version: 'test' }, { instructions: serverInstructions('oauth') });
  registerTools(server, new EdgegapClient(config, auth), config, auth, { hidden: oauthHiddenTool, securitySchemes, organization, skillsCheck: { enabled: false, rawBase: 'http://127.0.0.1:1' } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, calls, close: async () => { await client.close(); api.close(); } };
}

test('OAuth mode lists the scoped and no-account tools only, and its instructions describe sign-in', async () => {
  const s = await oauthServer(undefined);
  try {
    const { tools } = await s.client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, SNAPSHOT_TOOLS.filter((t) => !HIDDEN.includes(t)));
    const instructions = s.client.getInstructions();
    assert.match(instructions, /signs in with Edgegap/);
    assert.doesNotMatch(instructions, /org-wide|Authorization header/);
  } finally {
    await s.close();
  }
});

test('OAuth mode forwards the access token unchanged as Bearer', async () => {
  const token = await accessToken(KEY, claims());
  const s = await oauthServer(token);
  try {
    const listed = await s.client.callTool({ name: 'edgegap_list_apps', arguments: {} });
    assert.ok(!listed.isError, JSON.stringify(listed));
    assert.deepEqual(s.calls.map((c) => [c.method, c.url, c.auth]), [['GET', '/v1/apps?limit=50', `Bearer ${token}`]]);
    assert.ok(!JSON.stringify(listed).includes(token), 'the token never reaches a result');

    const context = await s.client.callTool({ name: 'edgegap_context', arguments: {} });
    assert.match(text(context), /signed in with Edgegap/);
  } finally {
    await s.close();
  }
});

test('OAuth mode: every relay tool is hidden, and neither the metadata nor the first sign-in asks for a relay scope', async () => {
  for (const tool of RELAY_TOOLS) assert.equal(oauthHiddenTool(tool), true, tool);
  assert.ok(!MEMBER_DEFAULT_SCOPES.some((s) => s.startsWith('relays:')));
  const decision = await gate({ method: 'POST', authorization: null, origin: null, body: call('edgegap_list_apps') }, settings, freshJwks().cache);
  assert.doesNotMatch(decision.challenge, /relays:/);
});

test('OAuth mode instructions and edgegap_context say relays are not available through sign-in', async () => {
  const instructions = serverInstructions('oauth');
  assert.doesNotMatch(instructions, /edgegap_create_relay_session|relay sessions/);
  assert.match(instructions, /Relays .*not available through Edgegap sign-in/);
  assert.match(serverInstructions('hosted'), /edgegap_create_relay_session/, 'token mode keeps relays');
  const s = await oauthServer(undefined);
  try {
    const context = await s.client.callTool({ name: 'edgegap_context', arguments: {} });
    assert.doesNotMatch(context.structuredContent.guardrails.dry_run, /relay/);
  } finally {
    await s.close();
  }
});

test('OAuth mode: edgegap_get_registry_credentials answers the dashboard push steps itself, signed out, with no API call', async () => {
  const s = await oauthServer(undefined);
  try {
    const result = await s.client.callTool({ name: 'edgegap_get_registry_credentials', arguments: { image_name: 'my-server', tag: 'build-7' } });
    assert.ok(!result.isError, text(result));
    assert.equal(result.structuredContent.status, 'manual_steps_required');
    assert.match(text(result), /Edgegap sign-in does not hand out container registry credentials/);
    assert.match(text(result), /Container Registry page/);
    assert.match(text(result), /docker push registry\.edgegap\.com\/<project>\/my-server:build-7/);
    assert.deepEqual(s.calls, []);
  } finally {
    await s.close();
  }
});

test('OAuth mode instructions: the golden path names a listed tool at every step, and the guardrail names the access token', async () => {
  const instructions = serverInstructions('oauth');
  assert.match(instructions, /Never put the access token in env vars/);
  assert.doesNotMatch(instructions, /API token in env vars/);
  const s = await oauthServer(undefined);
  try {
    const listed = new Set((await s.client.listTools()).tools.map((t) => t.name));
    const named = instructions.slice(instructions.indexOf('Golden path')).match(/edgegap_[a-z_]+/g);
    for (const tool of named) assert.ok(listed.has(tool), tool);
  } finally {
    await s.close();
  }
});

test('OAuth mode: the API refusing the sign-in says to reconnect the server, never to check an API token', async () => {
  const token = await accessToken(KEY, claims());
  const s = await oauthServer(token, { status: 401, body: { error: 'invalid_token', message: 'Invalid or expired credential.' } });
  try {
    const result = await s.client.callTool({ name: 'edgegap_list_apps', arguments: {} });
    assert.ok(result.isError);
    assert.match(text(result), /Reconnect the Edgegap server in the MCP client/);
    assert.doesNotMatch(text(result), /user-settings\?tab=tokens|discarded/);
  } finally {
    await s.close();
  }
});

test('OAuth mode: each API 403 and 503 code gets its own explanation', async () => {
  const token = await accessToken(KEY, claims());
  const cases = [
    [403, 'insufficient_scope', /role in the organization or the access approved for this connection/, /Authorized apps/],
    [403, 'scoped_token_not_accepted', /not available through Edgegap sign-in/, /npx -y @edgegap\/mcp/],
    [503, 'temporarily_unavailable', /could not check the sign-in/, /Retry in a few seconds/],
  ];
  for (const [status, error, ...expected] of cases) {
    const s = await oauthServer(token, { status, body: { error, message: 'Refused.' } });
    try {
      const result = await s.client.callTool({ name: 'edgegap_list_apps', arguments: {} });
      assert.ok(result.isError, error);
      for (const pattern of expected) assert.match(text(result), pattern, error);
      assert.doesNotMatch(text(result), /may not use this feature|A new token will not help/, error);
    } finally {
      await s.close();
    }
  }
});

test('OAuth mode: every listed tool declares its securitySchemes in _meta, asking for what its 401 asks', async () => {
  const s = await oauthServer(undefined);
  try {
    const { tools } = await s.client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t._meta?.securitySchemes]));
    for (const [name, schemes] of Object.entries(byName)) assert.ok(Array.isArray(schemes) && schemes.length > 0, name);
    assert.deepEqual(byName.edgegap_generate_dockerfile, [{ type: 'noauth' }]);
    assert.deepEqual(byName.edgegap_get_registry_credentials, [{ type: 'noauth' }]);
    assert.deepEqual(byName.edgegap_list_apps, [{ type: 'oauth2', scopes: ['apps:read', 'deployments:read', 'locations:read', 'registry:read'] }]);
    assert.deepEqual(byName.edgegap_create_app, [{ type: 'oauth2', scopes: ['apps:read', 'apps:write', 'deployments:read', 'locations:read', 'registry:read'] }]);
    // Works signed out; checking the token or the version needs the account.
    assert.deepEqual(byName.edgegap_context, [{ type: 'noauth' }, { type: 'oauth2', scopes: ['apps:read', 'deployments:read', 'locations:read', 'registry:read'] }]);
    assert.deepEqual(byName.edgegap_build_matchmaker_config, [{ type: 'noauth' }, { type: 'oauth2', scopes: ['apps:read', 'deployments:read', 'locations:read', 'registry:read'] }]);
    for (const name of Object.keys(byName)) {
      const oauth2 = byName[name].find((x) => x.type === 'oauth2');
      if (!oauth2) continue;
      const decision = await gate({ method: 'POST', authorization: null, origin: null, body: call(name, { check_token: true }) }, settings, freshJwks().cache);
      assert.equal(decision.challenge.match(/scope="([^"]+)"/)[1], oauth2.scopes.join(' '), name);
    }
  } finally {
    await s.close();
  }
});

test('token mode declares no securitySchemes', async () => {
  const server = new McpServer({ name: 'edgegap', version: 'test' });
  const config = { envToken: undefined, baseUrlV1: 'http://127.0.0.1:1', baseUrlV2: 'http://127.0.0.1:1/v2', readOnly: false, appAllowlist: [], maxDurationCeiling: 60, maxAgentDeployments: 5, stopOwnOnly: false, requestTimeoutMs: 5000, transport: 'hosted', credential: 'api_token' };
  const auth = new OAuthTokenSource(undefined);
  registerTools(server, new EdgegapClient(config, auth), config, auth, { skillsCheck: { enabled: false, rawBase: 'http://127.0.0.1:1' } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  assert.ok(tools.every((t) => t._meta?.securitySchemes === undefined));
  await client.close();
});

test('OAuth mode: edgegap_context names the connection\'s organization and how to work in another one', async () => {
  const token = await accessToken(KEY, claims());
  const s = await oauthServer(token);
  try {
    const context = await s.client.callTool({ name: 'edgegap_context', arguments: {} });
    assert.equal(context.structuredContent.organization.id, '42');
    assert.match(context.structuredContent.organization.note, /chosen when the developer signed in/);
    assert.match(context.structuredContent.organization.note, /reconnect the server in the MCP client and pick that organization/);
  } finally {
    await s.close();
  }
  const signedOut = await oauthServer(undefined);
  try {
    const context = await signedOut.client.callTool({ name: 'edgegap_context', arguments: {} });
    assert.match(context.structuredContent.organization, /chosen when the developer signs in/);
  } finally {
    await signedOut.close();
  }
});

test('OAuth mode: edgegap_list_registry_tags explains a refused scope by its code, not as a registry that is not set up', async () => {
  const token = await accessToken(KEY, claims());
  const cases = [
    ['insufficient_scope', /role in the organization or the access approved for this connection/],
    ['scoped_token_not_accepted', /not available through Edgegap sign-in/],
  ];
  for (const [error, expected] of cases) {
    const s = await oauthServer(token, { status: 403, body: { error, message: 'Refused.' } });
    try {
      const result = await s.client.callTool({ name: 'edgegap_list_registry_tags', arguments: { image_name: 'my-server' } });
      assert.ok(result.isError, error);
      assert.match(text(result), expected, error);
      assert.doesNotMatch(text(result), /not_configured|cannot read an Edgegap container registry/, error);
    } finally {
      await s.close();
    }
  }
});

test('OAuth mode signed out: edgegap_context lists the registry push steps among what works without an account', async () => {
  const s = await oauthServer(undefined);
  try {
    const context = await s.client.callTool({ name: 'edgegap_context', arguments: {} });
    const { works_without_token: top, token_status: status } = context.structuredContent;
    assert.ok(top.some((t) => t.startsWith('edgegap_get_registry_credentials')), JSON.stringify(top));
    assert.ok(status.works_without_token.some((t) => t.startsWith('edgegap_get_registry_credentials')));
  } finally {
    await s.close();
  }
});

test('OAuth instructions point host/client games at the local server for relays, not at the relays skill', () => {
  const instructions = serverInstructions('oauth');
  assert.doesNotMatch(instructions, /edgegap-relays/);
  assert.match(instructions, /host\/client games via relays: the local server \(npx -y @edgegap\/mcp\) with an API token/);
  assert.match(serverInstructions('hosted'), /host\/client games via relays: edgegap-relays/, 'token mode keeps the relays skill');
});

test('OAuth mode signed out: edgegap_context says how sign-in starts, without a token message', async () => {
  const s = await oauthServer(undefined);
  try {
    const context = await s.client.callTool({ name: 'edgegap_context', arguments: {} });
    assert.match(text(context), /signed_out/);
    assert.doesNotMatch(text(context), /user-settings\?tab=tokens/);
  } finally {
    await s.close();
  }
});
