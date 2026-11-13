// The hosted Worker in OAuth mode, over HTTP: runs the real Worker under
// `wrangler dev` against a local stand-in for the issuer's JWKS, the Edgegap
// API and PostHog, and checks the response shapes (plan section 5.0), lazy
// authentication, the hidden tools, that no state crosses requests, and the
// analytics identity.
//
//   npm run test:worker      (needs wrangler; not part of `npm test`)
//
// Tokens are signed by a key this test generates (test/oauth-keys.mjs).
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { accessToken, signingKey } from './oauth-keys.mjs';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : `: ${detail}`}`);
  if (!cond) failures++;
}

const ISSUER = 'https://auth.example.test';
const API_AUDIENCE = 'https://api.example.test';
const SALT = 'test-salt';
const KEY = await signingKey('test-key');
const ORG_A = '987650';
const ORG_B = '987651';
const USER_A = 'footprint-alpha-7f3e';
const USER_B = 'footprint-bravo-1c9d';
const hmac = (value) => createHmac('sha256', SALT).update(value).digest('hex').slice(0, 32);

// --------------------------------------- JWKS, Edgegap API and PostHog ----
/** Every API call: the Authorization header it carried and the org that token names. */
const apiCalls = [];
const events = [];
const raws = [];
const orgOf = (authorization) => {
  try {
    return String(JSON.parse(Buffer.from(authorization.split(' ')[1].split('.')[1], 'base64url').toString()).org);
  } catch {
    return undefined;
  }
};
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.url === '/jwks.json') return send(200, { keys: [KEY.jwk] });
    if (req.url.startsWith('/batch') || req.url.startsWith('/i/') || req.url.startsWith('/capture')) {
      let buf = Buffer.concat(chunks);
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
      const text = buf.toString('utf8');
      raws.push(text);
      try {
        const body = JSON.parse(text);
        for (const e of body.batch ?? [body]) events.push(e);
      } catch {}
      return send(200, { status: 'Ok' });
    }
    const org = orgOf(req.headers.authorization ?? '');
    apiCalls.push({ url: req.url, auth: req.headers.authorization, org });
    // A random delay, so concurrent requests interleave inside the Worker.
    await new Promise((r) => setTimeout(r, Math.random() * 60));
    if (req.url.startsWith('/v1/apps')) return send(200, { applications: [{ name: `app-of-org-${org}`, is_active: true }], total_count: 1 });
    return send(404, { message: 'not found' });
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;

// ------------------------------------------------------------ Worker ----
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
async function startWorker(vars) {
  const port = 8700 + Math.floor(Math.random() * 90);
  const base = `http://127.0.0.1:${port}`;
  const resolved = typeof vars === 'function' ? vars(base) : vars;
  const proc = spawn(npx, ['wrangler', 'dev', '--config', 'worker/wrangler.jsonc', '--local', '--port', String(port), ...resolved.flatMap((v) => ['--var', v])], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  let id = 0;
  /** One JSON-RPC POST; returns the HTTP response and its parsed JSON body. */
  const post = async (method, params, headers = {}) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', 'User-Agent': 'oauth-test/1.0', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const text = await res.text();
    const m = text.match(/\{[\s\S]*\}/);
    let json;
    try {
      json = m ? JSON.parse(m[0]) : undefined;
    } catch {}
    return { status: res.status, headers: res.headers, json };
  };
  const stop = () => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else proc.kill('SIGINT');
  };
  return { base, post, stop };
}
const toolText = (r) => (r.json?.result?.content ?? []).map((c) => c.text).join('\n');

const oauthVars = (base) => [
  'OAUTH_MODE:1',
  `OAUTH_ISSUER:${ISSUER}`,
  `OAUTH_JWKS_URL:${UPSTREAM}/jwks.json`,
  `MCP_RESOURCE_URL:${base}/mcp`,
  'ALLOWED_ORIGINS:https://allowed.example.test',
  `EDGEGAP_API_URL:${UPSTREAM}`,
  'EDGEGAP_SKILLS_CHECK:off',
  'POSTHOG_API_KEY:phc_test_key',
  `POSTHOG_HOST:${UPSTREAM}`,
  `TELEMETRY_SALT:${SALT}`,
  `TELEMETRY_INTERNAL_IDS:org_${hmac(ORG_A)}`,
];

let w = await startWorker(oauthVars);
const RESOURCE = `${w.base}/mcp`;
const METADATA_URL = `${w.base}/.well-known/oauth-protected-resource/mcp`;
const claims = (org, sub, scope = 'apps:read deployments:read registry:read relays:read') => ({ iss: ISSUER, aud: [RESOURCE, API_AUDIENCE], org: Number(org), sub, scope, client_id: 'https://claude.ai/oauth/claude-code-client-metadata' });
const tokenA = await accessToken(KEY, claims(ORG_A, USER_A));
const tokenB = await accessToken(KEY, claims(ORG_B, USER_B));
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

try {
  console.log('\nprotected-resource metadata (RFC 9728)');
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const res = await fetch(`${w.base}${path}`);
    const doc = await res.json();
    check(`${path}: resource, issuer first, four read scopes`, res.status === 200 && doc.resource === RESOURCE && doc.authorization_servers?.[0] === ISSUER && JSON.stringify(doc.scopes_supported) === '["apps:read","deployments:read","registry:read","relays:read"]', JSON.stringify(doc));
  }

  console.log('\nlazy authentication');
  const init = await w.post('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.0' } });
  check('initialize: 200 signed out, OAuth instructions', init.status === 200 && /signs in with Edgegap/.test(init.json?.result?.instructions ?? ''), `${init.status}`);
  const list = await w.post('tools/list', {});
  const names = (list.json?.result?.tools ?? []).map((t) => t.name);
  check('tools/list: 200 signed out, 24 tools, unscoped ones hidden', list.status === 200 && names.length === 24 && names.includes('edgegap_deploy') && !names.includes('edgegap_update_app') && !names.includes('edgegap_list_locations'), `${list.status} ${names.length}`);
  const dockerfile = await w.post('tools/call', { name: 'edgegap_generate_dockerfile', arguments: { engine: 'godot', server_binary: 'server.x86_64' } });
  check('a no-account tool works signed out', dockerfile.status === 200 && dockerfile.json?.result && !dockerfile.json.result.isError, toolText(dockerfile).slice(0, 200));

  console.log('\n401 and 403 shapes (plan section 5.0)');
  const signedOut = await w.post('tools/call', { name: 'edgegap_list_apps', arguments: {} });
  check('account tool signed out: 401 missing_token', signedOut.status === 401 && signedOut.json?.error === 'missing_token' && typeof signedOut.json?.message === 'string');
  check('  WWW-Authenticate: member default scope and resource_metadata', signedOut.headers.get('www-authenticate') === `Bearer scope="apps:read deployments:read registry:read relays:read", resource_metadata="${METADATA_URL}"`, signedOut.headers.get('www-authenticate'));
  const writeSignedOut = await w.post('tools/call', { name: 'edgegap_create_app', arguments: { name: 'x' } });
  check('write tool signed out: the 401 asks for apps:write too', /scope="apps:read apps:write deployments:read registry:read relays:read"/.test(writeSignedOut.headers.get('www-authenticate') ?? ''));
  const pasted = await w.post('tools/list', {}, { Authorization: 'token 0f8b3c1e-e458-4592-b607-c2c28afd8b62' });
  check('a pasted API token: 401 invalid_token, never relayed', pasted.status === 401 && pasted.json?.error === 'invalid_token' && /^Bearer error="invalid_token"/.test(pasted.headers.get('www-authenticate') ?? ''));
  const expired = await w.post('tools/list', {}, bearer(await accessToken(KEY, { ...claims(ORG_A, USER_A), exp: Math.floor(Date.now() / 1000) - 5 })));
  check('an expired token: 401 invalid_token', expired.status === 401 && expired.json?.error === 'invalid_token');
  const stepUp = await w.post('tools/call', { name: 'edgegap_create_app', arguments: { name: 'x' } }, bearer(tokenA));
  check('a member token on a write tool: 403 insufficient_scope with granted + needed', stepUp.status === 403 && stepUp.json?.error === 'insufficient_scope' && stepUp.headers.get('www-authenticate') === `Bearer error="insufficient_scope", scope="apps:read apps:write deployments:read registry:read relays:read", resource_metadata="${METADATA_URL}"`, stepUp.headers.get('www-authenticate'));
  check('  bodies never name a permission', ![signedOut, stepUp, pasted].some((r) => /app\.create|app\.list/.test(JSON.stringify(r.json))));
  const origin = await w.post('tools/list', {}, { Origin: 'https://evil.example.test' });
  check('an unlisted Origin: 403 invalid_origin', origin.status === 403 && origin.json?.error === 'invalid_origin');
  const allowed = await w.post('tools/list', {}, { Origin: 'https://allowed.example.test' });
  check('a listed Origin passes', allowed.status === 200);
  const fleet = await w.post('tools/call', { name: 'edgegap_deploy', arguments: { application: 'a', version: 'v', users: { ip_addresses: ['203.0.113.7'] }, private_host_ids: ['h1'], dry_run: true } }, bearer(await accessToken(KEY, claims(ORG_A, USER_A, 'apps:read deployments:read deployments:write'))));
  check('deploy to private fleet hosts: a tool error, nothing sent', fleet.status === 200 && fleet.json?.result?.isError && /private fleet/.test(toolText(fleet)));

  console.log('\nno state across requests');
  apiCalls.length = 0;
  const jobs = Array.from({ length: 30 }, (_, i) => (i % 2 ? ['B', tokenB, ORG_B] : ['A', tokenA, ORG_A]));
  const results = await Promise.all(jobs.map(([, token]) => w.post('tools/call', { name: 'edgegap_list_apps', arguments: {} }, bearer(token))));
  const mismatched = results.filter((r, i) => r.status !== 200 || !toolText(r).includes(`app-of-org-${jobs[i][2]}`) || toolText(r).includes(`app-of-org-${jobs[i][2] === ORG_A ? ORG_B : ORG_A}`));
  check('30 concurrent calls from two orgs: each response is its own org\'s', mismatched.length === 0, `${mismatched.length} mismatched`);
  const forwarded = apiCalls.filter((c) => c.url.startsWith('/v1/apps'));
  check('each upstream call carried one of the two tokens unchanged, 15 each', forwarded.length === 30 && forwarded.every((c) => c.auth === `Bearer ${tokenA}` || c.auth === `Bearer ${tokenB}`) && forwarded.filter((c) => c.org === ORG_A).length === 15, `${forwarded.length}`);

  await new Promise((r) => setTimeout(r, 2500));
  console.log('\nanalytics identity');
  const calls = events.filter((e) => e.event === '$mcp_tool_call' && e.properties?.tool_name === 'edgegap_list_apps' && e.properties?.has_token === true);
  const ofOrg = (org, user) => calls.filter((e) => e.distinct_id === `org_${hmac(org)}` && e.properties?.user_id === `user_${hmac(user)}`);
  check('distinct_id is org_ + HMAC of the org claim, user_id user_ + HMAC of sub', calls.length >= 30 && ofOrg(ORG_A, USER_A).length + ofOrg(ORG_B, USER_B).length === calls.length, `${calls.length} calls`);
  check('org_id_hash equals the distinct_id; TELEMETRY_INTERNAL_IDS matches the org hash', ofOrg(ORG_A, USER_A).every((e) => e.properties.org_id_hash === e.distinct_id && e.properties.is_internal === true) && ofOrg(ORG_B, USER_B).every((e) => e.properties.is_internal === false));
  const everything = raws.join('\n');
  check('raw org ids, user ids and tokens are never sent', ![ORG_A, ORG_B, USER_A, USER_B, tokenA, tokenB].some((v) => everything.includes(v)));
} finally {
  w.stop();
}

console.log('\nmisconfiguration');
w = await startWorker(['OAUTH_MODE:1', `OAUTH_JWKS_URL:${UPSTREAM}/jwks.json`, 'MCP_RESOURCE_URL:http://localhost/mcp']);
try {
  const res = await w.post('tools/list', {});
  check('OAuth mode without OAUTH_ISSUER: 500, nothing served', res.status === 500 && res.json?.error === 'server_misconfigured');
  const health = await fetch(`${w.base}/health`);
  check('health still answers', health.status === 200);
} finally {
  w.stop();
  upstream.close();
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
