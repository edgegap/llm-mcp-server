// Errors real agents hit on the hosted server (PostHog review, 2026-11-19),
// against a local mock of the Edgegap API. Each case pins what the agent
// gets back now: a result it can act on, or a failure that names the fix.
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

const TOKEN = '0f8b3c1e-e458-4592-b607-c2c28afd8b62';
const seen = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (status, data, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    if (req.headers.authorization !== `token ${TOKEN}`) return send(401, { message: 'Invalid token' });
    const url = new URL(req.url, 'http://x');
    seen.push(`${req.method} ${url.pathname}${url.search}`);
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /v1/apps':
        return send(200, { applications: [{ name: 'my-game', is_active: true }], total_count: 1 });
      case 'GET /v1/app/my-game/versions':
        return send(200, { versions: [{ name: 'v1', is_active: true }], total_count: 1 });
      case 'PATCH /v1/app/my-game/version/v1':
        return send(400, {
          message:
            'Image validation unsuccessful for registry.edgegap.com/p/my-game:v1 - Check your credentials. ' +
            'Unable to login with the given credentials of image: registry.edgegap.com/p/my-game:v1',
        });
      case 'GET /v1/status/pullfail0001':
        return send(200, {
          request_id: 'pullfail0001',
          current_status: 'Status.ERROR',
          error: true,
          error_detail: 'Unable to pull image from registry. Make sure the registry, repository and tag are valid',
        });
      case 'GET /v1/deployment/pullfail0001/container-logs':
        return send(404, { message: 'not found' });
      case 'GET /v1/metrics/deployment/ended000001':
        return send(422, { message: 'Deployment is terminated. Cannot fetch metrics.' });
      case 'GET /v1/metrics/deployment/fresh000001':
        return send(422, { message: 'start_time cannot be in the future.' });
      case 'GET /v1/deployment/slowlogs0001/container-logs':
        return setTimeout(() => send(200, { logs: 'late' }), 1500);
      case 'GET /v1/deployment/ratelim0001/container-logs':
        return send(429, { message: 'You have reached our rate limit. Please try again later.' }, { 'Retry-After': '0' });
      case 'GET /v1/locations':
      case 'GET /v1/locations/beacons':
        return send(200, { locations: [], beacons: [], total_count: 0 });
      default:
        return send(500, { message: `mock has no route for ${req.method} ${url.pathname}` });
    }
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${mock.address().port}`;

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { PATH: process.env.PATH, EDGEGAP_BASE_URL: base, EDGEGAP_SKILLS_CHECK: 'off', EDGEGAP_API_TOKEN: TOKEN, EDGEGAP_TIMEOUT_MS: '400' },
  stderr: 'ignore',
});
const c = new Client({ name: 'errorreview', version: '1.0.0' });
await c.connect(transport);
const call = (name, args = {}) => c.callTool({ name, arguments: args });
const text = (r) => r.content.map((x) => x.text).join('\n');
const json = (r) => r.structuredContent ?? JSON.parse(r.content.find((x) => x.text.startsWith('{'))?.text ?? '{}');
let res, r;

console.log('\nregistry login failures name the fix');
res = await call('edgegap_update_app_version', { application: 'my-game', version: 'v1', verify_image: true });
check('update_app_version 400 login: error with verify_image false and the dashboard', res.isError && /verify_image false/.test(text(res)) && /registry_username and registry_token/.test(text(res)) && /nothing was changed/.test(text(res)), text(res));
res = await call('edgegap_wait_for_deployment', { request_id: 'pullfail0001', timeout_seconds: 5 });
check('wait on an image pull failure: error naming the registry login, no log lookup', res.isError && /registry login/.test(text(res)) && !seen.some((s) => s.includes('pullfail0001/container-logs')), text(res));

console.log('\nmetrics on an ended or brand-new deployment are results');
res = await call('edgegap_get_deployment_metrics', { request_id: 'ended000001' });
r = json(res);
check('terminated: status expired, not an error', !res.isError && r.status === 'expired' && /only serves metrics while one runs/.test(r.next_step), text(res));
res = await call('edgegap_get_deployment_metrics', { request_id: 'fresh000001' });
r = json(res);
check('start_time 422 without a start_time: not_ready, try again', !res.isError && r.status === 'not_ready', text(res));
const before = seen.length;
res = await call('edgegap_get_deployment_metrics', { request_id: 'fresh000001', start_time: '2999-01-01T00:00:00Z' });
check('a future start_time: refused here, nothing sent', res.isError && /in the future/.test(text(res)) && seen.length === before, text(res));

console.log('\nslow and rate-limited log reads');
res = await call('edgegap_get_deployment_logs', { request_id: 'slowlogs0001' });
r = json(res);
check('logs timeout: not_ready with when to retry', !res.isError && r.status === 'not_ready' && /30 seconds/.test(r.next_step), text(res));
res = await call('edgegap_get_deployment_logs', { request_id: 'ratelim0001' });
check('429: says how many seconds to wait', res.isError && /Wait \d+ seconds/.test(text(res)), text(res));

console.log('\nmissing arguments get the list to pick from');
res = await call('edgegap_list_app_versions', {});
r = json(res);
check('list_app_versions without application: needs_input with the applications', !res.isError && r.status === 'needs_input' && r.applications?.includes('my-game'), text(res));
res = await call('edgegap_get_app_version', {});
r = json(res);
check('get_app_version without arguments: the applications', !res.isError && r.status === 'needs_input' && r.applications?.includes('my-game'), text(res));
res = await call('edgegap_get_app_version', { application: 'my-game' });
r = json(res);
check('get_app_version without version: the versions', !res.isError && r.status === 'needs_input' && r.versions?.includes('v1'), text(res));
res = await call('edgegap_get_skill', {});
r = json(res);
check('get_skill without skill: the skills', !res.isError && r.status === 'needs_input' && r.skills?.some((s) => s.name === 'edgegap'), text(res).slice(0, 200));

console.log('\nlimits are clamped, not refused');
res = await call('edgegap_list_locations', { limit: 500 });
check('list_locations limit 500: sent as 200', !res.isError && seen.some((s) => s === 'GET /v1/locations?limit=200'), `${text(res).slice(0, 200)} ${seen.filter((s) => s.includes('locations')).join(' ')}`);
res = await call('edgegap_list_ping_beacons', { limit: 500 });
check('list_ping_beacons limit 500: sent as 200', !res.isError && seen.some((s) => s === 'GET /v1/locations/beacons?limit=200'), seen.filter((s) => s.includes('beacons')).join(' '));

await c.close();
mock.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
