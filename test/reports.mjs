// The per-call analytics report (RegisterOptions.onToolCall, src/callreport.ts)
// that the hosted Worker merges into PostHog's $mcp_tool_call events: success,
// error_code, failed_stage, upstream_status, tool facts, milestones. Runs the
// real tool definitions over an in-memory MCP connection against a local mock
// of the Edgegap API. Also checks the API token never appears in any report.
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../dist/tools.js';
import { EdgegapClient } from '../dist/client.js';
import { StaticTokenProvider } from '../dist/auth.js';
import { unavailableMessage } from '../dist/hosted.js';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

const TOKEN = '0f8b3c1e-e458-4592-b607-c2c28afd8b62';
const SECRET_APP = 'secret-app-name-123';
let polls = 0;
const mock = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const { pathname } = new URL(req.url, 'http://x');
    switch (`${req.method} ${pathname}`) {
      case 'GET /v1/apps':
        return send(200, { applications: [{ name: 'my-game', is_active: true }], total_count: 1 });
      case `GET /v1/app/${SECRET_APP}/versions`:
        // An API error that echoes the caller's token and the app name.
        return send(404, { message: `App ${SECRET_APP} not found for token ${TOKEN}` });
      case 'GET /v1/status/abcdef123456':
        polls++;
        return send(200, polls < 2
          ? { request_id: 'abcdef123456', current_status: 'Status.DEPLOYING', running: false }
          : { request_id: 'abcdef123456', current_status: 'Status.READY', running: true, fqdn: 'x.pr.edgegap.net' });
      case 'GET /v1/deployments':
        return send(500, { message: 'upstream exploded' });
      default:
        return send(500, { message: `no route ${pathname}` });
    }
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${mock.address().port}`;

async function connect(token, problem) {
  const reports = [];
  const config = {
    envToken: undefined, baseUrlV1: base, baseUrlV2: `${base}/v2`, readOnly: false, appAllowlist: [],
    maxDurationCeiling: 60, maxAgentDeployments: 5, requestTimeoutMs: 5000, transport: 'hosted',
  };
  const auth = new StaticTokenProvider(token, problem ? unavailableMessage(problem) : undefined, problem);
  const server = new McpServer({ name: 'edgegap', version: 'test' });
  registerTools(server, new EdgegapClient(config, auth), config, auth, {
    skillsCheck: { enabled: false, rawBase: '' },
    onToolCall: (r) => { reports.push(r); },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'reports', version: '1.0.0' });
  await client.connect(b);
  const call = async (name, args = {}) => {
    const before = reports.length;
    const result = await client.callTool({ name, arguments: args });
    await new Promise((r) => setTimeout(r, 10));
    return { result, report: reports[before] };
  };
  return { call, reports, close: () => client.close() };
}

const t = await connect(TOKEN);
let x;

console.log('\nsuccess');
x = await t.call('edgegap_list_apps');
check('list_apps: success, upstream 200, one API call, latency', x.report?.success === true && x.report.upstream_status === 200 && x.report.upstream_calls === 1 && typeof x.report.latency_ms === 'number', JSON.stringify(x.report));
check('list_apps: no error fields on success', !('error_code' in x.report) && !('failed_stage' in x.report));
check('list_apps with apps: "existing app found" milestone', x.report.milestones.includes('app_created'));
x = await t.call('edgegap_validate_server_config', { dockerfile: 'FROM ubuntu:22.04\nCOPY . /app\nCMD ["/app/server"]', ports: [{ port: 7777, protocol: 'UDP' }] });
check('validate_server_config: validation_result and issue_count, no API call', ['pass', 'fail'].includes(x.report.props.validation_result) && typeof x.report.props.issue_count === 'number' && x.report.upstream_status === null, JSON.stringify(x.report.props));
x = await t.call('edgegap_get_skill', { skill: 'edgegap-unity' });
check('get_skill: skill_name and resource_uri', x.report.props.skill_name === 'edgegap-unity' && x.report.props.resource_uri === 'edgegap-skill://edgegap-unity/SKILL.md');
x = await t.call('edgegap_wait_for_deployment', { request_id: 'abcdef123456', timeout_seconds: 30 });
check('wait ready: outcome, final_status, poll_count, timeout_ms_configured', x.report.props.outcome === 'ready' && x.report.props.final_status === 'Status.READY' && x.report.props.poll_count === 2 && x.report.props.timeout_ms_configured === 30000, JSON.stringify(x.report.props));
check('wait ready: deployment_ready milestone, request_id handed over for hashing', x.report.milestones.includes('deployment_ready') && x.report.hash.request_id === 'abcdef123456');
x = await t.call('edgegap_stop_deployment', { request_id: 'abcdef123456', dry_run: true });
check('a dry run is marked dry_run', x.report.dry_run === true && x.report.success === true);

console.log('\nfailures');
x = await t.call('edgegap_list_app_versions', { application: SECRET_APP });
check('API 404: APP_NOT_FOUND at upstream, status 404', x.report.success === false && x.report.error_code === 'APP_NOT_FOUND' && x.report.failed_stage === 'upstream' && x.report.upstream_status === 404, JSON.stringify(x.report));
check('error_message: argument values masked, under 300 characters', !x.report.error_message.includes(SECRET_APP) && /<application>/.test(x.report.error_message) && x.report.error_message.length <= 300, x.report.error_message);
x = await t.call('edgegap_list_deployments');
check('API 500: UPSTREAM_ERROR at upstream', x.report.error_code === 'UPSTREAM_ERROR' && x.report.failed_stage === 'upstream' && x.report.upstream_status === 500);
x = await t.call('edgegap_stop_deployment', { request_id: '*' });
check('a refused stop: pre_flight, no API call', x.report.success === false && x.report.failed_stage === 'pre_flight' && x.report.upstream_status === null && x.report.upstream_calls === 0, JSON.stringify(x.report));
x = await t.call('edgegap_deploy', { application: 1 });
check('bad arguments (rejected by the SDK): VALIDATION_FAILED, pre_flight', x.report?.tool === 'edgegap_deploy' && x.report.error_code === 'VALIDATION_FAILED' && x.report.failed_stage === 'pre_flight', JSON.stringify(x.report));
x = await t.call('edgegap_get_skill', { skill: 'no-such-skill' });
check('unknown skill: SKILL_NOT_FOUND', x.report.error_code === 'SKILL_NOT_FOUND');
await t.close();

const absent = await connect(undefined, 'absent');
x = await absent.call('edgegap_list_apps');
check('no token: AUTH_ABSENT at pre_flight, API never called', x.report.error_code === 'AUTH_ABSENT' && x.report.failed_stage === 'pre_flight' && x.report.upstream_status === null, JSON.stringify(x.report));
x = await absent.call('edgegap_get_skill', { skill: 'edgegap' });
check('no token: skills still succeed', x.report.success === true);
await absent.close();
const foreign = await connect(undefined, 'foreign');
x = await foreign.call('edgegap_list_locations');
check('a client-issued bearer: AUTH_FOREIGN at pre_flight', x.report.error_code === 'AUTH_FOREIGN' && x.report.failed_stage === 'pre_flight');
x = await foreign.call('edgegap_context');
check('context reports the token state', x.report.success && x.report.props.token_state === 'foreign', JSON.stringify(x.report.props));
await foreign.close();

console.log('\nprivacy');
const all = JSON.stringify(t.reports);
check('the API token never appears in any report', !all.includes(TOKEN) && !all.includes(TOKEN.replace(/-/g, '')));

mock.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
