// Exercises the self-hosted HTTP server (dist/http.js) against a local mock of
// the Edgegap API (EDGEGAP_BASE_URL), so no real network calls are made.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

const TOKEN = '0f8b3c1e-e458-4592-b607-c2c28afd8b62';
const calls = [];
const mock = http.createServer((req, res) => {
  calls.push({ url: req.url, auth: req.headers.authorization });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ applications: [{ name: 'my-game' }], total_count: 1 }));
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));

const port = 18000 + Math.floor(Math.random() * 1000);
// Started through the main command's --http flag, the way npm users run it.
const proc = spawn('node', ['dist/index.js', '--http'], {
  env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1',
    EDGEGAP_BASE_URL: `http://127.0.0.1:${mock.address().port}`,
    EDGEGAP_API_TOKEN: 'ambient-token-must-be-ignored' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
await new Promise((resolve, reject) => {
  proc.stderr.on('data', (d) => /listening/.test(d) && resolve());
  proc.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
});
const base = `http://127.0.0.1:${port}`;

async function connect(authorization) {
  const c = new Client({ name: 'http-test', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: authorization ? { headers: { Authorization: authorization } } : undefined,
  }));
  return c;
}
const text = (r) => r.content.map((x) => x.text).join('\n');

console.log('\nhttp server');
check('/health answers without a token', (await (await fetch(`${base}/health`)).text()) === 'ok');
check('GET /mcp is refused (stateless)', (await fetch(`${base}/mcp`)).status === 405);
check('unknown path is 404', (await fetch(`${base}/nope`)).status === 404);

let c = await connect();
const { tools } = await c.listTools();
check('discovery works without a token', tools.length >= 19, `${tools.length} tools`);
let r = await c.callTool({ name: 'edgegap_list_apps', arguments: {} });
check('tool call without a token explains what to do', r.isError && /No Edgegap API token/.test(text(r)));
check('ambient EDGEGAP_API_TOKEN is never used', !calls.some((x) => /ambient/.test(x.auth ?? '')));
await c.close();

c = await connect('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig');
r = await c.callTool({ name: 'edgegap_list_apps', arguments: {} });
check('a foreign JWT is not relayed', r.isError && /does not contain an Edgegap/.test(text(r)) && calls.length === 0);
await c.close();

// Clients also mint plain opaque tokens, with no dots. Edgegap tokens are UUIDs,
// so these are foreign too, and never relayed for a confusing 401.
for (const header of ['Bearer mcp_at_9f8e7d6c5b4a39281706f5e4d3c2b1a0', 'Bearer 2YotnFZFEjr1zCsicMWpAA']) {
  c = await connect(header);
  r = await c.callTool({ name: 'edgegap_list_apps', arguments: {} });
  check(`a foreign opaque token (${header.length - 7} chars) is not relayed`, r.isError && /does not contain an Edgegap/.test(text(r)) && calls.length === 0, text(r).slice(0, 160));
  await c.close();
}

c = await connect(`token ${TOKEN}`);
r = await c.callTool({ name: 'edgegap_list_apps', arguments: {} });
check('a real token reaches the API as "token <value>"', !r.isError && calls.at(-1)?.auth === `token ${TOKEN}`, text(r).slice(0, 200));
check('the token never appears in output', !text(r).includes(TOKEN));
await c.close();

// The prefix doubles when an EDGEGAP_API_TOKEN that already holds "token <uuid>"
// goes into a header template that adds "token " again. This used to be
// refused as a foreign credential.
for (const header of [`token token ${TOKEN}`, `Bearer token ${TOKEN}`, `Bearer ${TOKEN}`, TOKEN]) {
  c = await connect(header);
  r = await c.callTool({ name: 'edgegap_list_apps', arguments: {} });
  check(`"${header.replace(TOKEN, '<uuid>')}" reaches the API as "token <uuid>"`, !r.isError && calls.at(-1)?.auth === `token ${TOKEN}`, text(r).slice(0, 160));
  await c.close();
}

// The skills need no token, so they work on the hosted server even for clients
// that cannot send one (claude.ai and Claude Desktop connectors).
c = await connect();
r = await c.callTool({ name: 'edgegap_list_skills', arguments: {} });
check('skills are served without a token', !r.isError && /edgegap-unity/.test(text(r)));
check('skill prompts are listed over HTTP', (await c.listPrompts()).prompts.some((p) => p.name === 'edgegap'));
check('hosted instructions open with the skills line', (c.getInstructions() ?? '').startsWith('Before acting, read edgegap-skill://edgegap/SKILL.md'));
await c.close();

// Per-connection limits (0.19.0): headers can narrow the server, never widen it.
const withHeaders = async (headers) => {
  const hc = new Client({ name: 'http-test', version: '1.0.0' });
  await hc.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `token ${TOKEN}`, ...headers } },
  }));
  return hc;
};
c = await withHeaders({ 'X-Edgegap-Read-Only': '1' });
let names = (await c.listTools()).tools.map((t) => t.name);
check('X-Edgegap-Read-Only: 1 hides the write tools', !names.includes('edgegap_deploy') && !names.includes('edgegap_stop_deployment') && names.includes('edgegap_fleet_health'), names.length);
r = await c.callTool({ name: 'edgegap_context', arguments: {} });
check('...and edgegap_context reports read_only', /"read_only": true/.test(text(r)));
await c.close();
c = await withHeaders({ 'X-Edgegap-App-Allowlist': 'my-game' });
r = await c.callTool({ name: 'edgegap_create_app', arguments: { name: 'other-game', image: 'x' } });
check('X-Edgegap-App-Allowlist refuses another application', r.isError && /ALLOWLIST/.test(text(r)), text(r).slice(0, 160));
await c.close();

proc.kill('SIGTERM');
mock.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
