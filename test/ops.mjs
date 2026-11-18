// Operations tools (0.19.0): fleet health, log search, version comparison,
// metric anomalies, the confirm step on destructive tools, the allowlist on
// request_id writes, and the hosted per-connection headers. Runs against a
// local mock of the Edgegap API (EDGEGAP_BASE_URL); no real network calls.
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { narrowConfig, NO_SHARED_APPS } from '../dist/hosted.js';
import { analyzeSeries, percentile, logSignature, groupLogMatches, lineMatcher } from '../dist/ops.js';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

// ------------------------------------------------------------ pure parts ----
console.log('helpers');
check('percentile: nearest rank', percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95) === 10 && percentile([5], 95) === 5 && percentile([], 95) === undefined);
const flat = analyzeSeries({ datasets: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10] });
check('flat series: p95, no anomalies', flat.p95 === 10 && flat.anomalies === undefined, JSON.stringify(flat));
const spiky = analyzeSeries({ datasets: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 95], timestamps: Array.from({ length: 16 }, (_, i) => `t${i}`) });
check('spike above mean + 3 sd is flagged with its time', spiky.anomalies?.some((a) => /1 spike/.test(a) && /t15/.test(a)), JSON.stringify(spiky));
const leak = analyzeSeries({ datasets: [100, 105, 110, 120, 130, 145, 160, 180, 200, 220, 240, 260] });
check('rising series is flagged (leak)', leak.anomalies?.some((a) => /rising/.test(a)), JSON.stringify(leak));
const throttle = analyzeSeries({ datasets: [0, 0, 0.2, 0, 0, 0, 0, 0.5] }, { nonzero: true });
check('throttling: share above zero', throttle.nonzero_share === 0.25 && throttle.anomalies?.some((a) => /25 %/.test(a)), JSON.stringify(throttle));
check('log signature drops times, ids and numbers',
  logSignature('2026-11-12T10:00:01Z NullReferenceException at Player 42 (id 7e709a0d8efd)') ===
  logSignature('2026-11-12T11:30:59Z NullReferenceException at Player 7 (id 0a1b2c3d4e5f)'));
const groups = groupLogMatches([
  { request_id: 'a', line: 'Error: timeout after 30s' }, { request_id: 'b', line: 'Error: timeout after 31s' },
  { request_id: 'a', line: 'Fatal: out of memory' },
], 10);
check('groups by signature, most frequent first, with deployments', groups[0].count === 2 && groups[0].deployments.join() === 'a,b' && groups.length === 2);
check('regex with nested quantifiers refused', 'error' in lineMatcher('(a+)+$', true));
check('plain pattern is a case-insensitive substring', lineMatcher('NullRef', false).test('x nullreference y'));

console.log('\nhosted per-connection headers');
const base = { readOnly: false, appAllowlist: [] };
const h = (o) => (n) => o[n];
check('X-Edgegap-Read-Only: 1 turns read-only on', narrowConfig(base, h({ 'x-edgegap-read-only': '1' })).readOnly === true);
check('a header cannot turn read-only off', narrowConfig({ ...base, readOnly: true }, h({ 'x-edgegap-read-only': '0' })).readOnly === true);
check('X-Edgegap-App-Allowlist sets the list', narrowConfig(base, h({ 'x-edgegap-app-allowlist': 'a, b' })).appAllowlist.join() === 'a,b');
check('the header intersects a server list, never widens it', narrowConfig({ ...base, appAllowlist: ['a', 'c'] }, h({ 'x-edgegap-app-allowlist': 'a,b' })).appAllowlist.join() === 'a');
check('no overlap: nothing allowed, not everything', narrowConfig({ ...base, appAllowlist: ['c'] }, h({ 'x-edgegap-app-allowlist': 'a' })).appAllowlist.join() === NO_SHARED_APPS);
check('invalid names only: nothing allowed', narrowConfig(base, h({ 'x-edgegap-app-allowlist': '*, ' })).appAllowlist.join() === NO_SHARED_APPS);
check('no headers: unchanged', narrowConfig({ ...base, appAllowlist: ['a'] }, h({})).appAllowlist.join() === 'a');

// ------------------------------------------------------------- mock API ----
const calls = [];
const STATUS = {
  okdep0000001: { app_name: 'ops-game', app_version: 'v1', current_status: 'Status.READY', running: true, error: false, location: { city: 'Frankfurt', country: 'Germany' }, elapsed_time: 900 },
  okdep0000002: { app_name: 'ops-game', app_version: 'v1', current_status: 'Status.READY', running: true, error: false, location: { city: 'Dallas', country: 'United States' }, elapsed_time: 900 },
  baddep000001: { app_name: 'ops-game', app_version: 'v2', current_status: 'Status.ERROR', running: true, error: true, error_detail: 'Container exited with code 139', location: { city: 'Frankfurt', country: 'Germany' }, elapsed_time: 120 },
  slowdep00001: { app_name: 'ops-game', app_version: 'v2', current_status: 'Status.DEPLOYING', running: true, error: false, location: { city: 'Dallas', country: 'United States' }, elapsed_time: 1200 },
  prodserver01: { app_name: 'prod-game', app_version: 'live', current_status: 'Status.READY', running: true, error: false, location: { city: 'Paris', country: 'France' }, elapsed_time: 50000, tags: ['prod'] },
  agentdep0001: { app_name: 'ops-game', app_version: 'v1', current_status: 'Status.READY', running: true, error: false, elapsed_time: 60 },
};
const LOGS = {
  okdep0000001: { logs: 'server up\nplayer joined\n', crash_data: null },
  okdep0000002: { logs: 'server up\n2026-11-12T10:00:00Z Error: timeout after 30s\n', crash_data: null },
  baddep000001: { logs: 'server up\n2026-11-12T10:00:01Z NullReferenceException at Player 42\n2026-11-12T10:00:02Z NullReferenceException at Player 7\n', crash_logs: 'Segmentation fault', crash_data: { exit_code: 139, message: 'crashed', restart_count: 2 } },
  slowdep00001: { logs: '', crash_data: null },
};
const series = (vals) => ({ labels: ['%'], datasets: vals, timestamps: vals.map((_, i) => `2026-11-12T10:0${i}:00Z`) });
const METRICS = {
  okdep0000001: { cpu: series([20, 22, 21, 20, 22, 21, 20, 22]), mem: series([200, 201, 200, 202, 201, 200, 201, 202]), cpu_throttle_rate: series([0, 0, 0, 0, 0, 0, 0, 0]) },
  okdep0000002: { cpu: series([25, 24, 25, 26, 25, 24, 25, 26]), mem: series([210, 211, 210, 212, 211, 210, 211, 212]), cpu_throttle_rate: series([0, 0, 0, 0, 0, 0, 0, 0]) },
  baddep000001: { cpu: series([60, 62, 65, 70, 75, 80, 85, 90]), mem: series([300, 340, 380, 420, 460, 500, 540, 580]), cpu_throttle_rate: series([0, 0, 0.1, 0.2, 0.3, 0.3, 0.4, 0.5]) },
  slowdep00001: { cpu: series([50]), mem: series([400]) },
};
const BY_VERSION = { v1: ['okdep0000001', 'okdep0000002'], v2: ['baddep000001', 'slowdep00001'] };
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url });
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    let m;
    if (req.method === 'GET' && p === '/v1/deployments') {
      const filters = JSON.parse(url.searchParams.get('query') ?? '{}').filters ?? [];
      const f = (field) => filters.find((x) => x.field === field)?.value;
      let ids = f('application') === 'ops-game' ? [...BY_VERSION.v1, ...BY_VERSION.v2] : f('application') ? [] : Object.keys(STATUS);
      if (f('version')) ids = BY_VERSION[f('version')] ?? [];
      const limit = Number(url.searchParams.get('limit') ?? 50);
      return send(200, { data: ids.slice(0, limit).map((request_id) => ({ request_id, ready: true })), total_count: ids.length });
    }
    if ((m = p.match(/^\/v1\/status\/(\w+)$/))) return STATUS[m[1]] ? send(200, { request_id: m[1], ...STATUS[m[1]] }) : send(400, { message: 'Bad Request ID provided' });
    if ((m = p.match(/^\/v1\/deployment\/(\w+)\/container-logs$/))) return LOGS[m[1]] ? send(200, LOGS[m[1]]) : send(400, { message: 'no logs' });
    if ((m = p.match(/^\/v1\/metrics\/deployment\/(\w+)$/))) return METRICS[m[1]] ? send(200, METRICS[m[1]]) : send(404, { message: 'no metrics' });
    if ((m = p.match(/^\/v1\/deployments\/(\w+)\/tags$/)) && req.method === 'GET') return send(200, { tags: m[1] === 'agentdep0001' ? [{ name: 'edgegap-mcp' }] : [{ name: 'prod' }] });
    if (req.method === 'POST' && /\/tags$/.test(p)) return send(200, {});
    if (req.method === 'POST' && /:report$/.test(p)) return send(200, {});
    if ((m = p.match(/^\/v1\/stop\/(\w+)$/))) return send(200, { message: 'stop requested' });
    if (p === '/v1/app/ops-game/version/v1') return send(200, { name: 'v1', req_cpu: 256, req_memory: 512, docker_repository: 'registry.edgegap.com', docker_image: 'p/srv', docker_tag: 'v1' });
    if (p === '/v1/app/ops-game/version/v2') return send(200, { name: 'v2', req_cpu: 256, req_memory: 512, docker_repository: 'registry.edgegap.com', docker_image: 'p/srv', docker_tag: 'v2' });
    if (p === '/v1/app/idle-game/version/old-1' && req.method === 'GET') return send(200, { name: 'old-1', docker_tag: 'old-1' });
    if (p === '/v1/app/idle-game/versions') return send(200, { versions: [], total_count: 0 });
    if (req.method === 'DELETE') return send(200, {});
    send(404, { message: `mock: no route ${req.method} ${p}` });
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${mock.address().port}`;

async function connect(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: 'node', args: ['dist/index.js'],
    env: { PATH: process.env.PATH, EDGEGAP_API_TOKEN: '0f8b3c1e-e458-4592-b607-c2c28afd8b62', EDGEGAP_BASE_URL: baseUrl, ...extraEnv },
    stderr: 'ignore',
  });
  const c = new Client({ name: 'ops', version: '1.0.0' });
  await c.connect(transport);
  return c;
}
const text = (r) => r.content.map((x) => x.text).join('\n');
const json = (r) => JSON.parse(r.content.filter((x, i) => !(i === 0 && /^\[[^\]]+\]$/.test(x.text)) && !x.text.startsWith('NOTE:')).map((x) => x.text).join('\n'));
const c = await connect();
const call = (name, args) => c.callTool({ name, arguments: args });

// ---------------------------------------------------------- fleet health ----
console.log('\nedgegap_fleet_health');
let r = json(await call('edgegap_fleet_health', { application: 'ops-game', check_crashes: true }));
check('counts by status', r.by_status.ready === 2 && r.by_status.error === 1 && r.by_status.pending === 1, JSON.stringify(r.by_status));
check('errors listed with detail and location', r.errors?.[0]?.request_id === 'baddep000001' && /139/.test(r.errors[0].detail) && r.errors[0].location === 'Frankfurt, Germany');
check('stuck starting > 10 min flagged', r.stuck_starting?.[0]?.request_id === 'slowdep00001');
check('crashes from crash data', r.crashes?.[0]?.restarts === 2 && r.crashes[0].exit_code === 139);
check('Frankfurt flagged unhealthy, by_version sorted worst first', r.unhealthy_locations?.includes('Frankfurt, Germany') && r.by_version[0].version === 'ops-game / v2' && r.by_version[0].error_rate === 0.5, JSON.stringify(r.by_version));
check('verdict names the problems', /1 in error, 1 stuck/.test(r.verdict), r.verdict);
r = json(await call('edgegap_fleet_health', { application: 'ops-game', max_deployments: 2 }));
check('cap: only the first N inspected, the rest counted', r.inspected === 2 && r.not_inspected === 2, JSON.stringify(r).slice(0, 200));
r = json(await call('edgegap_fleet_health', { application: 'nothing-game' }));
check('nothing running: an empty state, not an error', r.status === 'empty');
let res = await call('edgegap_fleet_health', { version: 'v1' });
check('version without application refused', res.isError);

// ------------------------------------------------------------ log search ----
console.log('\nedgegap_search_deployment_logs');
r = json(await call('edgegap_search_deployment_logs', { application: 'ops-game' }));
check('default pattern finds errors across deployments', r.deployments_with_matches === 2 && r.matching_lines >= 3, JSON.stringify(r).slice(0, 300));
check('grouped: the NullReference pair is one group of 2', r.groups?.[0]?.count === 2 && /NullReferenceException/.test(r.groups[0].example), JSON.stringify(r.groups));
check('exit codes counted', r.exit_codes?.['139'] === 1);
r = json(await call('edgegap_search_deployment_logs', { application: 'ops-game', version: 'v1', pattern: 'timeout' }));
check('plain pattern scoped to a version', r.matching_lines === 1 && r.groups[0].deployments[0] === 'okdep0000002');
calls.length = 0;
await call('edgegap_search_deployment_logs', { application: 'ops-game', started_after: '2026-11-12T00:00:00Z' });
check('started_after becomes a created_at gte filter', calls.some((x) => x.url.startsWith('/v1/deployments') && decodeURIComponent(x.url).includes('"created_at","operator":"gte"')));
res = await call('edgegap_search_deployment_logs', { application: 'ops-game', pattern: '(a+)+', regex: true });
check('dangerous regex refused', res.isError && /Nested quantifiers/.test(text(res)));
res = await call('edgegap_search_deployment_logs', { application: 'ops-game', started_after: 'yesterday' });
check('bad started_after refused', res.isError && /ISO 8601/.test(text(res)));

// -------------------------------------------------------- compare versions ----
console.log('\nedgegap_compare_versions');
r = json(await call('edgegap_compare_versions', { application: 'ops-game', version_a: 'v1', version_b: 'v2' }));
check('both sides: requested resources and inspected count', r.a.requested.memory_mb === 512 && r.a.inspected === 2 && r.b.inspected === 2);
check('error rate and restarts per version', r.a.error_rate === 0 && r.b.error_rate === 0.5 && r.b.restarts === 2 && r.b.exit_codes?.[0] === 139);
check('pooled p95 per version', r.a.memory.p95 > 200 && r.b.memory.p95 >= 540, JSON.stringify(r.b.memory));
check('differences spelled out', r.differences.some((d) => /memory p95 is \d+ % higher in v2/.test(d)) && r.differences.some((d) => /CPU-throttled/.test(d)), JSON.stringify(r.differences));
res = await call('edgegap_compare_versions', { application: 'ops-game', version_a: 'v1', version_b: 'v1' });
check('same version twice refused', res.isError);

// --------------------------------------------------------------- metrics ----
console.log('\nedgegap_get_deployment_metrics');
r = json(await call('edgegap_get_deployment_metrics', { request_id: 'baddep000001' }));
check('p95 per series', typeof r.cpu.p95 === 'number' && typeof r.memory.p95 === 'number');
check('anomalies collected at the top', Array.isArray(r.anomalies) && r.anomalies.some((a) => /^memory: rising/.test(a)) && r.anomalies.some((a) => /^cpu_throttle_rate: above zero/.test(a)), JSON.stringify(r.anomalies));
r = json(await call('edgegap_get_deployment_metrics', { request_id: 'okdep0000001' }));
check('steady deployment: none found', r.anomalies === 'none found', JSON.stringify(r.anomalies));

// --------------------------------------------------------------- confirm ----
console.log('\nconfirm on destructive tools');
calls.length = 0;
r = json(await call('edgegap_stop_deployment', { request_id: 'prodserver01' }));
check('stop of a running deployment the agent did not start: preview, nothing sent', r.status === 'confirmation_required' && r.deployment.application === 'prod-game' && !calls.some((x) => x.method === 'DELETE'), JSON.stringify(r).slice(0, 200));
calls.length = 0;
r = json(await call('edgegap_stop_deployment', { request_id: 'prodserver01', confirm: true }));
check('...with confirm: true it is stopped', calls.some((x) => x.method === 'DELETE' && x.url === '/v1/stop/prodserver01'));
calls.length = 0;
await call('edgegap_stop_deployment', { request_id: 'agentdep0001' });
check('an agent-tagged deployment stops without confirm (cleanup)', calls.some((x) => x.method === 'DELETE' && x.url === '/v1/stop/agentdep0001'));
calls.length = 0;
r = json(await call('edgegap_delete_app_version', { application: 'idle-game', version: 'old-1' }));
check('delete_app_version without confirm: preview with the version, nothing deleted', r.status === 'confirmation_required' && r.version?.name === 'old-1' && !calls.some((x) => x.method === 'DELETE'));
calls.length = 0;
r = json(await call('edgegap_delete_app', { application: 'idle-game' }));
check('delete_app without confirm: preview, nothing deleted', r.status === 'confirmation_required' && !calls.some((x) => x.method === 'DELETE'));
calls.length = 0;
r = json(await call('edgegap_delete_registry_tag', { image_name: 'srv', tag: 'b1' }));
check('delete_registry_tag without confirm: preview, nothing deleted', r.status === 'confirmation_required' && r.tag === 'b1' && calls.length === 0);
r = json(await call('edgegap_delete_registry_tag', { image_name: 'srv', tag: 'b1', dry_run: true }));
check('dry_run still shows the request without confirm', r.dry_run === true && r.requests?.[0]?.method === 'DELETE');
r = json(await call('edgegap_context', {}));
check('context lists the confirm guardrail', /confirm: true/.test(r.guardrails.confirm));
await c.close();

// ---------------------------------------------- allowlist on request_id ----
console.log('\nallowlist on stop, tag and report');
const al = await connect({ EDGEGAP_APP_ALLOWLIST: 'ops-game' });
for (const [name, args] of [
  ['edgegap_stop_deployment', { request_id: 'prodserver01', confirm: true }],
  ['edgegap_tag_deployment', { request_id: 'prodserver01', add: ['x'] }],
  ['edgegap_report_deployment', { request_id: 'prodserver01', reason: 'test' }],
]) {
  calls.length = 0;
  res = await al.callTool({ name, arguments: args });
  check(`${name}: deployment of another application refused, nothing sent`, res.isError && /prod-game/.test(text(res)) && !calls.some((x) => x.method !== 'GET'), text(res).slice(0, 200));
}
calls.length = 0;
res = await al.callTool({ name: 'edgegap_stop_deployment', arguments: { request_id: 'agentdep0001' } });
check('...a deployment of a listed application is stopped', !res.isError && calls.some((x) => x.method === 'DELETE'));
res = await al.callTool({ name: 'edgegap_fleet_health', arguments: {} });
check('reads stay open with an allowlist', !res.isError);
await al.close();

mock.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
