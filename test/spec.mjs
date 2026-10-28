// Spec parity: every request this server can send exists in Edgegap's
// published OpenAPI specs (spec/), with body fields the spec knows.
//
// Two passes:
// 1. Static: every this.request(...) in src/client.ts names a method + path
//    that the spec has. Catches a typo'd or retired endpoint.
// 2. Dynamic: every write tool is called with dry_run and as many fields as
//    it takes; each planned request's body keys (and the keys of objects in
//    its arrays) must be properties of the spec's request schema. Catches a
//    field the API would silently ignore. Dry runs send nothing.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

const specs = {
  v1: JSON.parse(readFileSync('spec/edgegap-v1-openapi.json', 'utf8')),
  v2: JSON.parse(readFileSync('spec/edgegap-v2-openapi.json', 'utf8')),
};

// Endpoints the client calls that Edgegap does not publish. Each one is
// documented where it is called; add to this list only with that comment.
const UNPUBLISHED = new Set([
  'GET /v1/wizard/registry-credentials',
  'POST /v1/wizard/init-quick-start',
]);

// Body fields sent although the spec does not list them, each with the reason.
// Empty since spec 2026.08.05 documented DeploymentV2.resources.
const UNPUBLISHED_FIELDS = {};

function resolve(spec, schema, depth = 0) {
  if (!schema || depth > 8) return schema ?? {};
  if (schema.$ref) return resolve(spec, spec.components.schemas[schema.$ref.split('/').pop()], depth + 1);
  if (schema.allOf) {
    const parts = schema.allOf.map((x) => resolve(spec, x, depth + 1));
    return { ...schema, properties: Object.assign({}, ...parts.map((x) => x.properties ?? {})) };
  }
  if (schema.anyOf || schema.oneOf) {
    const parts = (schema.anyOf ?? schema.oneOf).map((x) => resolve(spec, x, depth + 1));
    const withProps = parts.find((x) => x.properties || x.items);
    return withProps ?? parts[0] ?? {};
  }
  return schema;
}

/** The spec operation for METHOD + a concrete path, or undefined. */
function findOperation(method, path) {
  const version = path.startsWith('/v2/') ? 'v2' : 'v1';
  const local = version === 'v2' ? path.slice(3) : path;
  const spec = specs[version];
  for (const [template, ops] of Object.entries(spec.paths)) {
    const re = new RegExp('^' + template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}|\{[^}]+\}/g, '[^/]+') + '$');
    if (re.test(local) && ops[method.toLowerCase()]) return { spec, op: ops[method.toLowerCase()], template };
  }
  return undefined;
}

// --------------------------------------------------------------- static ----
console.log('\nclient endpoints are in the spec');
const clientSrc = readFileSync('src/client.ts', 'utf8');
const calls = [...clientSrc.matchAll(/this\.request<[\s\S]*?>\(\s*'(GET|POST|PATCH|DELETE)',\s*'(v1|v2)',\s*(`[^`]*`|'[^']*')/g)];
check('found the client\'s requests', calls.length >= 20, `${calls.length}`);
for (const [, method, version, raw] of calls) {
  const path = (version === 'v2' ? '/v2' : '') + raw.slice(1, -1).replace(/\$\{[^}]+\}/g, 'x');
  const key = `${method} ${raw.slice(1, -1)}`;
  if (UNPUBLISHED.has(key)) {
    check(`${key} (unpublished, documented)`, true);
    continue;
  }
  check(`${method} ${raw.slice(1, -1)}`, findOperation(method, path) !== undefined, 'not in spec/edgegap-*-openapi.json');
}

// -------------------------------------------------------------- dynamic ----
console.log('\nwrite-tool request bodies match the spec');
const c = new Client({ name: 'spec-parity', version: '1.0.0' });
await c.connect(new StdioClientTransport({
  command: 'node', args: ['dist/index.js'], stderr: 'ignore',
  // Never contacted: every call below is a dry run.
  env: { PATH: process.env.PATH, EDGEGAP_API_TOKEN: 'spec-parity-fake-token', EDGEGAP_BASE_URL: 'http://127.0.0.1:9' },
}));

const ports = [{ port: 7777, protocol: 'UDP', name: 'gameport', to_check: true }, { port: 7778, protocol: 'WS', tls_upgrade: true }];
const env = [{ key: 'GAME_MODE', value: 'ffa' }];
const full = {
  edgegap_create_app: { name: 'my-game', is_active: true },
  edgegap_update_app: { application: 'my-game', is_active: false },
  edgegap_create_app_version: {
    application: 'my-game', name: 'v1', docker_repository: 'registry.edgegap.com', docker_image: 'proj/srv', docker_tag: 'b1',
    cpu_units: 512, memory_mb: 1024, ports, registry_username: 'robot', registry_token: 'x', max_duration_minutes: 30, verify_image: true, env,
  },
  edgegap_update_app_version: {
    application: 'my-game', version: 'v1', is_active: true, docker_repository: 'registry.edgegap.com', docker_image: 'proj/srv', docker_tag: 'b2',
    cpu_units: 512, memory_mb: 1024, registry_username: 'robot', registry_token: 'x', max_duration_minutes: 30, force_cache: true, verify_image: true, termination_grace_period_seconds: 10,
    ports, env,
  },
  edgegap_deploy: { application: 'my-game', version: 'v1', users: { ip_addresses: ['203.0.113.1'], geo_coordinates: [{ latitude: 45, longitude: -73 }] }, env, tags: ['ci'], cpu_units: 512, memory_mb: 1024 },
  edgegap_stop_deployment: { request_id: '7e709a0d8efd' },
  edgegap_delete_registry_tag: { image_name: 'srv', tag: 'b1' },
  edgegap_create_relay_session: { user_ips: ['203.0.113.1'], webhook_url: 'https://hooks.example.com/relay' },
  edgegap_authorize_relay_user: { session_id: 'abc123-S', user_ip: '203.0.113.2' },
  edgegap_revoke_relay_user: { session_id: 'abc123-S', user_authorization_token: 901 },
  edgegap_delete_relay_session: { session_id: 'abc123-S' },
};

const { tools } = await c.listTools();
const writeTools = tools.filter((t) => t.inputSchema?.properties?.dry_run).map((t) => t.name);
check('every dry-run tool has a parity case', writeTools.every((n) => full[n]), writeTools.filter((n) => !full[n]).join(', '));

for (const [name, args] of Object.entries(full)) {
  const r = await c.callTool({ name, arguments: { ...args, dry_run: true } });
  const payload = r.structuredContent ?? JSON.parse(r.content.at(-1).text);
  const reqs = payload.requests ?? [];
  if (r.isError || reqs.length === 0) {
    check(`${name}: dry run planned a request`, false, r.content.map((x) => x.text).join(' ').slice(0, 160));
    continue;
  }
  for (const req of reqs) {
    const found = findOperation(req.method, req.path);
    if (!found) {
      check(`${name}: ${req.method} ${req.path} is in the spec`, false);
      continue;
    }
    const schema = resolve(found.spec, found.op.requestBody?.content?.['application/json']?.schema);
    if (req.body === undefined) {
      check(`${name}: ${req.method} ${found.template}`, true);
      continue;
    }
    const known = Object.keys(schema.properties ?? {});
    const allowed = UNPUBLISHED_FIELDS[`${req.method} ${found.template}`] ?? [];
    const unknown = Object.keys(req.body).filter((k) => !known.includes(k) && !allowed.includes(k));
    // One level down: objects inside arrays (ports, envs, users...).
    for (const [k, v] of Object.entries(req.body)) {
      if (!Array.isArray(v) || typeof v[0] !== 'object' || v[0] === null) continue;
      const item = resolve(found.spec, resolve(found.spec, schema.properties?.[k]).items);
      if (!item.properties) continue;
      for (const row of v) for (const ik of Object.keys(row)) if (!(ik in item.properties)) unknown.push(`${k}[].${ik}`);
    }
    check(`${name}: ${req.method} ${found.template} body fields are in the spec`, unknown.length === 0, [...new Set(unknown)].join(', '));
  }
}
await c.close();

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
