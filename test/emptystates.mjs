// Empty and "not set up" states, next steps, and the onboarding paths without
// a token, against a local mock of the Edgegap API (EDGEGAP_BASE_URL). An
// empty organization must get a normal result with the next action, never an
// error the agent retries.
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

const TOKEN = '0f8b3c1e-e458-4592-b607-c2c28afd8b62';
let readyPolls = 0;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    if (req.headers.authorization !== `token ${TOKEN}`) return send(401, { message: 'Invalid token' });
    const { pathname } = new URL(req.url, 'http://x');
    switch (`${req.method} ${pathname}`) {
      case 'GET /v1/apps':
        return send(200, { applications: [], total_count: 0 });
      case 'GET /v1/app/empty-game/versions':
        return send(200, { versions: [], total_count: 0 });
      case 'GET /v1/deployments':
        return send(200, { data: [], total_count: 0 });
      case 'GET /v1/relays/sessions':
        return send(200, { sessions: [], total_count: 0 });
      case 'GET /v1/container-registry/images/no-tags/tags':
        return send(200, { data: [], count: 0, pagination: { number: 1, has_next: false } });
      case 'GET /v1/container-registry/images/locked/tags':
        return send(403, { message: 'You are not authorized to access this resource.' });
      // Edgegap's own validation detail, and a plan limit.
      case 'POST /v1/app/my-game/version':
        return JSON.parse(body).name === 'over-quota'
          ? send(403, { message: 'Application version quota reached for your plan (10).' })
          : send(400, { message: 'Validation error', details: { name: ['A version with this name already exists.'], private_token: 'reg-secret-xyz' } });
      case 'GET /v1/status/readydep0001':
        readyPolls++;
        return send(200, readyPolls < 2
          ? { request_id: 'readydep0001', current_status: 'Status.DEPLOYING', running: false }
          : { request_id: 'readydep0001', current_status: 'Status.READY', running: true, fqdn: 'readydep0001.pr.edgegap.net', ports: { gameport: { name: 'gameport', external: 31000, internal: 7777, protocol: 'UDP' } } });
      default:
        return send(500, { message: `mock has no route for ${req.method} ${pathname}` });
    }
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${mock.address().port}`;

async function connect(env = {}) {
  const transport = new StdioClientTransport({
    command: 'node', args: ['dist/index.js'],
    env: { PATH: process.env.PATH, EDGEGAP_BASE_URL: base, EDGEGAP_SKILLS_CHECK: 'off', ...env },
    stderr: 'ignore',
  });
  const c = new Client({ name: 'emptystates', version: '1.0.0' });
  await c.connect(transport);
  return c;
}
const text = (r) => r.content.map((c) => c.text).join('\n');
const json = (r) => r.structuredContent ?? JSON.parse(r.content.find((x) => x.text.startsWith('{'))?.text ?? '{}');

const c = await connect({ EDGEGAP_API_TOKEN: TOKEN });
const call = (name, args = {}) => c.callTool({ name, arguments: args });
let res, r;

console.log('\nempty states are results, with a next step');
res = await call('edgegap_list_apps');
r = json(res);
check('list_apps on an empty org: status empty, [] and points at create_app', !res.isError && r.status === 'empty' && r.applications.length === 0 && /edgegap_create_app/.test(r.next_step), text(res));
res = await call('edgegap_list_apps', { limit: 500, page: 0 });
check('list_apps: out-of-range limit and page are clamped, not refused', !res.isError, text(res));
res = await call('edgegap_list_app_versions', { application: 'empty-game' });
r = json(res);
check('list_app_versions with none: status empty, points at create_app_version', !res.isError && r.status === 'empty' && /edgegap_create_app_version/.test(r.next_step));
res = await call('edgegap_list_deployments', { only_agent_deployments: true });
r = json(res);
check('list_deployments agent-only with none: nothing left to stop', !res.isError && r.status === 'empty' && /nothing is left to stop/.test(r.next_step));
res = await call('edgegap_list_relay_sessions');
r = json(res);
check('list_relay_sessions with none: status empty', !res.isError && r.status === 'empty' && r.sessions.length === 0);
res = await call('edgegap_list_registry_tags', { image_name: 'no-tags' });
r = json(res);
check('list_registry_tags, image with no tags: status empty, says to push', !res.isError && r.status === 'empty' && /Push a build/.test(r.next_step));
res = await call('edgegap_list_registry_tags', { image_name: 'locked', limit: 1000 });
r = json(res);
check('list_registry_tags 403: not_configured with the external-registry path', !res.isError && r.status === 'not_configured' && /Docker Hub/.test(r.next_step), text(res));

console.log('\nupstream validation passes through');
const version = { application: 'my-game', name: 'dup-1', docker_repository: 'docker.io', docker_image: 'me/srv', docker_tag: 'b1', cpu_units: 512, memory_mb: 512, ports: [{ port: 7777, protocol: 'UDP' }] };
res = await call('edgegap_create_app_version', version);
check('create_app_version 400: the API field detail reaches the agent', res.isError && /already exists/.test(text(res)), text(res));
check('create_app_version 400: secrets in the detail are masked', !text(res).includes('reg-secret-xyz'));
res = await call('edgegap_create_app_version', { ...version, name: 'over-quota' });
check('a quota error names the limit and where to raise it', res.isError && /quota reached for your plan \(10\)/.test(text(res)) && /Billing page/.test(text(res)) && !/new token/i.test(text(res)), text(res));

console.log('\nwait_for_deployment');
res = await call('edgegap_wait_for_deployment', { request_id: 'readydep0001', timeout_seconds: 2000 });
r = json(res);
check('ready: cost reminder with the exact stop call', !res.isError && /edgegap_stop_deployment \{request_id: "readydep0001"\}/.test(r.cost_reminder), text(res));
check('ready: next step names the address', /readydep0001\.pr\.edgegap\.net/.test(r.next_step));

console.log('\nedgegap_context token status');
r = json(await call('edgegap_context', { check_token: true }));
check('a working token: accepted, last four characters only', r.token_status?.state === 'accepted' && r.token_status.token_ends_with === '…8b62' && !JSON.stringify(r).includes(TOKEN), JSON.stringify(r.token_status));
check('lists what works without a token', r.works_without_token?.includes('edgegap_get_skill'));
r = json(await call('edgegap_context'));
check('without check_token: no API call, present (not checked)', r.token_status?.state === 'present (not checked)');
await c.close();

const bad = await connect({ EDGEGAP_API_TOKEN: '11111111-2222-3333-4444-555555555555' });
r = json(await bad.callTool({ name: 'edgegap_context', arguments: { check_token: true } }));
check('a rejected token: state rejected, with where to make a new one', r.token_status?.state === 'rejected' && /user-settings\?tab=tokens/.test(r.token_status.fix), JSON.stringify(r.token_status));
await bad.close();

console.log('\nno token at all');
const none = await connect();
res = await none.callTool({ name: 'edgegap_list_apps', arguments: {} });
check('a tool that needs a token: says how to get one, and where to sign up', res.isError && /user-settings\?tab=tokens/.test(text(res)) && /Sign up free/.test(text(res)) && /edgegap_get_skill/.test(text(res)), text(res));
res = await none.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap' } });
check('skills load without a token', !res.isError && /edgegap/.test(text(res)));
res = await none.callTool({ name: 'edgegap_build_matchmaker_config', arguments: { profile_name: 'casual', application: 'my-game', version: 'v1', team_count: 2, min_team_size: 1, max_team_size: 2 } });
r = json(res);
check('matchmaker config without a token: built, with a caution that the version was not checked', !res.isError && r.config && r.cautions?.some((x) => /no API token/.test(x)), text(res).slice(0, 300));
r = json(await none.callTool({ name: 'edgegap_context', arguments: {} }));
check('context without a token: not_provided, with the sign-up link', r.token_status?.state === 'not_provided' && /Sign up|sign up/.test(r.token_status.fix));
await none.close();

console.log('\nskills');
const s = await connect();
res = await s.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'unity' } });
check('a near-miss skill name gets a suggestion', res.isError && /Did you mean "edgegap-unity"/.test(text(res)), text(res).slice(0, 200));
res = await s.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-purrnet' } });
// The SKILL.md body itself tells the agent to copy EdgegapSettings.cs.meta
// (the asset finds its script by GUID), so only the file index is checked.
check('no .meta file is listed in the SKILL.md file index', !res.isError && /Other files in this skill/.test(text(res)) && !/\.meta\b/.test(text(res).split('Other files in this skill')[1]));
res = await s.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-purrnet', file: 'nope.md' } });
check('no .meta file is listed when a file is not found', res.isError && !/\.meta\b/.test(text(res)));
const metaPath = 'assets/unity/EdgegapSettings.cs.meta';
res = await s.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-purrnet', file: metaPath } });
check('a .meta file is still readable by exact path (Unity needs its GUID)', !res.isError, text(res).slice(0, 120));
const resources = (await s.listResources()).resources;
check('resources/list: no .meta file, every entry named, described and typed', resources.length > 0 && resources.every((x) => !x.uri.endsWith('.meta') && x.name && x.description && x.mimeType));
const prompts = (await s.listPrompts()).prompts;
const starter = prompts.find((p) => p.name === 'deploy-game-server');
check('one obvious starter prompt', starter?.title === 'Deploy my game server to Edgegap' && /Start here/.test(starter.description));
const got = await s.getPrompt({ name: 'deploy-game-server' });
check('the starter prompt walks the golden path and the cleanup', /edgegap_get_skill/.test(got.messages[0].content.text) && /only_agent_deployments: true/.test(got.messages[0].content.text));
await s.close();

mock.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
