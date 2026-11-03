// Against a local mock of the Edgegap API (EDGEGAP_BASE_URL):
//   - reads (GET) are retried once after 429 (honouring Retry-After) or 503, writes never;
//   - "Status.READY"-style statuses come back as "READY";
//   - restart_policy reaches the API on create and update, and shows in list_app_versions.
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

const calls = [];
const hits = {};
const version = { name: 'v1', is_active: true, docker_repository: 'registry.edgegap.com', docker_image: 'org/srv', docker_tag: 't1', req_cpu: 256, req_memory: 512, max_duration: 30, restart_policy: 'never', ports: [{ port: 7777, protocol: 'WS', name: 'gameport', tls_upgrade: true }] };
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
    const route = `${req.method} ${new URL(req.url, 'http://x').pathname}`;
    hits[route] = (hits[route] ?? 0) + 1;
    const send = (status, data, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    switch (route) {
      case 'GET /v1/app/flaky/versions':
        return hits[route] === 1 ? send(429, { message: 'You have reached our rate limit.' }, { 'Retry-After': '1' }) : send(200, { versions: [version], total_count: 1 });
      case 'GET /v1/app/down/versions':
        return send(503, { message: 'Service Unavailable' });
      case 'GET /v1/status/abc123':
        return hits[route] === 1 ? send(502, { message: 'Bad Gateway' }) : send(200, { request_id: 'abc123', current_status: 'Status.READY', running: true, fqdn: 'abc123.pr.edgegap.net', ports: {} });
      case 'POST /v1/app/my-game/version':
        return hits[route] === 1 ? send(429, { message: 'You have reached our rate limit.' }) : send(200, { success: true, version: { name: 'v2' } });
      case 'PATCH /v1/app/my-game/version/v1':
        return send(200, { success: true, version });
      default:
        return send(404, { message: `mock: no route ${route}` });
    }
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${mock.address().port}`;

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { PATH: process.env.PATH, EDGEGAP_API_TOKEN: 'fake-token', EDGEGAP_BASE_URL: base, EDGEGAP_TELEMETRY: '0' },
});
const c = new Client({ name: 'retries', version: '1.0.0' });
await c.connect(transport);
const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args });
  return { error: r.isError, text: r.content.map((x) => x.text).join(' ') };
};

console.log('reads are retried once');
let t0 = Date.now();
let r = await call('edgegap_list_app_versions', { application: 'flaky' });
check('429 then 200: the tool succeeds', !r.error, r.text.slice(0, 200));
check('two requests', hits['GET /v1/app/flaky/versions'] === 2, String(hits['GET /v1/app/flaky/versions']));
check('waited for Retry-After (about 1 s)', Date.now() - t0 >= 900, `${Date.now() - t0} ms`);
check('restart_policy shown in the version summary', /"restart_policy":\s*"never"/.test(r.text), r.text.slice(0, 300));

r = await call('edgegap_list_app_versions', { application: 'down' });
check('503 twice: the tool fails', r.error, r.text.slice(0, 200));
check('exactly one retry', hits['GET /v1/app/down/versions'] === 2, String(hits['GET /v1/app/down/versions']));

console.log('deployment status');
r = await call('edgegap_get_deployment', { request_id: 'abc123' });
check('502 then 200: the tool succeeds', !r.error, r.text.slice(0, 200));
check('status "READY", not "Status.READY"', /"status":\s*"READY"/.test(r.text) && !r.text.includes('Status.READY'), r.text.slice(0, 200));

console.log('writes are never retried');
const versionArgs = { application: 'my-game', name: 'v2', docker_repository: 'docker.io', docker_image: 'me/srv', docker_tag: 'b1', cpu_units: 256, memory_mb: 512, ports: [{ port: 7777, protocol: 'WS', tls_upgrade: true }] };
r = await call('edgegap_create_app_version', { ...versionArgs, restart_policy: 'never' });
check('POST 429: the tool fails', r.error, r.text.slice(0, 200));
check('one request only', hits['POST /v1/app/my-game/version'] === 1, String(hits['POST /v1/app/my-game/version']));

console.log('restart_policy');
r = await call('edgegap_create_app_version', { ...versionArgs, restart_policy: 'never' });
const created = calls.filter((x) => x.method === 'POST' && x.url === '/v1/app/my-game/version').at(-1);
check('create sends restart_policy', created?.body?.restart_policy === 'never', JSON.stringify(created?.body));
check('no restart note when set', !r.text.includes('restart_policy was not set'), r.text.slice(0, 300));
r = await call('edgegap_create_app_version', { ...versionArgs, name: 'v3' });
const created2 = calls.filter((x) => x.method === 'POST' && x.url === '/v1/app/my-game/version').at(-1);
check('create without it sends none', created2?.body && !('restart_policy' in created2.body), JSON.stringify(created2?.body));
check('and says to set it', r.text.includes('restart_policy was not set'), r.text.slice(0, 300));
r = await call('edgegap_update_app_version', { application: 'my-game', version: 'v1', restart_policy: 'on_failure' });
const patched = calls.find((x) => x.method === 'PATCH');
check('update sends restart_policy', patched?.body?.restart_policy === 'on_failure' && Object.keys(patched.body).length === 1, JSON.stringify(patched?.body));
r = await call('edgegap_update_app_version', { application: 'my-game', version: 'v1', restart_policy: 'sometimes' });
check('an unknown policy is refused', r.error, r.text.slice(0, 200));

await c.close();
mock.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall retry/status/restart checks passed');
process.exit(failures ? 1 : 0);
