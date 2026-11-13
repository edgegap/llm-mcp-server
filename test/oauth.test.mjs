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
  MEMBER_DEFAULT_SCOPES,
  OAuthTokenSource,
  gate,
  loadOAuthSettings,
  neededScopes,
  oauthHiddenTool,
  oauthRefusal,
  protectedResourceMetadata,
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
const settings = loadOAuthSettings(ENV);

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
    assert.throws(() => loadOAuthSettings({ ...ENV, [key]: '' }), ConfigError, key);
    assert.throws(() => loadOAuthSettings({ ...ENV, [key]: 'ftp://x' }), ConfigError, key);
  }
  assert.equal(settings.resourceMetadataUrl, 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp');
  assert.deepEqual(resourceMetadataPaths(settings), ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']);
  const local = loadOAuthSettings({ ...ENV, MCP_RESOURCE_URL: 'http://localhost:8787/mcp', ALLOWED_ORIGINS: undefined });
  assert.equal(local.resourceMetadataUrl, 'http://localhost:8787/.well-known/oauth-protected-resource/mcp');
  assert.equal(local.allowedOrigins.size, 0);
});

test('protected-resource metadata: exact resource, the issuer first, the four member-default read scopes only', () => {
  const doc = protectedResourceMetadata(settings);
  assert.equal(doc.resource, RESOURCE);
  assert.deepEqual(doc.authorization_servers, [ISSUER]);
  assert.deepEqual(doc.scopes_supported, ['apps:read', 'deployments:read', 'registry:read', 'relays:read']);
  assert.ok(!doc.scopes_supported.includes('offline_access'));
});

// ---------------------------------------------------------- verification ----

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
  assert.match(write.challenge, /scope="apps:read apps:write deployments:read registry:read relays:read"/);
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
  assert.equal(stop.challenge, `Bearer error="insufficient_scope", scope="apps:read deployments:read deployments:write registry:read relays:read", resource_metadata="${settings.resourceMetadataUrl}"`);
  assert.doesNotMatch(JSON.stringify(stop), /deployment\.stop/, 'never names a permission');

  const writer = await accessToken(KEY, claims({ scope: 'deployments:read deployments:write' }));
  const deploy = await gate(request(call('edgegap_deploy', { application: 'a', version: 'v' }), `Bearer ${writer}`), settings, cache);
  assert.equal(deploy.status, 403, 'deploy needs apps:read too');
  assert.match(deploy.challenge, /scope="apps:read deployments:read deployments:write"/);

  const logs = await gate(request(call('edgegap_get_deployment_logs', { request_id: 'r' }), `Bearer ${member}`), settings, cache);
  assert.match(logs.challenge, /scope="apps:read deployments:logs deployments:read registry:read relays:read"/);
});

test('gate: a batch needs the union of its calls', async () => {
  assert.deepEqual(neededScopes([call('edgegap_list_apps'), call('edgegap_create_relay_session'), call('edgegap_get_skill')]), ['apps:read', 'relays:write']);
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
// The tools that call a route with no permission in the catalogue (plan
// section 5.0). Each leaves this list when its routes get one and it is added
// to TOOL_SCOPES; the change is deliberate, so this test names them.
const HIDDEN = [
  'edgegap_create_endpoint_storage', 'edgegap_create_pull_profile', 'edgegap_delete_app', 'edgegap_delete_app_version',
  'edgegap_delete_endpoint_storage', 'edgegap_delete_pull_profile', 'edgegap_delete_registry_tag', 'edgegap_get_deployment_metrics',
  'edgegap_link_pull_profile', 'edgegap_list_endpoint_storage', 'edgegap_list_fleet_hosts', 'edgegap_list_locations',
  'edgegap_list_ping_beacons', 'edgegap_list_relay_sessions', 'edgegap_report_deployment', 'edgegap_revoke_relay_user',
  'edgegap_tag_deployment', 'edgegap_update_app', 'edgegap_update_app_version',
];

test('tool table: every tool is mapped or hidden, the hidden set is exactly the unscoped ones, and no mapping is stale', () => {
  assert.deepEqual(SNAPSHOT_TOOLS.filter(oauthHiddenTool), HIDDEN);
  for (const tool of SNAPSHOT_TOOLS.filter((t) => !oauthHiddenTool(t))) assert.ok(toolNeed(tool), tool);
  for (const tool of ['edgegap_list_apps', 'edgegap_deploy', 'edgegap_get_skill']) assert.equal(oauthHiddenTool(tool), false);
});

test('tool table: section 5.0 scopes, write tools without their read, the no-account tools need nothing', () => {
  const expect = {
    edgegap_list_apps: ['apps:read'], edgegap_list_app_versions: ['apps:read'], edgegap_get_app_version: ['apps:read'],
    edgegap_create_app: ['apps:write'], edgegap_create_app_version: ['apps:write'],
    edgegap_deploy: ['deployments:write', 'apps:read'], edgegap_get_deployment: ['deployments:read'],
    edgegap_wait_for_deployment: ['deployments:read'], edgegap_list_deployments: ['deployments:read'],
    edgegap_stop_deployment: ['deployments:write'], edgegap_get_deployment_logs: ['deployments:logs', 'deployments:read'],
    edgegap_get_registry_credentials: ['registry:credentials'], edgegap_list_registry_tags: ['registry:read'],
    edgegap_get_relay_session: ['relays:read'], edgegap_create_relay_session: ['relays:write'],
    edgegap_authorize_relay_user: ['relays:write'], edgegap_delete_relay_session: ['relays:write'],
  };
  for (const [tool, scopes] of Object.entries(expect)) assert.deepEqual(toolNeed(tool), { kind: 'scopes', scopes }, tool);
  for (const tool of ['edgegap_context', 'edgegap_list_skills', 'edgegap_get_skill', 'edgegap_update_skills', 'edgegap_generate_dockerfile', 'edgegap_validate_server_config']) {
    assert.deepEqual(toolNeed(tool), { kind: 'none' }, tool);
  }
  assert.equal(toolNeed('edgegap_deploy', { private_host_ids: ['h1'] }).kind, 'unavailable');
  assert.match(oauthRefusal('edgegap_deploy', { private_host_ids: ['h1'] }), /private fleet/);
  assert.equal(oauthRefusal('edgegap_deploy', { private_host_ids: [] }), undefined);
});

// ---------------------------------------------- the MCP server in OAuth mode ----

const text = (result) => result.content.map((c) => c.text).join('\n');

/** The MCP server as the Worker builds it in OAuth mode, against a local API that records each call. */
async function oauthServer(token) {
  const calls = [];
  const api = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ applications: [{ name: 'game', is_active: true }], total_count: 1 }));
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${api.address().port}`;
  const config = {
    envToken: undefined, baseUrlV1: base, baseUrlV2: `${base}/v2`, readOnly: false, appAllowlist: [], maxDurationCeiling: 60,
    maxAgentDeployments: 5, stopOwnOnly: false, requestTimeoutMs: 5000, transport: 'hosted', credential: 'oauth',
  };
  const auth = new OAuthTokenSource(token);
  const server = new McpServer({ name: 'edgegap', version: 'test' }, { instructions: serverInstructions('oauth') });
  registerTools(server, new EdgegapClient(config, auth), config, auth, { hidden: oauthHiddenTool, refuse: oauthRefusal, skillsCheck: { enabled: false, rawBase: 'http://127.0.0.1:1' } });
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

test('OAuth mode forwards the access token unchanged as Bearer, and refuses a private-fleet deploy before any call', async () => {
  const token = await accessToken(KEY, claims());
  const s = await oauthServer(token);
  try {
    const listed = await s.client.callTool({ name: 'edgegap_list_apps', arguments: {} });
    assert.ok(!listed.isError, JSON.stringify(listed));
    assert.deepEqual(s.calls.map((c) => [c.method, c.url, c.auth]), [['GET', '/v1/apps?limit=50', `Bearer ${token}`]]);
    assert.ok(!JSON.stringify(listed).includes(token), 'the token never reaches a result');

    const refused = await s.client.callTool({ name: 'edgegap_deploy', arguments: { application: 'game', version: 'v1', users: { ip_addresses: ['203.0.113.7'] }, private_host_ids: ['host-1'] } });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /private fleet/);
    assert.equal(s.calls.length, 1, 'nothing was sent');

    const context = await s.client.callTool({ name: 'edgegap_context', arguments: {} });
    assert.match(text(context), /signed in with Edgegap/);
  } finally {
    await s.close();
  }
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
