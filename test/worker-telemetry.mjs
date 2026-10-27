// End-to-end check of the hosted Worker's PostHog MCP Analytics (@posthog/mcp):
// runs the real Worker under `wrangler dev` with POSTHOG_HOST pointed at a
// local fake PostHog, makes MCP calls, and inspects every event it sends.
//
//   npm run test:worker      (needs wrangler; not part of `npm test`)
//
// No call reaches Edgegap: the only API-bound call uses dry_run.
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

const TOKEN = '0f8b3c1e-e458-4592-b607-c2c28afd8b62';
// A token an MCP client minted for itself, with no dots: the looser check this
// replaced took it for an Edgegap token and relayed it.
const OPAQUE = 'mcp_at_9f8e7d6c5b4a39281706f5e4d3c2b1a0';
const SECRET_IP = '203.0.113.77';
const SECRET_ENV = 'env-value-must-not-leak';
const SECRET_APP = 'secret-app-name';

// ------------------------------------------------------- fake PostHog ----
// posthog-node posts batches, possibly gzip-compressed.
const events = [];
const raws = [];
const posthog = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let buf = Buffer.concat(chunks);
    if (req.headers['content-encoding'] === 'gzip' || /compression=gzip/.test(req.url) || (buf[0] === 0x1f && buf[1] === 0x8b)) buf = gunzipSync(buf);
    const text = buf.toString('utf8');
    raws.push(text);
    try {
      const body = JSON.parse(text);
      for (const e of body.batch ?? [body]) events.push({ ...e, api_key: body.api_key ?? e.api_key });
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"Ok"}');
  });
});
await new Promise((r) => posthog.listen(0, '127.0.0.1', r));

// ------------------------------------------------------------ Worker ----
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
async function startWorker(extraVars = []) {
  const port = 8700 + Math.floor(Math.random() * 90);
  const proc = spawn(npx, [
    'wrangler', 'dev', '--config', 'worker/wrangler.jsonc', '--local', '--port', String(port),
    '--var', 'POSTHOG_API_KEY:phc_test_key',
    '--var', `POSTHOG_HOST:http://127.0.0.1:${posthog.address().port}`,
    '--var', 'TELEMETRY_SALT:test-salt',
    // The test token's id (npm run telemetry:id), so its events are internal.
    '--var', 'TELEMETRY_INTERNAL_IDS:org_6c67f77e145367bacecdb6cecee6384d',
    ...extraVars.flatMap((v) => ['--var', v]),
  ], { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  let id = 0;
  const rpc = async (method, params, headers = {}) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', 'User-Agent': 'telemetry-test/1.0', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const text = await res.text();
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : undefined;
  };
  const stop = () => {
    // wrangler starts workerd as a child: kill the whole tree, and wait for it.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else proc.kill('SIGINT');
  };
  return { rpc, stop };
}
const settle = () => new Promise((r) => setTimeout(r, 2500));
const of = (name) => events.filter((e) => e.event === name);
const props = (e) => e?.properties ?? {};

let w = await startWorker();
try {
  const init = await w.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.0' } });
  const list = await w.rpc('tools/list', {});
  await w.rpc('tools/call', { name: 'edgegap_get_skill', arguments: { skill: 'edgegap-unity' } });
  await w.rpc('prompts/get', { name: 'edgegap-unreal' });
  await w.rpc('resources/read', { uri: 'edgegap-skill://edgegap/SKILL.md' });
  await w.rpc('tools/call', { name: 'edgegap_stop_deployment', arguments: { request_id: '*' } });
  const auth = { Authorization: `token ${TOKEN}` };
  await w.rpc('tools/call', { name: 'edgegap_deploy', arguments: { application: SECRET_APP, version: 'v1', users: { ip_addresses: [SECRET_IP] }, env: [{ key: 'K', value: SECRET_ENV }], dry_run: true } }, auth);
  await w.rpc('tools/call', { name: 'edgegap_context', arguments: {} }, auth);
  await w.rpc('tools/call', { name: 'edgegap_list_apps', arguments: {} });
  await w.rpc('tools/call', { name: 'edgegap_list_deployments', arguments: {} }, { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjbGllbnQifQ.clientsig' });
  await w.rpc('tools/call', { name: 'edgegap_get_registry_credentials', arguments: {} }, { Authorization: `Bearer ${OPAQUE}` });
  await w.rpc('tools/call', { name: 'edgegap_get_skill', arguments: { skill: 'no-such-skill' } });
  await w.rpc('tools/call', { name: 'edgegap_validate_server_config', arguments: { dockerfile: 'FROM ubuntu:22.04\nCMD ["/srv"]' } }, auth);

  await w.rpc('tools/call', { name: '__verifymcp_ping', arguments: {} });
  await w.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sentinel-probe', version: '1.0' } });
  await settle();

  console.log('\nthe Worker still works');
  check('initialize answers', init?.result?.serverInfo?.name === 'edgegap');
  const tools = list?.result?.tools ?? [];
  check('tools/list returns every tool', tools.length >= 20, `${tools.length}`);
  const injected = tools.filter((t) => ['context', 'conversation_id', 'llm_model'].some((k) => k in (t.inputSchema?.properties ?? {})));
  check('no analytics parameters added to tool schemas (agent fields off)', injected.length === 0, injected.map((t) => t.name).join(', '));

  console.log('\nPostHog MCP Analytics events');
  check('posted with the project key', events.length > 0 && events.every((e) => e.api_key === 'phc_test_key'), `${events.length} events`);
  check('$mcp_initialize with the client name', of('$mcp_initialize').some((e) => props(e).$mcp_client_name === 'claude-code'));
  check('$mcp_tools_list with tool names', of('$mcp_tools_list').some((e) => (props(e).$mcp_listed_tool_names ?? []).includes('edgegap_deploy')));
  const skill = of('$mcp_tool_call').find((e) => props(e).$mcp_tool_name === 'edgegap_get_skill');
  check('$mcp_tool_call for get_skill, with the skill and a duration', props(skill).skill === 'edgegap-unity' && typeof props(skill).$mcp_duration_ms === 'number');
  const stopped = of('$mcp_tool_call').find((e) => props(e).$mcp_tool_name === 'edgegap_stop_deployment');
  check('a refused stop is recorded as an error', props(stopped).$mcp_is_error === true);
  const deploy = of('$mcp_tool_call').find((e) => props(e).$mcp_tool_name === 'edgegap_deploy');
  check('deploy dry run recorded with dry_run', props(deploy).dry_run === true);
  check('$mcp_resource_read with the skill URI', of('$mcp_resource_read').some((e) => props(e).$mcp_resource_name === 'edgegap-skill://edgegap/SKILL.md'));
  check('$mcp_prompt_get with the skill name', of('$mcp_prompt_get').some((e) => props(e).prompt === 'edgegap-unreal'));

  console.log('\nidentity');
  const withToken = [deploy, ...of('$mcp_tool_call').filter((e) => props(e).$mcp_tool_name === 'edgegap_context')].filter(Boolean);
  check('token calls: one hashed org_ id', withToken.length === 2 && withToken.every((e) => /^org_[0-9a-f]{32}$/.test(e.distinct_id)) && new Set(withToken.map((e) => e.distinct_id)).size === 1, withToken.map((e) => e.distinct_id).join(' '));
  check('no-token calls: never an org_ id', of('$mcp_tool_call').filter((e) => props(e).has_token === false).every((e) => !String(e.distinct_id).startsWith('org_')));

  console.log('\nauth_problem');
  const noHeader = of('$mcp_tool_call').find((e) => props(e).$mcp_tool_name === 'edgegap_list_apps');
  check('no Authorization header: auth_problem "absent", recorded as an error', props(noHeader).auth_problem === 'absent' && props(noHeader).has_token === false && props(noHeader).$mcp_is_error === true, JSON.stringify(props(noHeader)));
  const foreign = of('$mcp_tool_call').find((e) => props(e).$mcp_tool_name === 'edgegap_list_deployments');
  check('client-issued bearer: auth_problem "foreign"', props(foreign).auth_problem === 'foreign' && props(foreign).has_token === false, JSON.stringify(props(foreign)));
  const opaque = of('$mcp_tool_call').find((e) => props(e).$mcp_tool_name === 'edgegap_get_registry_credentials');
  check('client-issued opaque (non-JWT) bearer: auth_problem "foreign"', props(opaque).auth_problem === 'foreign' && props(opaque).has_token === false, JSON.stringify(props(opaque)));
  check('calls with a token carry no auth_problem', withToken.every((e) => !('auth_problem' in props(e))));
  check('prompt reads carry auth_problem too', of('$mcp_prompt_get').some((e) => props(e).auth_problem === 'absent'));

  console.log('\nerror_cause and probe');
  check('a refused stop: error_cause guardrail_refused', props(stopped).error_cause === 'guardrail_refused', JSON.stringify(props(stopped)));
  check('no token: error_cause token_absent', props(noHeader).error_cause === 'token_absent', JSON.stringify(props(noHeader)));
  check('a foreign bearer: error_cause token_foreign', props(foreign).error_cause === 'token_foreign', JSON.stringify(props(foreign)));
  const badSkill = of('$mcp_tool_call').find((e) => props(e).$mcp_tool_name === 'edgegap_get_skill' && props(e).$mcp_is_error === true);
  check('an unknown skill: error_cause unknown_skill', props(badSkill).error_cause === 'unknown_skill', JSON.stringify(props(badSkill)));
  check('successful calls carry no error_cause', !('error_cause' in props(skill)) && !('error_cause' in props(deploy)));
  check('a scanner client is flagged probe', of('$mcp_initialize').some((e) => props(e).$mcp_client_name === 'sentinel-probe' && props(e).probe === true));
  check('a real client is not', of('$mcp_initialize').every((e) => props(e).$mcp_client_name === 'sentinel-probe' || !('probe' in props(e))));

  console.log('\nper-call facts (src/callreport.ts)');
  const calls = of('$mcp_tool_call');
  check('every tool call: tool_name, success, latency_ms, transport, server_version', calls.length > 5 && calls.every((e) => typeof props(e).tool_name === 'string' && typeof props(e).success === 'boolean' && typeof props(e).latency_ms === 'number' && props(e).transport === 'streamable_http' && typeof props(e).server_version === 'string'), JSON.stringify(calls.map((e) => [props(e).tool_name, props(e).success, props(e).latency_ms])));
  check('every failed call: error_code and failed_stage', calls.filter((e) => props(e).success === false).every((e) => typeof props(e).error_code === 'string' && typeof props(e).failed_stage === 'string'), JSON.stringify(calls.filter((e) => props(e).success === false).map((e) => [props(e).tool_name, props(e).error_code, props(e).failed_stage])));
  check('no token: AUTH_ABSENT, pre_flight, upstream_status null', props(noHeader).error_code === 'AUTH_ABSENT' && props(noHeader).failed_stage === 'pre_flight' && props(noHeader).upstream_status === null, JSON.stringify(props(noHeader)));
  check('foreign bearer: AUTH_FOREIGN', props(foreign).error_code === 'AUTH_FOREIGN');
  check('refused stop: GUARDRAIL_REFUSED at pre_flight', props(stopped).error_code === 'GUARDRAIL_REFUSED' && props(stopped).failed_stage === 'pre_flight', JSON.stringify(props(stopped)));
  // The stateless Worker only learns clientInfo on initialize: later calls name the client from User-Agent.
  check('tool calls without clientInfo: client_name from the User-Agent', calls.filter((e) => props(e).client_name_source === 'user_agent').length > 0 && calls.every((e) => typeof props(e).client_name === 'string' && ['client_info', 'user_agent'].includes(props(e).client_name_source)) && calls.filter((e) => props(e).client_name_source === 'user_agent').every((e) => props(e).client_name === 'telemetry-test' && props(e).client_version === '1.0'), JSON.stringify(calls.map((e) => [props(e).tool_name, props(e).client_name, props(e).client_name_source])));
  check('initialize keeps the clientInfo name', of('mcp_session_started').some((e) => props(e).client_name === 'claude-code' && props(e).client_name_source === 'client_info'));
  const validated = calls.find((e) => props(e).tool_name === 'edgegap_validate_server_config');
  check('validate_server_config: validation_result and issue_count', ['pass', 'fail'].includes(props(validated).validation_result) && typeof props(validated).issue_count === 'number', JSON.stringify(props(validated)));
  check('get_skill: skill_name', props(skill).skill_name === 'edgegap-unity');
  check('error_message on failures, sanitized and at most 300 characters', calls.filter((e) => props(e).success === false).every((e) => typeof props(e).error_message === 'string' && props(e).error_message.length <= 300));

  check('token calls: org_id_hash equals the distinct_id, is_internal from TELEMETRY_INTERNAL_IDS', withToken.every((e) => props(e).org_id_hash === e.distinct_id && props(e).is_internal === true));
  check('no-token calls: org_id_hash null, is_internal false', props(noHeader).org_id_hash === null && props(noHeader).is_internal === false);
  const probeCall = calls.find((e) => props(e).tool_name === '__verifymcp_ping');
  check('a made-up tool without a token: is_probe', props(probeCall).is_probe === true, JSON.stringify(props(probeCall)));
  check('a real client call is not is_probe', !('is_probe' in props(skill)));
  const started = of('mcp_session_started');
  check('mcp_session_started per initialize, with client_name and client_version', started.some((e) => props(e).client_name === 'claude-code' && props(e).client_version === '2.1.0' && props(e).transport === 'streamable_http'), JSON.stringify(started.map(props)));
  check('prompt reads carry prompt_name', of('$mcp_prompt_get').some((e) => props(e).prompt_name === 'edgegap-unreal'));

  console.log('\nprivacy');
  const everything = raws.join('\n');
  check('a foreign bearer is never sent', !everything.includes('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjbGllbnQifQ.clientsig') && !everything.includes(OPAQUE));
  check('the API token is never sent', !everything.includes(TOKEN) && !everything.includes(TOKEN.replace(/-/g, '')));
  check('tool argument values are never sent (IP, env value, app name), not even in error_message', !everything.includes(SECRET_IP) && !everything.includes(SECRET_ENV) && !everything.includes(SECRET_APP));
  check('no $mcp_parameters, $mcp_response or error text', events.every((e) => !('$mcp_parameters' in props(e)) && !('$mcp_response' in props(e)) && !('$mcp_error_message' in props(e))));
  check('no $exception events', of('$exception').length === 0);
  check('no skill document content in any event', !everything.includes('Pack version:'));
  check('GeoIP disabled on every event', events.every((e) => props(e).$geoip_disable === true));
  check('only allowlisted event names', events.every((e) => ['$mcp_initialize', '$mcp_tools_list', '$mcp_tool_call', '$mcp_resources_list', '$mcp_resource_read', '$mcp_prompt_get', '$identify', 'mcp_session_started'].includes(e.event) || e.event.startsWith('mcp_milestone_')), [...new Set(events.map((e) => e.event))].join(', '));

  console.log('\nopt-out');
  const before = events.length;
  await w.rpc('tools/call', { name: 'edgegap_list_skills', arguments: {} }, { 'X-Edgegap-Telemetry': 'off' });
  await w.rpc('tools/call', { name: 'edgegap_list_skills', arguments: {} }, { DNT: '1' });
  await settle();
  check('X-Edgegap-Telemetry: off and DNT: 1 send nothing', events.length === before, `${events.length - before} events`);
} finally {
  w.stop();
}

// ---------------------------------------------- agent fields switched on ----
console.log('\nPOSTHOG_AGENT_FIELDS=1');
events.length = 0;
w = await startWorker(['POSTHOG_AGENT_FIELDS:1']);
try {
  const list = await w.rpc('tools/list', {});
  const deploySchema = (list?.result?.tools ?? []).find((t) => t.name === 'edgegap_deploy')?.inputSchema?.properties ?? {};
  check('the SDK adds its context parameter to tool schemas', 'context' in deploySchema, Object.keys(deploySchema).join(', '));
  const out = await w.rpc('tools/call', { name: 'edgegap_list_skills', arguments: { context: 'checking which Edgegap skills exist' } });
  check('a call with context still works', out?.result && !out.result.isError);
  await settle();
  const call = of('$mcp_tool_call').find((e) => props(e).$mcp_tool_name === 'edgegap_list_skills');
  check('the intent is recorded', props(call).$mcp_intent === 'checking which Edgegap skills exist');
  // Output schemas survive the v2 SDK, and a schema-checked result still passes.
  const withOut = (list?.result?.tools ?? []).filter((t) => t.outputSchema);
  check('hosted: output schemas are published', withOut.length >= 14 && withOut.some((t) => t.name === 'edgegap_context'), `${withOut.length}`);
  const ctxOut = await w.rpc('tools/call', { name: 'edgegap_context', arguments: {} });
  check('hosted: a tool with an output schema returns structuredContent', ctxOut?.result?.structuredContent?.server?.startsWith('@edgegap/mcp') && !ctxOut.result.isError, JSON.stringify(ctxOut).slice(0, 200));
  const bad = await w.rpc('tools/call', { name: 'edgegap_deploy', arguments: { application: 1 } });
  const badText = (bad?.result?.content ?? []).map((c) => c.text).join('\n');
  check('hosted: bad arguments get the host label and one line per problem', bad?.result?.isError && /^\[/.test(bad.result.content[0].text) && /- version: missing \(required\)/.test(badText) && /Required: application, version, users/.test(badText), badText.slice(0, 200));
  // Skill files: SKILL.md listed, the rest read through the {+path} template on the v2 SDK too.
  const listed = (await w.rpc('resources/list', {}))?.result?.resources ?? [];
  const templates = (await w.rpc('resources/templates/list', {}))?.result?.resourceTemplates ?? [];
  check('hosted: one listed resource per skill, plus the file template', listed.every((x) => x.uri.endsWith('/SKILL.md')) && templates.some((t) => t.uriTemplate === 'edgegap-skill://{skill}/{+path}'), `${listed.length} listed, ${templates.map((t) => t.uriTemplate).join(' ')}`);
  const nested = await w.rpc('resources/read', { uri: 'edgegap-skill://edgegap-unreal/assets/docker/Dockerfile' });
  check('hosted: a nested skill file reads through the template', /FROM /.test(nested?.result?.contents?.[0]?.text ?? ''), JSON.stringify(nested).slice(0, 160));
} finally {
  w.stop();
  posthog.close();
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
