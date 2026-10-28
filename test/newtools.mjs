// Exercises the pre-deploy, relay and matchmaker tools against a local mock of
// the Edgegap API (EDGEGAP_BASE_URL), so no real network calls are made.
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

// ------------------------------------------------------------- mock API ----
const calls = [];
let provisioned = false;
// The wizard endpoints only accept the plugins' quick-start token; a regular
// API token gets 403 from both (verified against the live API, 2026-10-08).
let tokenType = 'regular';
let relayPolls = 0;
// The relay endpoints answer 403 for an organization without relays (live, 2026-10-22).
let relayForbidden = false;
// How many agent-tagged deployments the mock reports as running (the deploy cap).
let agentRunning = 0;
// Set once the mock refused a crowded-1 deploy: only then does its leftover exist.
let crowdedRefused = false;
// Images in the token's registry project. The API takes the image name only
// and reads the project from the token; nested names keep their slashes.
const REGISTRY_IMAGES = {
  'my-game-server': { data: [{ tag: 'build-42', last_push_at: '2026-09-30 12:00:00+00:00', artifact: { deleted: false, remaining_tags: ['build-42'], image_hash: 'sha256:abc', size_mb: 512 } }], count: 1, pagination: { number: 1, next_page_number: null, has_next: false } },
  'team/nested-server': { data: [{ tag: 'n-1', last_push_at: '2026-09-30 12:00:00+00:00', artifact: { image_hash: 'sha256:def', size_mb: 100 } }], count: 1, pagination: { number: 1, has_next: false } },
  'big-server': { data: [{ tag: 'b-1', last_push_at: '2026-09-30 12:00:00+00:00', artifact: { size_mb: 1 } }], count: 40, pagination: { number: 1, next_page_number: 2, has_next: true } },
};
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined, auth: req.headers.authorization, ua: req.headers['user-agent'] });
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    const { pathname } = new URL(req.url, 'http://x');
    const route = `${req.method} ${pathname}`;
    const tagsRoute = route.match(/^GET \/v1\/container-registry\/images\/(.+)\/tags$/);
    if (tagsRoute) {
      const image = tagsRoute[1];
      return REGISTRY_IMAGES[image]
        ? send(200, REGISTRY_IMAGES[image])
        : send(404, { message: `No image named ${image} found inside your project.` });
    }
    switch (route) {
      case 'GET /v1/wizard/registry-credentials':
        if (tokenType !== 'quickstart') return send(403, { message: 'This token is not a quick start token' });
        return provisioned
          ? send(200, { registry_url: 'registry.edgegap.com', project: 'my-org-abc123', username: 'robot$my-org', token: 'reg-token-xyz' })
          : send(404, { message: 'no registry project' });
      case 'POST /v1/wizard/init-quick-start':
        if (tokenType !== 'quickstart') return send(403, { message: 'This token is not a quick start token' });
        provisioned = true;
        return send(204);
      case 'POST /v1/relays/sessions':
        return send(200, { session_id: 'abc123-S', authorization_token: 111, status: 'Initializing', ready: false, linked: false, session_users: [] });
      case 'GET /v1/relays/sessions/abc123-S':
        relayPolls++;
        return send(200, relayPolls < 2
          ? { session_id: 'abc123-S', status: 'Initializing', ready: false, linked: false }
          : { session_id: 'abc123-S', authorization_token: 111, status: 'Linked', ready: true, linked: true,
              session_users: [{ ip_address: '203.0.113.1', authorization_token: 901 }, { ip_address: '198.51.100.7', authorization_token: 902 }],
              relay: { ip: '178.79.131.238', host: 'cc84b011777b.pr.edgegap.net', ports: { server: { port: 31527, protocol: 'UDP', link: 'cc84b011777b.pr.edgegap.net:31527' }, client: { port: 32089, protocol: 'UDP', link: 'cc84b011777b.pr.edgegap.net:32089' } } } });
      case 'POST /v1/relays/sessions:authorize-user':
        return send(200, { session_id: 'abc123-S', authorization_token: 111, status: 'Linked', ready: true, linked: true, session_user: { ip_address: '192.0.2.9', authorization_token: 903 } });
      case 'DELETE /v1/relays/sessions/abc123-S':
        return send(204);
      case 'GET /v1/app/my-game/versions':
        // Shapes as the live API returns them (2026-10-08): the registry token
        // comes back in plain text, and WS ports come back as "Websocket".
        return send(200, { versions: [
          { name: 'build-42', is_active: true, private_username: 'robot$pull', private_token: 'registry-secret-do-not-leak', ports: [{ port: 7777, protocol: 'UDP', name: 'gameport', tls_upgrade: false }] },
          { name: 'web-1', is_active: true, private_username: null, private_token: null, ports: [{ port: 7778, protocol: 'Websocket', name: 'gameport', tls_upgrade: true }] },
          { name: 'no-ports', is_active: true, ports: [] },
        ], total_count: 3 });
      case 'POST /v1/app/my-game/version': {
        const b = JSON.parse(body);
        // verify_image pulls with the version's registry login; without one,
        // Edgegap answers this bare 400, even for registry.edgegap.com.
        if (b.verify_image && !b.private_username) return send(400, { message: 'Unable to login with the given credentials' });
        return send(200, { success: true, version: { name: b.name } });
      }
      // A request_id Edgegap does not know is a 400, not a 404 (live, 2026-10-08).
      case 'GET /v1/status/unknown-id':
        return send(400, { message: 'Bad Request ID provided' });
      case 'GET /v1/deployment/unknown-id/container-logs':
        return send(400, { message: 'The browser (or proxy) sent a request that this server could not understand.' });
      case 'GET /v1/status/gone-deployment':
        return send(404, { message: 'Deployment not found' });
      case 'GET /v1/deployment/gone-deployment/container-logs':
        return send(404, { message: 'Deployment not found' });
      // Guardrail routes. max_duration: 60 (capped), 1440 (the API default,
      // a full day), -1 (no auto-stop).
      case 'GET /v1/app/my-game/version/build-42':
        return send(200, { name: 'build-42', docker_tag: 'build-42', max_duration: 60 });
      case 'GET /v1/app/my-game/version/long-1':
        return send(200, { name: 'long-1', docker_tag: 'long-1', max_duration: 1440 });
      case 'GET /v1/app/my-game/version/forever':
        return send(200, { name: 'forever', docker_tag: 'forever', max_duration: -1 });
      // A version made outside the agent, on the moving tag.
      case 'GET /v1/app/my-game/version/latest-1':
        return send(200, { name: 'latest-1', docker_tag: 'latest', max_duration: 60 });
      case 'POST /v2/deployments':
        // crowded-1: refused for capacity, yet a deployment record is created (live, 2026-10-28).
        if (JSON.parse(body).version === 'uncached-1') return send(422, { message: 'Deployment failed - App version caching disabled, please enable caching for this app version or allow non-cached locations in your deployment request.' });
        if (JSON.parse(body).version === 'crowded-1') crowdedRefused = true;
        if (JSON.parse(body).version === 'crowded-1') return send(422, { message: 'Not enough space on locations or no locations available' });
        return send(200, { request_id: '7e709a0d8efd' });
      // A deployment that crashed on start, with its logs still readable.
      case 'GET /v1/status/faileddep001':
        return send(200, { request_id: 'faileddep001', current_status: 'Status.ERROR', running: false, error: true, error_detail: 'Container exited with code 139' });
      case 'GET /v1/deployment/faileddep001/container-logs':
        return send(200, { logs: 'Loading world...\nSegmentation fault in ServerMain', crash_logs: null });
      // One that never gets ready within the wait.
      case 'GET /v1/status/slowdep00001':
        return send(200, { request_id: 'slowdep00001', current_status: 'Status.DEPLOYING', running: false, error: false });
      // The logs endpoint answers the same 400 whether a deployment is starting or stopped.
      case 'GET /v1/deployment/slowdep00001/container-logs':
      case 'GET /v1/deployment/stoppeddep01/container-logs':
        return send(400, { message: 'The browser (or proxy) sent a request that this server could not understand.' });
      // Stop on a deployment Edgegap already cleaned up, and on one already terminated.
      case 'DELETE /v1/stop/gonedeploy01':
      case 'GET /v1/status/gonedeploy01':
        return send(400, { message: 'Bad Request ID provided' });
      case 'DELETE /v1/stop/stoppeddep01':
        return send(400, { message: 'Deployment is already terminated' });
      case 'GET /v1/status/stoppeddep01':
        return send(200, { request_id: 'stoppeddep01', current_status: 'Status.TERMINATED', running: false, error: false });
      case 'DELETE /v1/stop/7e709a0d8efd':
        return send(200, { message: 'Deployment stop requested' });
      case 'POST /v1/app':
        return send(200, { name: JSON.parse(body).name, is_active: true });
      case 'GET /v1/app/ghost-game/versions':
        return send(404, { message: 'App not found' });
      case 'GET /v1/deployments': {
        // The deploy cap asks for agent-tagged deployments with limit 1 and
        // reads total_count.
        if (new URL(req.url, 'http://x').searchParams.get('limit') === '1') {
          return send(200, { data: [], total_count: agentRunning });
        }
        const filters = JSON.parse(new URL(req.url, 'http://x').searchParams.get('query') ?? '{}').filters ?? [];
        const f = (field) => filters.find((x) => x.field === field)?.value;
        // After a refused deploy: the deployment the 422 still created.
        if (f('created_at')) {
          // concurrent01 is a healthy deploy of the same version made just before.
          if (f('version') !== 'crowded-1') return send(200, { data: [], total_count: 0 });
          const rows = [{ request_id: 'concurrent01' }, ...(crowdedRefused ? [{ request_id: 'leftover0001' }] : [])];
          return send(200, { data: rows, total_count: rows.length });
        }
        // Delete checks: cleanup-game has nothing running, my-game build-42 has one.
        if (f('application') === 'cleanup-game') return send(200, { data: [], total_count: 0 });
        return send(200, { data: [{ request_id: '7e709a0d8efd', ready: true, fqdn: '7e709a0d8efd.pr.edgegap.net', start_time: '2026-09-30T12:00:00Z', tags: [] }], total_count: 1 });
      }
      // --- Gameye-parity tools (0.14.0). Shapes from spec/edgegap-v1/v2-openapi.json.
      // Caching off: require_cached_locations is refused (live, 2026-10-28).
      case 'GET /v1/app/my-game/version/uncached-1':
        return send(200, { name: 'uncached-1', docker_tag: 'uncached-1', max_duration: 60 });
      case 'GET /v1/app/my-game/version/crowded-1':
        return send(200, { name: 'crowded-1', docker_tag: 'crowded-1', max_duration: 60 });
      case 'POST /v2/private-fleets/deployments':
        return send(202, { request_id: 'fleetdep0001' });
      case 'GET /v2/private-fleets/my-fleet/hosts':
        return send(200, { data: [
          { host_id: 'host-a', status: 'ACTIVE', ip_address: '203.0.113.10', city: 'Montreal', country: 'Canada', continent: 'North America' },
          { host_id: 'host-b', status: 'PENDING', ip_address: null },
        ] });
      case 'GET /v2/private-fleets/empty-fleet/hosts':
        return send(200, { data: [] });
      case 'GET /v1/deployments/7e709a0d8efd/tags':
        return send(200, { tags: [{ name: 'edgegap-mcp' }, { name: 'match-1' }], total_count: 2 });
      case 'GET /v1/deployments/othersdep001/tags':
        return send(200, { tags: [{ name: 'prod' }], total_count: 1 });
      case 'POST /v1/deployments/7e709a0d8efd/tags':
        return send(200, { name: JSON.parse(body).name });
      case 'DELETE /v1/deployments/7e709a0d8efd/tags/match-1':
        return send(204);
      case 'POST /v1/deployments/7e709a0d8efd:report':
        return send(200, {});
      case 'GET /v1/app/cleanup-game/versions':
        return send(200, { versions: [{ name: 'old-1' }, { name: 'old-2' }], total_count: 2 });
      case 'DELETE /v1/app/cleanup-game/version/old-1':
        return send(200, { success: true, message: 'deleted' });
      case 'DELETE /v1/app/cleanup-game':
        return send(200, {});
      case 'GET /v1/storage/endpoints':
        return send(200, { endpoints: [{ name: 'game-logs', endpoint: 'https://s3.us-east-1.amazonaws.com', bucket: 'my-logs', access_key_id: 'AKIAEXAMPLE', output_format: 'TEXT', container_log_version: 'v1' }], total_count: 1 });
      case 'GET /v1/storage/endpoint/game-logs/pull-profiles':
        return send(200, { pull_profiles: [{ name: 'maps', source: 'maps/', source_type: 'Folder', destination: '/data/maps' }], total_count: 1 });
      case 'POST /v1/storage/endpoint': {
        const b = JSON.parse(body);
        return send(200, { name: b.name, endpoint: b.endpoint, bucket: b.bucket, access_key_id: b.access_key_id, output_format: 'TEXT', container_log_version: 'v1' });
      }
      case 'POST /v1/storage/endpoint/game-logs/pull-profile':
        return send(200, JSON.parse(body));
      case 'PUT /v1/storage/endpoint/game-logs/pull-profile/maps/app/my-game/version/build-42':
      case 'DELETE /v1/storage/endpoint/game-logs/pull-profile/maps/app/my-game/version/build-42':
        return send(200, { app: 'my-game', app_version: 'build-42', endpoint: 'game-logs', pull_profile: 'maps' });
      // --- API coverage tools (0.7.0). Shapes from spec/edgegap-v1-openapi.json.
      case 'PATCH /v1/app/my-game':
        return send(200, { name: 'my-game', is_active: JSON.parse(body).is_active });
      case 'PATCH /v1/app/my-game/version/build-42':
        return send(200, { success: true, version: { name: 'build-42' } });
      // A successful response that echoes the caller's token back.
      case 'GET /v1/app/my-game/version/echo-1':
        return send(200, { name: 'echo-1', docker_repository: 'docker.io', docker_image: `me/srv-${req.headers.authorization?.replace(/^token /, '')}`, docker_tag: 'b1', max_duration: 60 });
      case 'GET /v1/app/my-game/version/full-1':
        return send(200, {
          name: 'full-1', is_active: true, docker_repository: 'registry.edgegap.com', docker_image: 'my-org-abc123/my-game-server',
          docker_tag: 'build-42', req_cpu: 512, req_memory: 1024, max_duration: 60, force_cache: true, caching_percent: 100,
          verify_image: false, restart_policy: 'Never', termination_grace_period_seconds: 5, time_to_deploy: 15, endpoint_storage: 'game-logs',
          private_username: 'robot$pull', private_token: 'registry-secret-do-not-leak',
          ports: [{ port: 7777, protocol: 'UDP', name: 'gameport', tls_upgrade: false }],
          envs: [{ key: 'GAME_MODE', value: 'env-value-do-not-leak', is_hidden: false }, { key: 'API_KEY', value: 'x', is_hidden: true }],
        });
      case 'GET /v1/locations': {
        const q = new URL(req.url, 'http://x').searchParams;
        const all = [
          { city: 'Montreal', country: 'Canada', continent: 'North America', administrative_division: 'Quebec', latitude: 45.5, longitude: -73.6 },
          { city: 'Frankfurt', country: 'Germany', continent: 'Europe', administrative_division: '', latitude: 50.1, longitude: 8.7 },
        ];
        const rows = q.get('app') ? all.slice(0, 1) : all;
        return send(200, { locations: rows, messages: [], total_count: rows.length, pagination: { number: 1, has_next: false } });
      }
      case 'GET /v1/locations/beacons':
        return send(200, { locations: [{ host: '1.2.3.4', fqdn: 'beacon-mtl.edgegap.net', udp_port: 5000, tcp_port: 5001, location: { city: 'Montreal', country: 'Canada', continent: 'North America' } }], count: 1 });
      case 'GET /v1/metrics/deployment/7e709a0d8efd':
        return send(200, {
          cpu: { labels: ['cpu %'], datasets: [10, 30, 20], timestamps: ['t0', 't1', 't2'] },
          mem: { labels: ['MB'], datasets: [200, 400, 300], timestamps: ['t0', 't1', 't2'] },
          network: { receive: { labels: ['B/s'], datasets: [1, 2], timestamps: ['t0', 't1'] }, transmit: { datasets: [] } },
          total: { receive_total: { datasets: [5, 9] } },
        });
      case 'DELETE /v1/container-registry/images/my-game-server/tags/build-41':
        return send(200, { deleted_tag: 'build-41', artifact: { artifact_deleted: true, size_mb: 512, remaining_tags: [], image_hash: 'sha256:abc' } });
      case 'DELETE /v1/container-registry/images/my-org-abc123/my-game-server/tags/build-41':
        return send(404, { message: 'not found' });
      case 'GET /v1/relays/sessions':
        if (relayForbidden) return send(403, { message: 'You are not authorized to access this resource.' });
        return send(200, { sessions: [{ session_id: 'abc123-S', authorization_token: 111, status: 'Linked', ready: true, linked: true, session_users: [{ ip_address: '203.0.113.1', authorization_token: 901 }], relay: { host: 'cc84b011777b.pr.edgegap.net' } }], total_count: 1 });
      case 'POST /v1/relays/sessions:revoke-user':
        return send(200, { session_id: 'abc123-S', authorization_token: 111, status: 'Linked', ready: true, linked: true, session_users: [], relay: { host: 'cc84b011777b.pr.edgegap.net' } });
      default:
        return send(500, { message: `mock has no route for ${route}` });
    }
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${mock.address().port}`;

async function connect(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: 'node', args: ['dist/index.js'],
    env: { PATH: process.env.PATH, EDGEGAP_API_TOKEN: 'fake-api-token', EDGEGAP_BASE_URL: base, ...extraEnv },
    stderr: 'ignore',
  });
  const c = new Client({ name: 'newtools', version: '1.0.0' });
  await c.connect(transport);
  return c;
}
const text = (r) => r.content.map((x) => x.text).join('\n');
// Every result starts with a "[api host]" line; the payload follows it.
const isHostLine = (x, i) => i === 0 && /^\[[^\]]+\]$/.test(x.text);
const json = (r) => JSON.parse(r.content.filter((x, i) => !isHostLine(x, i))[0].text);

const c = await connect();

// ------------------------------------------------------------ validator ----
console.log('\nvalidate_server_config');
const goodUnity = `FROM ubuntu:22.04
COPY Builds/EdgegapServer /root/build/
RUN chmod +x /root/build/ServerBuild
EXPOSE 7777/udp
CMD ["/bin/bash", "-c", "/root/build/ServerBuild -batchmode -nographics"]`;
let r = json(await c.callTool({ name: 'edgegap_validate_server_config', arguments: {
  dockerfile: goodUnity, netcode: 'mirror-kcp', ports: [{ port: 7777, protocol: 'UDP' }], cpu_units: 1024, memory_mb: 2048, docker_tag: 'build-42' } }));
check('known-good Unity config passes', r.verdict === 'pass', JSON.stringify([...r.errors, ...r.warnings].map((f) => f.code)));
check('engine detected as unity', r.engine === 'unity');

const badUnreal = `FROM --platform=linux/arm64 ubuntu
COPY . /app
EXPOSE 7777/udp 22
CMD ./StartServer.sh -ip=127.0.0.1`;
r = json(await c.callTool({ name: 'edgegap_validate_server_config', arguments: {
  dockerfile: badUnreal, ports: [{ port: 7777, protocol: 'TCP' }, { port: 7778, protocol: 'QUIC' }], docker_tag: 'latest', cpu_units: 512, memory_mb: 4096 } }));
const codes = [...r.errors, ...r.warnings].map((f) => f.code);
check('bad Unreal config fails', r.verdict === 'fail');
for (const code of ['wrong-platform', 'unreal-root', 'crlf-script', 'loopback-bind', 'ssh-exposed', 'unpinned-base', 'protocol-mismatch', 'bad-protocol', 'latest-tag', 'memory-ratio']) {
  check(`flags ${code}`, codes.includes(code), codes.join(','));
}
check('returns reference Unreal Dockerfile on failure', /USER server/.test(r.reference_dockerfile ?? ''));
r = json(await c.callTool({ name: 'edgegap_validate_server_config', arguments: { docker_repository: 'docker.io', docker_image: 'docker.io/me/srv:v1', docker_tag: 'v1' } }));
check('image reference with host and tag in docker_image is an error', r.errors.some((f) => f.code === 'image-reference'));
r = json(await c.callTool({ name: 'edgegap_validate_server_config', arguments: { docker_tag: 'Latest' } }));
check('"Latest" in any case is flagged', r.errors.some((f) => f.code === 'latest-tag'));

r = json(await c.callTool({ name: 'edgegap_validate_server_config', arguments: { netcode: 'mirror-kcp', ports: [{ port: 7777, protocol: 'TCP' }] } }));
check('netcode/protocol mismatch is an error', r.errors.some((f) => f.code === 'netcode-protocol'));

r = json(await c.callTool({ name: 'edgegap_validate_server_config', arguments: { engine: 'unity' } }));
check('no Dockerfile + engine returns the reference template', /-batchmode -nographics/.test(r.reference_dockerfile ?? ''));

r = json(await c.callTool({ name: 'edgegap_validate_server_config', arguments: { docker_repository: 'registry.edgegap.com', docker_image: 'my-game-server', docker_tag: 'b1' } }));
check('registry.edgegap.com image without project is an error', r.errors.some((f) => f.code === 'missing-project'));

r = json(await c.callTool({ name: 'edgegap_validate_server_config', arguments: {
  dockerfile: 'FROM ubuntu:22.04\nCOPY build/Server.exe /app/\nCMD ["/app/Server.exe"]' } }));
check('Windows .exe build is an error', r.errors.some((f) => f.code === 'windows-binary'));

// ------------------------------------------------------ generate_dockerfile ----
console.log('\ngenerate_dockerfile');
const gen = async (args) => c.callTool({ name: 'edgegap_generate_dockerfile', arguments: args });
const validate = async (args) => json(await c.callTool({ name: 'edgegap_validate_server_config', arguments: args }));

// The core guarantee: whatever the generator writes, the validator accepts.
const genCases = [
  ['unity defaults', { engine: 'unity' }],
  ['unreal defaults', { engine: 'unreal' }],
  ['godot defaults', { engine: 'godot' }],
  ['unity custom build', { engine: 'unity', build_path: 'Build/Linux', executable: 'MyGame.x86_64', ports: [{ port: 7770, protocol: 'UDP' }], netcode: 'fishnet-tugboat', launch_args: ['-logfile', '/dev/stdout'] }],
  ['unreal packaged binary script', { engine: 'unreal', executable: 'MyGameServer.sh', launch_args: ['-log', '-port=7777'] }],
  ['other engine, TCP/UDP + WS ports', { engine: 'other', executable: 'server', ports: [{ port: 9000, protocol: 'TCP/UDP' }, { port: 9001, protocol: 'WS', name: 'web' }] }],
];
for (const [label, args] of genCases) {
  const res = await gen(args);
  if (res.isError) { check(`${label}: generated`, false, text(res)); continue; }
  const g = json(res);
  const v = await validate({ dockerfile: g.dockerfile, engine: args.engine, netcode: args.netcode, ports: g.ports_for_create_app_version });
  check(`${label}: passes the validator with no errors or warnings`, v.verdict === 'pass', JSON.stringify([...v.errors, ...v.warnings].map((f) => f.code)));
}

let g = json(await gen({ engine: 'unity', build_path: 'Build/Linux', executable: 'MyGame.x86_64', ports: [{ port: 7770, protocol: 'UDP' }], launch_args: ['-logfile', '/dev/stdout'] }));
check('unity: copies the given build folder', g.dockerfile.includes('COPY Build/Linux /root/build/'));
check('unity: launches the given binary headless with the extra args', g.dockerfile.includes('/root/build/MyGame.x86_64 -batchmode -nographics -logfile /dev/stdout'));
check('unity: does not dump env vars into logs', !g.dockerfile.includes('env;'));
check('unity: EXPOSE matches the port', g.dockerfile.includes('EXPOSE 7770/udp'));
check('nothing assumed when everything is given', !g.assumptions.some((a) => /Assumed/.test(a)), JSON.stringify(g.assumptions));
check('returns ports for create_app_version', JSON.stringify(g.ports_for_create_app_version) === JSON.stringify([{ port: 7770, protocol: 'UDP', name: 'gameport' }]));
check('local test command maps the UDP port', g.commands.test_locally.includes('-p 7770:7770/udp'));
check('--platform is on build, not on run', /--platform linux\/amd64/.test(g.commands.build) && !g.commands.test_locally.includes('--platform'));

g = json(await gen({ engine: 'unity' }));
check('defaults are listed as assumptions to confirm', g.assumptions.some((a) => /ServerBuild/.test(a)) && g.assumptions.some((a) => /7777/.test(a)));
g = json(await gen({ engine: 'unity', netcode: 'mirror-telepathy' }));
check('netcode picks the protocol (Telepathy -> TCP)', g.ports_for_create_app_version[0].protocol === 'TCP' && g.dockerfile.includes('EXPOSE 7777/tcp'));
g = json(await gen({ engine: 'unreal' }));
check('unreal: non-root user and CRLF fix', g.dockerfile.includes('USER server') && g.dockerfile.includes("sed -i 's/\\r$//' /app/StartServer.sh"));
g = json(await gen({ engine: 'godot', executable: 'game.x86_64' }));
check('godot: --headless in exec form', g.dockerfile.includes('CMD ["/app/game.x86_64","--headless"]'));
g = json(await gen({ engine: 'other', executable: 'srv', ports: [{ port: 9000, protocol: 'TCP/UDP' }] }));
check('TCP/UDP exposes both', g.dockerfile.includes('EXPOSE 9000/udp') && g.dockerfile.includes('EXPOSE 9000/tcp'));

let gr = await gen({ engine: 'other' });
check('other engine requires executable', gr.isError && /executable is required/.test(text(gr)));
gr = await gen({ engine: 'unity', launch_args: ['-port 7777; rm -rf /'] });
check('rejects shell metacharacters in launch args', gr.isError === true);
gr = await gen({ engine: 'unity', build_path: '../secrets' });
check('rejects build paths outside the build context', gr.isError === true);
gr = await gen({ engine: 'unity', executable: 'Server"\nRUN curl evil' });
check('rejects executable names that would inject Dockerfile lines', gr.isError === true);

// ---------------------------------------------------- server vs relay guidance ----
console.log('\nserver vs relay guidance');
const instructions = c.getInstructions() ?? '';
check('instructions recommend a dedicated server by default', /recommend a dedicated server by default/i.test(instructions));
check('instructions say a relay is not a game server', /Relay .*NOT a game server/s.test(instructions));
check('instructions start the golden path with generate_dockerfile', instructions.includes('1. edgegap_generate_dockerfile'));
const listed = (await c.listTools()).tools;
const desc = (n) => listed.find((t) => t.name === n)?.description ?? '';
check('relay tool leads with "NOT a game server"', /^A relay is NOT a game server/.test(desc('edgegap_create_relay_session')));
check('relay tool points to edgegap_deploy instead', /edgegap_deploy/.test(desc('edgegap_create_relay_session')));
check('deploy tool says it is the recommended authoritative server', /authoritative dedicated game server/.test(desc('edgegap_deploy')) && /recommended/.test(desc('edgegap_deploy')));

// ------------------------------------------------------------- registry ----
console.log('\nregistry');
// A regular API token: what almost every developer has.
calls.length = 0;
let res = await c.callTool({ name: 'edgegap_get_registry_credentials', arguments: { image_name: 'my-game-server', tag: 'build-42' } });
let t = text(res);
check('regular token: manual steps, not an error and not credentials', !res.isError && res.structuredContent?.status === 'manual_steps_required' && res.structuredContent?.credentials_returned === false && !res.structuredContent?.token);
check('regular token: says why (quick-start only) and not to retry', /quick-start token/.test(t) && /Do not retry/.test(t));
check('regular token: does not attempt provisioning', !calls.some((x) => x.url === '/v1/wizard/init-quick-start'));
check('regular token: points to the dashboard Container Registry page', /Container Registry page/.test(t));
check('regular token: gives the push commands for this image and tag', t.includes('registry.edgegap.com/<project>/my-game-server:build-42') && /--password-stdin/.test(t));
check('regular token: offers other registries', /Docker Hub/.test(t) && /registry_username/.test(t));
check('regular token: no misleading Edgegap API error text', !/Edgegap API 403/.test(t));

// The plugins' quick-start token, project not provisioned yet.
tokenType = 'quickstart';
calls.length = 0;
res = await c.callTool({ name: 'edgegap_get_registry_credentials', arguments: { image_name: 'my-game-server', tag: 'build-42' } });
r = json(res);
check('quick-start token: provisions via init-quick-start when credentials 404', calls.some((x) => x.url === '/v1/wizard/init-quick-start' && x.body?.source === 'mcp'));
check('returns project/username/token', r.project === 'my-org-abc123' && r.username === 'robot$my-org' && r.token === 'reg-token-xyz');
check('image ref includes project and tag', r.image_ref === 'registry.edgegap.com/my-org-abc123/my-game-server:build-42');
check('login uses --password-stdin, token not on the command line', /--password-stdin/.test(r.commands.login) && !r.commands.login.includes('reg-token-xyz'));
check('build targets linux/amd64', /--platform linux\/amd64/.test(r.commands.build));
check('API token sent as "token <value>"', calls.every((x) => x.auth === 'token fake-api-token'));
check('API token never in output', !text(res).includes('fake-api-token'));
res = await c.callTool({ name: 'edgegap_get_registry_credentials', arguments: { tag: 'latest' } });
check('rejects the "latest" tag', res.isError === true);
res = await c.callTool({ name: 'edgegap_get_registry_credentials', arguments: { tag: ' LATEST ' } });
check('rejects "latest" in any case or padding', res.isError === true && /Refused/.test(text(res)));

check('next step tells the agent to list tags by image name only', /image_name "my-game-server", without the project/.test(r.next_step));
tokenType = 'regular';

const tagCalls = () => calls.filter((x) => x.url.startsWith('/v1/container-registry/')).map((x) => new URL(x.url, 'http://x').pathname);
calls.length = 0;
r = json(await c.callTool({ name: 'edgegap_list_registry_tags', arguments: { image_name: 'my-game-server' } }));
check('image name only: lists pushed tags', r.tags?.[0]?.tag === 'build-42' && r.tags[0].size_mb === 512 && r.total === 1);
check('image name only: one request, image name in the path', JSON.stringify(tagCalls()) === JSON.stringify(['/v1/container-registry/images/my-game-server/tags']), JSON.stringify(tagCalls()));
check('image name only: no note', r.note === undefined && r.truncated === undefined);

calls.length = 0;
r = json(await c.callTool({ name: 'edgegap_list_registry_tags', arguments: { image_name: 'my-org-abc123/my-game-server' } }));
check('"<project>/<image>": project stripped after the 404, tags found', r.tags?.[0]?.tag === 'build-42' && r.image_name === 'my-game-server');
check('"<project>/<image>": tells the agent to drop the project next time', /image name only/.test(r.note ?? ''));

r = json(await c.callTool({ name: 'edgegap_list_registry_tags', arguments: { image_name: 'registry.edgegap.com/my-org-abc123/my-game-server:build-42' } }));
check('full image reference: host, project and tag stripped', r.tags?.[0]?.tag === 'build-42' && r.image_name === 'my-game-server');

calls.length = 0;
r = json(await c.callTool({ name: 'edgegap_list_registry_tags', arguments: { image_name: 'team/nested-server' } }));
check('nested image name: kept whole, found first try', r.tags?.[0]?.tag === 'n-1' && tagCalls().length === 1);

r = json(await c.callTool({ name: 'edgegap_list_registry_tags', arguments: { image_name: 'big-server' } }));
check('more pages: marked truncated with a next step', r.truncated === true && r.total === 40 && /page: 2/.test(r.next_step ?? ''));

res = await c.callTool({ name: 'edgegap_list_registry_tags', arguments: { image_name: 'never-pushed' } });
r = json(res);
check('never-pushed image: a not_found state with a next step, not an error', !res.isError && r.status === 'not_found' && r.tags?.length === 0 && /Nothing has been pushed as "never-pushed"/.test(r.next_step) && /Docker Hub/.test(r.next_step), text(res).slice(0, 200));
check('unknown image: does not point the agent at applications', !/edgegap_list_apps/.test(text(res)));

// ---------------------------------------------------------- deployments ----
console.log('\nlist_deployments');
const deploymentQuery = () => {
  const call = calls.findLast((x) => x.url.startsWith('/v1/deployments'));
  const q = new URL(call.url, 'http://x').searchParams.get('query');
  return q === null ? null : JSON.parse(q);
};
calls.length = 0;
r = json(await c.callTool({ name: 'edgegap_list_deployments', arguments: {} }));
check('no filters sends no query', deploymentQuery() === null && r.deployments?.[0]?.request_id === '7e709a0d8efd');
await c.callTool({ name: 'edgegap_list_deployments', arguments: {
  filters: [{ field: 'application', operator: 'eq', value: 'my-game' }, { field: 'tags', operator: 'in', value: ['ci', 'test'] }],
  order_by: [{ field: 'created_at', order: 'asc' }] } });
check('filters and order_by sent as the documented JSON query', JSON.stringify(deploymentQuery()) === JSON.stringify({
  filters: [{ field: 'application', operator: 'eq', value: 'my-game' }, { field: 'tags', operator: 'in', value: ['ci', 'test'] }],
  order_by: [{ field: 'created_at', order: 'asc' }] }), JSON.stringify(deploymentQuery()));
calls.length = 0;
res = await c.callTool({ name: 'edgegap_list_deployments', arguments: {
  filters: [{ field: 'status', operator: 'eq', value: 'ready' }, { field: 'status', operator: 'neq', value: 'error' }] } });
check('two filters on one field are refused locally', res.isError === true && calls.length === 0);

// --------------------------------------------------------------- relays ----
console.log('\nrelays');
calls.length = 0;
res = await c.callTool({ name: 'edgegap_create_relay_session', arguments: { user_ips: ['203.0.113.1', '198.51.100.7'] } });
r = json(res);
const createCall = calls.find((x) => x.method === 'POST' && x.url === '/v1/relays/sessions');
check('sends users as [{ip}]', JSON.stringify(createCall?.body) === JSON.stringify({ users: [{ ip: '203.0.113.1' }, { ip: '198.51.100.7' }] }), JSON.stringify(createCall?.body));
check('waits until ready', r.ready === true && relayPolls >= 2, `ready=${r.ready} polls=${relayPolls}`);
check('returns relay host and both ports', r.relay?.host === 'cc84b011777b.pr.edgegap.net' && r.relay.server_port?.port === 31527 && r.relay.client_port?.port === 32089);
check('returns per-player authorization tokens', r.users?.length === 2 && r.users[0].authorization_token === 901);
check('returns session authorization token', r.session_authorization_token === 111);
check('relay result says it is not a game server and recommends one', /relay, not a game server/.test(r.architecture_note ?? '') && /recommend a dedicated server/.test(r.architecture_note ?? ''));

r = json(await c.callTool({ name: 'edgegap_authorize_relay_user', arguments: { session_id: 'abc123-S', user_ip: '192.0.2.9' } }));
check('authorize returns the new player token', r.user_authorization_token === 903);
r = json(await c.callTool({ name: 'edgegap_get_relay_session', arguments: { session_id: 'abc123-S' } }));
check('get returns the session', r.session_id === 'abc123-S' && r.ready === true);
res = await c.callTool({ name: 'edgegap_delete_relay_session', arguments: { session_id: 'abc123-S' } });
check('delete succeeds on 204', !res.isError && calls.some((x) => x.method === 'DELETE' && x.url === '/v1/relays/sessions/abc123-S'));

// ----------------------------------------------------------- matchmaker ----
console.log('\nmatchmaker');
const mm = { profile_name: 'casual-2v2', application: 'my-game', version: 'build-42', team_count: 2, min_team_size: 2, max_team_size: 2 };
r = json(await c.callTool({ name: 'edgegap_build_matchmaker_config', arguments: { ...mm, max_latency_ms: 150, expansions: [{ after_seconds: 20, max_latency_ms: 250 }] } }));
const prof = r.config?.profiles?.['casual-2v2'];
check('builds a profile pointing at the version', prof?.application?.name === 'my-game' && prof.application.version === 'build-42');
check('player_count rule', prof?.rules.initial.match_size.type === 'player_count' && prof.rules.initial.match_size.attributes.team_count === 2);
check('latency rule and expansion', prof?.rules.initial.beacons.attributes.max_latency === 150 && prof.rules.expansions['20'].beacons.max_latency === 250);
check('ticket expiration defaults to 30s', prof?.ticket_expiration_period === '30s', prof?.ticket_expiration_period);
check('30s expiration raises no caution', !(r.cautions ?? []).some((s) => /is short/.test(s)), JSON.stringify(r.cautions));
r = json(await c.callTool({ name: 'edgegap_build_matchmaker_config', arguments: { ...mm, min_team_size: 2, verify_version: false, expansions: [{ after_seconds: 30, min_team_size: 1 }] } }));
check('expansion at or after the expiration is flagged', (r.cautions ?? []).some((s) => /never applies/.test(s)), JSON.stringify(r.cautions));
r = json(await c.callTool({ name: 'edgegap_build_matchmaker_config', arguments: { ...mm, verify_version: false, ticket_expiration: '10s' } }));
check('expiration under 20s is flagged as short', (r.cautions ?? []).some((s) => /is short/.test(s)), JSON.stringify(r.cautions));
res = await c.callTool({ name: 'edgegap_build_matchmaker_config', arguments: { ...mm, version: 'nope' } });
check('missing version is reported', res.isError && /not found/.test(text(res)));
res = await c.callTool({ name: 'edgegap_build_matchmaker_config', arguments: { ...mm, version: 'no-ports' } });
check('version without ports is reported', res.isError && /no ports/.test(text(res)));
res = await c.callTool({ name: 'edgegap_build_matchmaker_config', arguments: { ...mm, application: 'ghost-game' } });
check('missing application is reported', res.isError && /does not exist/.test(text(res)));
res = await c.callTool({ name: 'edgegap_build_matchmaker_config', arguments: { ...mm, min_team_size: 3, verify_version: false } });
check('min > max team size is reported', res.isError && /greater than max_team_size/.test(text(res)));

r = json(await c.callTool({ name: 'edgegap_build_matchmaker_config', arguments: { ...mm, allowed_cors_origins: ['https://mygame.example.com', 'http://localhost:8080'] } }));
check('allowed_cors_origins lands in the config', JSON.stringify(r.config?.allowed_cors_origins) === JSON.stringify(['https://mygame.example.com', 'http://localhost:8080']));
check('allowed origins are repeated in next_steps', r.next_steps?.some((s) => s.includes('http://localhost:8080')));
r = json(await c.callTool({ name: 'edgegap_build_matchmaker_config', arguments: mm }));
{
  const steps = r.next_steps?.join(' ') ?? '';
  const ticketStep = r.next_steps?.find((s) => s.includes('POST {api_url}/tickets')) ?? '';
  check('next_steps: poll GET /tickets/{id} after POST /tickets, not /memberships', /GET \{api_url\}\/tickets\/\{id\}/.test(ticketStep) && !/memberships/.test(ticketStep), ticketStep);
  check('next_steps: ticket statuses and assignment fields', /SEARCHING/.test(ticketStep) && /HOST_ASSIGNED/.test(ticketStep) && /assignment\.fqdn/.test(ticketStep) && /assignment\.ports\.gameport\.external/.test(ticketStep));
  check('next_steps: groups named as the party alternative', /POST \{api_url\}\/groups/.test(steps));
}
check('no origins: key left out, WebGL reminder in next_steps', r.config?.allowed_cors_origins === undefined && r.next_steps?.some((s) => /WebGL/.test(s) && /allowed_cors_origins/.test(s)));
res = await c.callTool({ name: 'edgegap_build_matchmaker_config', arguments: { ...mm, allowed_cors_origins: ['https://mygame.example.com/play/'] } });
check('an origin with a path is refused', res.isError && /not an origin/.test(text(res)));

// ------------------------------------------------- app versions (e2e feedback) ----
console.log('\napp versions');
const ver = { application: 'my-game', name: 'v-new', docker_repository: 'registry.edgegap.com', docker_image: 'my-org-abc123/my-game-server', docker_tag: 'build-42', cpu_units: 512, memory_mb: 1024 };
calls.length = 0;
r = json(await c.callTool({ name: 'edgegap_create_app_version', arguments: { ...ver, ports: [{ port: 7778, protocol: 'WS', tls_upgrade: true }] } }));
let sent = calls.find((x) => x.method === 'POST')?.body;
check('tls_upgrade is sent on the port', sent?.ports?.[0]?.tls_upgrade === true, JSON.stringify(sent?.ports));
check('no registry login on registry.edgegap.com: warned the pull will fail', r.notes?.some((n) => /registry login/.test(n) && /424/.test(n)));
calls.length = 0;
r = json(await c.callTool({ name: 'edgegap_create_app_version', arguments: { ...ver, ports: [{ port: 7777, protocol: 'UDP' }] } }));
check('tls_upgrade defaults to false', calls.find((x) => x.method === 'POST')?.body?.ports?.[0]?.tls_upgrade === false);
r = json(await c.callTool({ name: 'edgegap_create_app_version', arguments: { ...ver, ports: [{ port: 7778, protocol: 'WS' }] } }));
check('WS port without TLS: suggests tls_upgrade for WebGL', r.notes?.some((n) => /tls_upgrade: true/.test(n) && /WebGL/.test(n)));
res = await c.callTool({ name: 'edgegap_create_app_version', arguments: { ...ver, ports: [{ port: 7777, protocol: 'UDP', tls_upgrade: true }] } });
check('tls_upgrade on a UDP port is refused locally', res.isError && /only works on WS and HTTP/.test(text(res)));

res = await c.callTool({ name: 'edgegap_create_app_version', arguments: { ...ver, verify_image: true, ports: [{ port: 7777, protocol: 'UDP' }] } });
t = text(res);
check('verify_image without a login: explained, not the raw 400', res.isError && /not your API token/.test(t) && /registry\.edgegap\.com project too/.test(t));
check('verify_image without a login: offers the dashboard route first', /1\. Create the version again with verify_image false/.test(t) && /dashboard/.test(t));

r = json(await c.callTool({ name: 'edgegap_list_app_versions', arguments: { application: 'my-game' } }));
const byName = Object.fromEntries((r.versions ?? []).map((v) => [v.name, v]));
check('versions show whether a registry login is set', byName['build-42']?.registry_credentials_set === true && byName['web-1']?.registry_credentials_set === false);
check('versions show tls_upgrade per port', byName['web-1']?.ports?.[0]?.tls_upgrade === true && byName['build-42']?.ports?.[0]?.tls_upgrade === false);
check('the registry token from the API never reaches the agent', !JSON.stringify(r).includes('registry-secret-do-not-leak'));

// ------------------------------------------------------------- 404 hints ----
console.log('\n404 hints');
res = await c.callTool({ name: 'edgegap_get_deployment_logs', arguments: { request_id: 'gone-deployment' } });
t = text(res);
check('logs of a deployment Edgegap does not know: an error naming the request_id', res.isError && /No deployment with request_id "gone-deployment"/.test(t) && /edgegap_list_deployments/.test(t), t.slice(0, 200));
check('logs 404: does not point at applications', !/edgegap_list_apps/.test(t));
res = await c.callTool({ name: 'edgegap_get_deployment_logs', arguments: { request_id: 'stoppeddep01' } });
r = json(res);
check('logs of a stopped deployment: an "expired" state that explains Endpoint Storage', !res.isError && r.status === 'expired' && /Endpoint/.test(r.next_step) && r.deployment_status === 'Status.TERMINATED', text(res).slice(0, 200));
res = await c.callTool({ name: 'edgegap_get_deployment_logs', arguments: { request_id: 'slowdep00001' } });
r = json(res);
check('logs of a starting deployment: a "not_ready" state pointing at wait_for_deployment', !res.isError && r.status === 'not_ready' && /edgegap_wait_for_deployment/.test(r.next_step), text(res).slice(0, 200));
res = await c.callTool({ name: 'edgegap_get_deployment_logs', arguments: { request_id: 'faileddep001', max_characters: 20 } });
r = json(res);
check('logs: an out-of-range max_characters is clamped, not refused', !res.isError && /Segmentation fault/.test(r.logs ?? ''), text(res).slice(0, 200));
res = await c.callTool({ name: 'edgegap_get_deployment', arguments: { request_id: 'gone-deployment' } });
check('deployment 404: points at edgegap_list_deployments, not apps', /edgegap_list_deployments/.test(text(res)) && !/edgegap_list_apps/.test(text(res)));
res = await c.callTool({ name: 'edgegap_list_app_versions', arguments: { application: 'ghost-game' } });
check('app 404: still points at edgegap_list_apps', /edgegap_list_apps/.test(text(res)));
res = await c.callTool({ name: 'edgegap_get_deployment', arguments: { request_id: 'unknown-id' } });
check('unknown request_id (400): explained as a bad or expired request_id', /no deployment with that request_id/.test(text(res)));
res = await c.callTool({ name: 'edgegap_get_deployment_logs', arguments: { request_id: 'unknown-id' } });
check('logs for an unknown request_id (400): told apart from a stopped one', res.isError && /No deployment with request_id "unknown-id"/.test(text(res)));

// ------------------------------------------------- PostHog error review ----
console.log('\nerrors that are not failures, and failures that explain themselves');
res = await c.callTool({ name: 'edgegap_wait_for_deployment', arguments: { request_id: 'faileddep001' } });
t = text(res);
check('wait on a failed deployment: an error', res.isError === true);
check('wait on a failed deployment: includes the log tail', /Segmentation fault in ServerMain/.test(t) && /exited with code 139/.test(t), t.slice(0, 300));
res = await c.callTool({ name: 'edgegap_wait_for_deployment', arguments: { request_id: 'slowdep00001', timeout_seconds: 5 } });
r = json(res);
check('wait timeout: not an error, ready false, says to wait again', !res.isError && r.ready === false && /wait_for_deployment again/.test(r.next_step), text(res).slice(0, 200));
res = await c.callTool({ name: 'edgegap_stop_deployment', arguments: { request_id: 'stoppeddep01' } });
r = json(res);
check('stop an already-terminated deployment: success, already_stopped', !res.isError && r.result === 'already_stopped', text(res).slice(0, 200));
res = await c.callTool({ name: 'edgegap_stop_deployment', arguments: { request_id: 'gonedeploy01' } });
r = json(res);
check('stop a deployment Edgegap no longer knows: success, not_running, does not claim it stopped it', !res.isError && r.result === 'not_running' && /request_id is wrong/.test(r.note), text(res).slice(0, 200));
relayForbidden = true;
res = await c.callTool({ name: 'edgegap_list_relay_sessions', arguments: {} });
t = text(res);
r = json(res);
check('relay list 403: a not_configured state, not a bad token', !res.isError && r.status === 'not_configured' && r.sessions?.length === 0 && /cannot use relays/.test(r.next_step), t.slice(0, 300));
relayForbidden = false;

// ------------------------------------------------- WebGL in the generator ----
console.log('\nWebGL / WebSocket ports');
r = json(await c.callTool({ name: 'edgegap_generate_dockerfile', arguments: { engine: 'unity', netcode: 'mirror-simpleweb', ports: [{ port: 7778, protocol: 'WS' }] } }));
check('WebSocket netcode: generator turns on tls_upgrade', r.ports_for_create_app_version?.[0]?.tls_upgrade === true);
check('WebSocket netcode: and says so as an assumption', r.assumptions?.some((a) => /tls_upgrade/.test(a)));
r = json(await c.callTool({ name: 'edgegap_generate_dockerfile', arguments: { engine: 'unity', netcode: 'mirror-simpleweb', ports: [{ port: 7778, protocol: 'WS', tls_upgrade: false }] } }));
check('an explicit tls_upgrade: false is kept', r.ports_for_create_app_version?.[0]?.tls_upgrade === false);
r = json(await c.callTool({ name: 'edgegap_generate_dockerfile', arguments: { engine: 'unity', netcode: 'mirror-kcp' } }));
check('UDP netcode: no tls_upgrade', r.ports_for_create_app_version?.[0]?.tls_upgrade === undefined);
r = json(await c.callTool({ name: 'edgegap_validate_server_config', arguments: { netcode: 'mirror-simpleweb', ports: [{ port: 7778, protocol: 'WS' }] } }));
check('validator: WebSocket netcode without TLS is a warning', r.warnings?.some((w) => w.code === 'ws-no-tls'));
r = json(await c.callTool({ name: 'edgegap_validate_server_config', arguments: { ports: [{ port: 7777, protocol: 'UDP', tls_upgrade: true }] } }));
check('validator: tls_upgrade on UDP is an error', r.errors?.some((e) => e.code === 'tls-wrong-protocol'));
await c.close();

// ------------------------------------------------------------ read-only ----
console.log('\nread-only mode');
const ro = await connect({ EDGEGAP_READ_ONLY: '1' });
const names = (await ro.listTools()).tools.map((t) => t.name);
for (const n of ['edgegap_get_registry_credentials', 'edgegap_create_relay_session', 'edgegap_authorize_relay_user', 'edgegap_delete_relay_session']) {
  check(`${n} hidden`, !names.includes(n));
}
for (const n of ['edgegap_generate_dockerfile', 'edgegap_validate_server_config', 'edgegap_list_registry_tags', 'edgegap_get_relay_session', 'edgegap_build_matchmaker_config']) {
  check(`${n} available`, names.includes(n));
}
await ro.close();

// ------------------------------------------------------------ allowlist ----
const al = await connect({ EDGEGAP_APP_ALLOWLIST: 'other-game' });
res = await al.callTool({ name: 'edgegap_build_matchmaker_config', arguments: mm });
check('matchmaker builder respects EDGEGAP_APP_ALLOWLIST', res.isError && /ALLOWLIST/.test(text(res)));
res = await al.callTool({ name: 'edgegap_create_app_version', arguments: { ...ver, ports: [{ port: 7777, protocol: 'UDP' }] } });
check('create_app_version respects EDGEGAP_APP_ALLOWLIST', res.isError && /ALLOWLIST/.test(text(res)));
res = await al.callTool({ name: 'edgegap_list_app_versions', arguments: { application: 'my-game' } });
check('reads are not blocked by the allowlist (list_app_versions)', !res.isError && json(res).versions?.length === 3, text(res).slice(0, 120));
await al.close();

// ================================================================ guardrails ====
// A UUID-shaped token, so the leak check (which ignores very short tokens) is live.
const REAL = '0f8b3c1e-e458-4592-b607-c2c28afd8b62';
const gc = await connect({ EDGEGAP_API_TOKEN: REAL });
const call = async (name, args) => gc.callTool({ name, arguments: args });
const sentCalls = () => calls.filter((x) => x.method !== 'GET' || /\/(stop|deployments)/.test(x.url));
const dep = { application: 'my-game', version: 'build-42', users: { ip_addresses: ['203.0.113.1'] } };

// ----------------------------------------------------------- 1. dry run ----
console.log('\n1. dry_run on every write tool');
const dryCases = [
  ['edgegap_deploy', dep, 'POST', '/v2/deployments'],
  ['edgegap_stop_deployment', { request_id: '7e709a0d8efd' }, 'DELETE', '/v1/stop/7e709a0d8efd'],
  ['edgegap_create_app', { name: 'my-game' }, 'POST', '/v1/app'],
  ['edgegap_create_app_version', { ...ver, ports: [{ port: 7777, protocol: 'UDP' }] }, 'POST', '/v1/app/my-game/version'],
  ['edgegap_create_relay_session', { user_ips: ['203.0.113.1'] }, 'POST', '/v1/relays/sessions'],
  ['edgegap_authorize_relay_user', { session_id: 'abc123-S', user_ip: '203.0.113.2' }, 'POST', '/v1/relays/sessions:authorize-user'],
  ['edgegap_delete_relay_session', { session_id: 'abc123-S' }, 'DELETE', '/v1/relays/sessions/abc123-S'],
  ['edgegap_update_app', { application: 'my-game', is_active: true }, 'PATCH', '/v1/app/my-game'],
  ['edgegap_update_app_version', { application: 'my-game', version: 'build-42', is_active: false }, 'PATCH', '/v1/app/my-game/version/build-42'],
  ['edgegap_delete_registry_tag', { image_name: 'my-game-server', tag: 'build-41' }, 'DELETE', '/v1/container-registry/images/my-game-server/tags/build-41'],
  ['edgegap_revoke_relay_user', { session_id: 'abc123-S', user_authorization_token: 901 }, 'POST', '/v1/relays/sessions:revoke-user'],
];
for (const [name, args, method, path] of dryCases) {
  calls.length = 0;
  const out = await call(name, { ...args, dry_run: true });
  const dd = json(out);
  const req = dd.requests?.[0];
  const writes = calls.filter((x) => x.method !== 'GET');
  check(`${name}: sends nothing`, writes.length === 0 && dd.sent === false, `${writes.length} writes`);
  check(`${name}: shows method, host and path`, req?.method === method && req.path === path && req.host === new URL(base).host, JSON.stringify(req));
  check(`${name}: token masked`, req?.headers?.Authorization === 'token ***' && !text(out).includes(REAL));
}
let dr = json(await call('edgegap_create_app_version', {
  ...ver, ports: [{ port: 7777, protocol: 'UDP' }], registry_username: 'robot', registry_token: 'reg-secret-xyz',
  env: [{ key: 'GAME_MODE', value: 'secret-env-value' }], dry_run: true,
}));
let shown = JSON.stringify(dr);
check('dry run masks the registry token and env values', !shown.includes('reg-secret-xyz') && !shown.includes('secret-env-value') && dr.requests[0].body.envs[0].value === '***');
check('dry run keeps env names visible', dr.requests[0].body.envs[0].key === 'GAME_MODE');
dr = json(await call('edgegap_deploy', { ...dep, tags: ['ci'], dry_run: true }));
check('dry run shows the forced tag in the body', JSON.stringify(dr.requests[0].body.tags) === JSON.stringify(['ci', 'edgegap-mcp']));

// ---------------------------------------------------- 2. token in container ----
console.log('\n2. token never goes into a container');
const leakCases = [
  ['deploy: env value', 'edgegap_deploy', { ...dep, env: [{ key: 'EDGEGAP_TOKEN', value: REAL }] }],
  ['deploy: env value with "token " prefix', 'edgegap_deploy', { ...dep, env: [{ key: 'X', value: `token ${REAL}` }] }],
  ['deploy: env name', 'edgegap_deploy', { ...dep, env: [{ key: `K_${REAL.replace(/-/g, '')}`, value: 'x' }] }],
  ['deploy: tag', 'edgegap_deploy', { ...dep, tags: [REAL] }],
  ['deploy: dry run too', 'edgegap_deploy', { ...dep, env: [{ key: 'T', value: REAL }], dry_run: true }],
  ['create_app_version: env value', 'edgegap_create_app_version', { ...ver, ports: [{ port: 7777, protocol: 'UDP' }], env: [{ key: 'T', value: REAL }] }],
  ['create_relay_session: webhook URL', 'edgegap_create_relay_session', { user_ips: ['203.0.113.1'], webhook_url: `https://hooks.example.com/?t=${REAL}` }],
];
for (const [label, name, args] of leakCases) {
  calls.length = 0;
  const out = await call(name, args);
  check(`${label}: refused, nothing sent, token not echoed`, out.isError && /Refused/.test(text(out)) && calls.length === 0 && !text(out).includes(REAL), text(out).slice(0, 120));
}

// ------------------------------------------------------- 3. forced tag ----
console.log('\n3. forced agent tag');
calls.length = 0;
await call('edgegap_deploy', { ...dep, tags: ['playtest'] });
check('caller tags kept, edgegap-mcp added', JSON.stringify(calls.find((x) => x.method === 'POST')?.body?.tags) === JSON.stringify(['playtest', 'edgegap-mcp']));
calls.length = 0;
await call('edgegap_deploy', dep);
check('no caller tags: edgegap-mcp alone (no more bare "mcp")', JSON.stringify(calls.find((x) => x.method === 'POST')?.body?.tags) === JSON.stringify(['edgegap-mcp']));
calls.length = 0;
await call('edgegap_deploy', { ...dep, tags: ['edgegap-mcp'] });
check('not duplicated when the caller passes it too', calls.find((x) => x.method === 'POST')?.body?.tags.length === 1);
calls.length = 0;
await call('edgegap_list_deployments', { only_agent_deployments: true });
const q = JSON.parse(new URL(calls[0].url, 'http://x').searchParams.get('query') ?? '{}');
check('only_agent_deployments filters tags in [edgegap-mcp, mcp]', JSON.stringify(q.filters) === JSON.stringify([{ field: 'tags', operator: 'in', value: ['edgegap-mcp', 'mcp'] }]), JSON.stringify(q));
res = await call('edgegap_list_deployments', { only_agent_deployments: true, filters: [{ field: 'tags', operator: 'eq', value: 'x' }] });
check('only_agent_deployments with a tags filter is refused', res.isError === true);

// -------------------------------------------------------- 4. auto-stop ----
console.log('\n4. auto-stop reported on every deploy');
r = json(await call('edgegap_deploy', dep));
check('60-minute version: reported, no warning', r.auto_stop_after_minutes === 60 && r.warning === undefined && r.request_id === '7e709a0d8efd');
calls.length = 0;
res = await call('edgegap_deploy', { ...dep, version: 'long-1' });
check('1440-minute version, above the 60-minute ceiling: refused, nothing deployed', res.isError && /allow_long_running/.test(text(res)) && !calls.some((x) => x.method === 'POST'), text(res).slice(0, 160));
res = await call('edgegap_deploy', { ...dep, version: 'forever' });
check('no max_duration: refused too', res.isError && /no time limit/.test(text(res)));
calls.length = 0;
res = await call('edgegap_deploy', { ...dep, version: 'long-1', dry_run: true });
check('dry run previews the long-running refusal, nothing deployed', res.isError && /allow_long_running/.test(text(res)) && !calls.some((x) => x.method === 'POST'), text(res).slice(0, 160));
res = await call('edgegap_deploy', { ...dep, version: 'latest-1', dry_run: true });
check('dry run previews the "latest" tag refusal', res.isError && /latest/.test(text(res)));
r = json(await call('edgegap_deploy', { ...dep, version: 'long-1', allow_long_running: true, dry_run: true }));
check('dry run with allow_long_running: request shown with its auto-stop', r.sent === false && r.notes?.some((n) => /1440 minutes/.test(n)), JSON.stringify(r.notes));
r = json(await call('edgegap_deploy', { ...dep, version: 'long-1', allow_long_running: true }));
check('1440-minute version with allow_long_running: deployed and warned', r.auto_stop_after_minutes === 1440 && /24 hours/.test(r.warning ?? '') && /allow_long_running/.test(r.long_running ?? ''));
r = json(await call('edgegap_deploy', { ...dep, version: 'forever', allow_long_running: true }));
check('no max_duration with allow_long_running: warned it bills until stopped', r.auto_stop === 'none' && /until it is stopped/.test(r.warning ?? ''));

// ------------------------------------------------------ 5. strict stop ----
console.log('\n5. strict stop');
for (const bad of ['', '*', '7e709a0d8efd,abcdef123456', '7e709a0d8efd abcdef123456', '["7e709a0d8efd"]', '7e709a0d8e*', 'all']) {
  calls.length = 0;
  res = await call('edgegap_stop_deployment', { request_id: bad });
  check(`stop "${bad}" refused, nothing sent`, res.isError && calls.length === 0 && /single request_id/.test(text(res)));
}
calls.length = 0;
res = await call('edgegap_stop_deployment', { request_id: '7e709a0d8efd' });
check('stop with one exact request_id goes through', !res.isError && calls.some((x) => x.method === 'DELETE' && x.url === '/v1/stop/7e709a0d8efd'));
for (const bad of ['*', 'abc123-S,def456-S', '']) {
  calls.length = 0;
  res = await call('edgegap_delete_relay_session', { session_id: bad });
  check(`relay delete "${bad}" refused`, res.isError && calls.length === 0);
}

// -------------------------------------------------------- 6. host label ----
console.log('\n6. host on every result');
const custom = `[custom · ${new URL(base).host}]`;
res = await call('edgegap_list_apps', {});
check('API results start with the host line', res.content[0].text === custom, res.content[0].text);
res = await call('edgegap_generate_dockerfile', { engine: 'unity' });
check('local-only tools carry it too', res.content[0].text === custom);
res = await call('edgegap_stop_deployment', { request_id: '*' });
check('errors carry it too', res.isError && res.content[0].text === custom);

// --------------------------------------------------------- 7. context ----
console.log('\n7. edgegap_context');
calls.length = 0;
r = json(await call('edgegap_context', {}));
check('no API call', calls.length === 0);
check('reports version, transport and host', /^@edgegap\/mcp \d+\.\d+\.\d+$/.test(r.server) && r.transport === 'local (stdio)' && r.api_host === custom.slice(1, -1));
check('reports guardrails', r.forced_deploy_tag === 'edgegap-mcp' && r.read_only === false && r.max_duration_ceiling_minutes === 60 && /deploy/.test(r.guardrails?.dry_run ?? ''));
check('token source shown, never the token', r.token === 'from EDGEGAP_API_TOKEN' && !JSON.stringify(r).includes(REAL));

// ------------------------------------------------------ 19. User-Agent ----
console.log('\n19. User-Agent');
calls.length = 0;
await call('edgegap_list_apps', {});
check('User-Agent is edgegap-mcp/<version> (<client>)', /^edgegap-mcp\/\d+\.\d+\.\d+ \(newtools\)$/.test(calls[0]?.ua ?? ''), calls[0]?.ua);
await gc.close();

// The token goes wherever EDGEGAP_BASE_URL points, so a URL naming Edgegap's
// host must be exactly https://api.edgegap.com; the server refuses to start.
const { spawnSync } = await import('node:child_process');
for (const [bad, why] of [
  ['http://api.edgegap.com', 'plain http'],
  ['https://api.edgegap.com:8443', 'wrong port'],
  ['https://user:pw@api.edgegap.com', 'credentials in the URL'],
  ['not a url', 'not a URL'],
]) {
  const p = spawnSync('node', ['dist/index.js'], { env: { PATH: process.env.PATH, EDGEGAP_API_TOKEN: REAL, EDGEGAP_BASE_URL: bad }, input: '', timeout: 15000, encoding: 'utf8' });
  check(`EDGEGAP_BASE_URL ${why}: server refuses to start`, p.status === 1 && /EDGEGAP_BASE_URL/.test(p.stderr) && !p.stderr.includes(REAL), p.stderr.slice(0, 120));
}

// read-only mode lists the context tool and no dry-run write tools
const ro2 = await connect({ EDGEGAP_READ_ONLY: '1' });
r = json(await ro2.callTool({ name: 'edgegap_context', arguments: {} }));
check('context reports the image, cap and secret env guardrails', typeof r.guardrails?.image_tags === 'string' && typeof r.guardrails?.deployment_cap === 'string' && typeof r.guardrails?.secret_env === 'string');
check('context in read-only mode says so', r.read_only === true && /read-only/.test(r.guardrails.dry_run));
await ro2.close();

// ------------------------------------------------ 8. image tags ----
console.log('\n8. no moving or malformed image tags');
const ic = await connect({ EDGEGAP_API_TOKEN: REAL });
const icall = (name, args) => ic.callTool({ name, arguments: args });
const verUdp = { ...ver, ports: [{ port: 7777, protocol: 'UDP' }] };
for (const [label, extra] of [
  ['"latest"', { docker_tag: 'latest' }],
  ['"Latest"', { docker_tag: 'Latest' }],
  ['empty tag', { docker_tag: '' }],
  ['tag with a space', { docker_tag: ' build-42' }],
  ['tag starting with a dot', { docker_tag: '.b1' }],
  ['host and tag inside docker_image', { docker_image: 'registry.edgegap.com/my-org-abc123/my-game-server:v2' }],
  ['digest inside docker_image', { docker_image: 'me/srv@sha256:abc' }],
]) {
  calls.length = 0;
  const out = await icall('edgegap_create_app_version', { ...verUdp, ...extra });
  check(`create_app_version, ${label}: refused, nothing sent`, out.isError && /Refused/.test(text(out)) && calls.length === 0, text(out).slice(0, 140));
}
res = await icall('edgegap_create_app_version', { ...verUdp, docker_image: 'registry.edgegap.com/my-org-abc123/my-game-server:v2' });
check('the refusal shows the three-field split', /docker_repository "registry\.edgegap\.com", docker_image "my-org-abc123\/my-game-server", docker_tag "v2"/.test(text(res)), text(res));
res = await icall('edgegap_create_app_version', { ...verUdp, dry_run: true });
check('a build tag still goes through', !res.isError);
calls.length = 0;
res = await icall('edgegap_deploy', { ...dep, version: 'latest-1' });
check('deploying a version on "latest" is refused before the deploy call', res.isError && /latest/.test(text(res)) && !calls.some((x) => x.method === 'POST'), text(res).slice(0, 140));

// --------------------------------------------- 9. agent deployment cap ----
console.log('\n9. agent deployment cap');
agentRunning = 5;
calls.length = 0;
res = await icall('edgegap_deploy', dep);
const capQuery = JSON.parse(new URL(calls.find((x) => x.url.startsWith('/v1/deployments'))?.url ?? '/', 'http://x').searchParams.get('query') ?? '{}');
check('5 running (the default cap): refused, nothing deployed', res.isError && /EDGEGAP_MAX_AGENT_DEPLOYMENTS/.test(text(res)) && !calls.some((x) => x.method === 'POST'), text(res).slice(0, 140));
check('the count is of agent-tagged deployments', JSON.stringify(capQuery.filters) === JSON.stringify([{ field: 'tags', operator: 'in', value: ['edgegap-mcp', 'mcp'] }]), JSON.stringify(capQuery));
check('the refusal says how to clean up', /only_agent_deployments/.test(text(res)) && /edgegap_stop_deployment/.test(text(res)));
agentRunning = 4;
r = json(await icall('edgegap_deploy', dep));
check('4 running: deploys', r.request_id === '7e709a0d8efd');
const nocap = await connect({ EDGEGAP_API_TOKEN: REAL, EDGEGAP_MAX_AGENT_DEPLOYMENTS: '0' });
agentRunning = 50;
calls.length = 0;
r = json(await nocap.callTool({ name: 'edgegap_deploy', arguments: dep }));
check('EDGEGAP_MAX_AGENT_DEPLOYMENTS=0: no cap, no count call', r.request_id === '7e709a0d8efd' && !calls.some((x) => x.url.startsWith('/v1/deployments?') && new URL(x.url, 'http://x').searchParams.get('limit') === '1'));
await nocap.close();
agentRunning = 0;

// ------------------------------------------ 10. secret env vars hidden ----
console.log('\n10. secret-looking env vars hidden in the dashboard');
calls.length = 0;
await icall('edgegap_create_app_version', { ...verUdp, env: [{ key: 'GAME_MODE', value: 'ffa' }, { key: 'STEAM_API_KEY', value: 'k' }, { key: 'db_password', value: 'p' }] });
const envs = calls.find((x) => x.method === 'POST')?.body?.envs ?? [];
check('create_app_version: GAME_MODE visible, STEAM_API_KEY and db_password hidden', envs.map((e) => e.is_hidden).join() === 'false,true,true', JSON.stringify(envs.map((e) => [e.key, e.is_hidden])));
calls.length = 0;
await icall('edgegap_deploy', { ...dep, env: [{ key: 'MATCH_ID', value: 'm' }, { key: 'JWT_SECRET', value: 's' }] });
const depEnvs = calls.find((x) => x.method === 'POST')?.body?.environment_variables ?? [];
check('deploy: MATCH_ID visible, JWT_SECRET hidden', depEnvs.map((e) => e.is_hidden).join() === 'false,true', JSON.stringify(depEnvs));
await ic.close();

// ------------------------------------------------ 11. API coverage ----
console.log('\n11. API coverage tools');
const ac = await connect({ EDGEGAP_API_TOKEN: REAL });
const acall = async (name, args) => ac.callTool({ name, arguments: args });

// get_app_version: full settings, env names only, no registry token or env values
res = await acall('edgegap_get_app_version', { application: 'my-game', version: 'full-1' });
r = json(res);
check('get_app_version: settings shown', r.force_cache === true && r.restart_policy === 'Never' && r.registry_credentials_set === true && r.image === 'registry.edgegap.com/my-org-abc123/my-game-server:build-42' && r.endpoint_storage === 'game-logs', JSON.stringify(r).slice(0, 200));
check('get_app_version: env names and hidden flag, no values', JSON.stringify(r.env) === JSON.stringify([{ key: 'GAME_MODE', hidden: false }, { key: 'API_KEY', hidden: true }]));
check('get_app_version: registry token and env values never shown', !text(res).includes('registry-secret-do-not-leak') && !text(res).includes('env-value-do-not-leak'));

// update_app_version: only passed fields, capped, same refusals as create
calls.length = 0;
r = json(await acall('edgegap_update_app_version', { application: 'my-game', version: 'build-42', docker_tag: 'build-43', force_cache: true, max_duration_minutes: 600 }));
let patch = calls.find((x) => x.method === 'PATCH');
check('update_app_version: PATCH with only the passed fields', patch?.url === '/v1/app/my-game/version/build-42' && JSON.stringify(Object.keys(patch.body).sort()) === JSON.stringify(['docker_tag', 'force_cache', 'max_duration']), JSON.stringify(patch?.body));
check('update_app_version: max_duration capped to the ceiling', patch?.body?.max_duration === 60 && r.notes?.some((n) => /capped/.test(n)));
// ports and env replace the whole list (spec 2026.10.23: "Updating replaces all current values")
calls.length = 0;
r = json(await acall('edgegap_update_app_version', { application: 'my-game', version: 'build-42', ports: [{ port: 7777, protocol: 'UDP' }, { port: 7778, protocol: 'WS', tls_upgrade: true }], env: [{ key: 'GAME_MODE', value: 'ffa' }, { key: 'STEAM_API_KEY', value: 'k' }] }));
patch = calls.find((x) => x.method === 'PATCH');
check('update_app_version: ports sent in full, with defaults', JSON.stringify(patch?.body?.ports) === JSON.stringify([{ port: 7777, protocol: 'UDP', name: 'gameport', to_check: true, tls_upgrade: false }, { port: 7778, protocol: 'WS', name: 'gameport', to_check: true, tls_upgrade: true }]), JSON.stringify(patch?.body?.ports));
check('update_app_version: env sent as envs, secret-named ones hidden', JSON.stringify(patch?.body?.envs?.map((e) => [e.key, e.is_hidden])) === JSON.stringify([['GAME_MODE', false], ['STEAM_API_KEY', true]]));
check('update_app_version: the result says the lists were replaced', r.notes?.some((n) => /ports replaced/.test(n)) && r.notes?.some((n) => /env replaced/.test(n)));
check('update_app_version: the description warns ports/env replace the list', /REPLACE/.test((await ac.listTools()).tools.find((t) => t.name === 'edgegap_update_app_version')?.description ?? ''));
for (const [label, extra] of [['tls_upgrade on UDP', { ports: [{ port: 7777, protocol: 'UDP', tls_upgrade: true }] }], ['token in an env value', { env: [{ key: 'X', value: REAL }] }]]) {
  calls.length = 0;
  res = await acall('edgegap_update_app_version', { application: 'my-game', version: 'build-42', ...extra });
  check(`update_app_version, ${label}: refused, nothing sent`, res.isError && calls.length === 0, text(res).slice(0, 120));
}
// deploy resources override: documented in v2 (DeploymentV2.resources), both or neither, ratio checked
calls.length = 0;
r = json(await acall('edgegap_deploy', { ...dep, cpu_units: 1024, memory_mb: 2048 }));
check('deploy: resources override sent as cpu_units/memory_mib and reported', JSON.stringify(calls.find((x) => x.method === 'POST')?.body?.resources) === JSON.stringify({ cpu_units: 1024, memory_mib: 2048 }) && r.resources?.cpu_units === 1024 && r.resources_note === undefined);
for (const [label, extra] of [['only cpu_units', { cpu_units: 1024 }], ['memory over 2x cpu', { cpu_units: 512, memory_mb: 2048 }]]) {
  calls.length = 0;
  res = await acall('edgegap_deploy', { ...dep, ...extra });
  check(`deploy, ${label}: refused, nothing deployed`, res.isError && !calls.some((x) => x.method === 'POST'), text(res).slice(0, 120));
}
// update_app_version resources: the public v1 spec's PATCH takes req_cpu/req_memory; both or neither, ratio checked
calls.length = 0;
r = json(await acall('edgegap_update_app_version', { application: 'my-game', version: 'build-42', cpu_units: 1024, memory_mb: 2048 }));
patch = calls.find((x) => x.method === 'PATCH');
check('update_app_version: resources sent as req_cpu/req_memory', patch?.body?.req_cpu === 1024 && patch?.body?.req_memory === 2048 && Object.keys(patch.body).length === 2, JSON.stringify(patch?.body));
check('update_app_version: the description no longer says resources cannot change', !/cannot be changed/.test((await ac.listTools()).tools.find((t) => t.name === 'edgegap_update_app_version')?.description ?? ''));
for (const [label, extra] of [['only memory_mb', { memory_mb: 1024 }], ['memory over 2x cpu', { cpu_units: 512, memory_mb: 2048 }]]) {
  calls.length = 0;
  res = await acall('edgegap_update_app_version', { application: 'my-game', version: 'build-42', ...extra });
  check(`update_app_version, ${label}: refused, nothing sent`, res.isError && calls.length === 0, text(res).slice(0, 120));
}
for (const [label, extra] of [['"latest"', { docker_tag: 'latest' }], ['host in docker_image', { docker_image: 'docker.io/me/srv:v1' }], ['token as registry login', { registry_token: REAL }], ['nothing to change', {}]]) {
  calls.length = 0;
  res = await acall('edgegap_update_app_version', { application: 'my-game', version: 'build-42', ...extra });
  check(`update_app_version, ${label}: refused, nothing sent`, res.isError && calls.length === 0, text(res).slice(0, 120));
}
// The API returns this in place of stored secrets (live, 2026-10-26); copied
// back from a version it overwrites the real login and pulls fail.
const PLACEHOLDER = 'This value is set and encrypted';
const newVer = { application: 'my-game', name: 'v-copy', docker_repository: 'registry.edgegap.com', docker_image: 'my-org-abc123/my-game-server', docker_tag: 'build-43', cpu_units: 512, memory_mb: 1024, ports: [{ port: 7777, protocol: 'UDP' }] };
for (const [label, name, args, field] of [
  ['create, copied registry login', 'edgegap_create_app_version', { ...newVer, registry_username: PLACEHOLDER, registry_token: PLACEHOLDER }, 'registry_username, registry_token are'],
  ['create, copied secret env value', 'edgegap_create_app_version', { ...newVer, env: [{ key: 'API_KEY', value: ` ${PLACEHOLDER.toLowerCase()} ` }] }, 'env var "API_KEY" is'],
  ['update, copied registry token', 'edgegap_update_app_version', { application: 'my-game', version: 'build-42', registry_token: PLACEHOLDER }, 'registry_token is'],
  ['update, copied secret env value', 'edgegap_update_app_version', { application: 'my-game', version: 'build-42', env: [{ key: 'GAME_MODE', value: 'ffa' }, { key: 'API_KEY', value: PLACEHOLDER }] }, 'env var "API_KEY" is'],
  ['deploy, copied secret env value', 'edgegap_deploy', { ...dep, env: [{ key: 'API_KEY', value: PLACEHOLDER }] }, 'env var "API_KEY" is'],
  ['create dry run, copied registry token', 'edgegap_create_app_version', { ...newVer, registry_username: 'robot$my-org', registry_token: PLACEHOLDER, dry_run: true }, 'registry_token is'],
]) {
  calls.length = 0;
  res = await acall(name, args);
  t = text(res);
  check(`${label}: refused, nothing sent`, res.isError && calls.length === 0 && t.includes(field) && /Container Registry page/.test(t) && /from the developer/.test(t), t.slice(0, 200));
}
calls.length = 0;
r = json(await acall('edgegap_update_app_version', { application: 'my-game', version: 'build-42', env: [{ key: 'NOTE', value: `${PLACEHOLDER} elsewhere` }] }));
check('a value that only contains the placeholder text is sent', calls.some((x) => x.method === 'PATCH'));
for (const n of ['edgegap_list_app_versions', 'edgegap_create_app_version', 'edgegap_update_app_version']) {
  const d = (await ac.listTools()).tools.find((x) => x.name === n)?.description ?? '';
  check(`${n}: the description says secrets are not copied`, d.includes(PLACEHOLDER) && /non-secret|leave the registry login out/.test(d), d.slice(-300));
}
calls.length = 0;
res = await acall('edgegap_update_app_version', { application: 'my-game', version: 'build-42', registry_token: 'reg-secret-xyz', dry_run: true });
check('update_app_version dry run: nothing sent, registry token masked', calls.length === 0 && !text(res).includes('reg-secret-xyz'));

// update_app
calls.length = 0;
r = json(await acall('edgegap_update_app', { application: 'my-game', is_active: false }));
check('update_app: PATCH is_active', calls.find((x) => x.method === 'PATCH')?.body?.is_active === false && r.active === false);

// locations and beacons
r = json(await acall('edgegap_list_locations', {}));
check('list_locations: every location, compact', r.locations?.length === 2 && r.locations[0].region === 'Quebec' && r.locations[1].region === undefined && r.filtered_for === undefined);
calls.length = 0;
r = json(await acall('edgegap_list_locations', { application: 'my-game', version: 'build-42' }));
const lq = new URL(calls[0].url, 'http://x').searchParams;
check('list_locations with a version: filtered for capacity', lq.get('app') === 'my-game' && lq.get('version') === 'build-42' && r.locations?.length === 1 && /capacity/.test(r.filtered_for));
res = await acall('edgegap_list_locations', { application: 'my-game' });
check('list_locations: application without version is refused', res.isError === true);
r = json(await acall('edgegap_list_ping_beacons', {}));
check('list_ping_beacons: host and ports', r.beacons?.[0]?.host === 'beacon-mtl.edgegap.net' && r.beacons[0].udp_port === 5000 && r.beacons[0].city === 'Montreal');

// metrics
r = json(await acall('edgegap_get_deployment_metrics', { request_id: '7e709a0d8efd' }));
check('metrics: latest, average and peak per series', r.cpu?.latest === 20 && r.cpu.average === 20 && r.cpu.peak === 30 && r.memory?.peak === 400 && r.memory.labels?.[0] === 'MB');
check('metrics: empty series left out, totals kept', r.network_transmit === undefined && r.totals?.received === 9);
res = await acall('edgegap_get_deployment_metrics', { request_id: '*' });
check('metrics: a wildcard request_id is refused', res.isError === true);

// delete registry tag
calls.length = 0;
r = json(await acall('edgegap_delete_registry_tag', { image_name: 'my-game-server', tag: 'build-41' }));
check('delete_registry_tag: one DELETE, result reported', calls.filter((x) => x.method === 'DELETE').length === 1 && r.deleted_tag === 'build-41' && r.image_deleted === true && r.freed_mb === 512);
calls.length = 0;
r = json(await acall('edgegap_delete_registry_tag', { image_name: 'registry.edgegap.com/my-org-abc123/my-game-server:build-41', tag: 'build-41' }));
check('delete_registry_tag: full reference reduced, project dropped after a 404', r.image_name === 'my-game-server' && calls.filter((x) => x.method === 'DELETE').length === 2);
for (const bad of ['latest', '*', 'a,b', '']) {
  calls.length = 0;
  res = await acall('edgegap_delete_registry_tag', { image_name: 'my-game-server', tag: bad });
  check(`delete_registry_tag "${bad}" refused, nothing sent`, res.isError && calls.length === 0);
}

// relays
r = json(await acall('edgegap_list_relay_sessions', {}));
check('list_relay_sessions: compact, no authorization tokens', r.sessions?.[0]?.session_id === 'abc123-S' && r.sessions[0].players === 1 && !JSON.stringify(r).includes('901'));
calls.length = 0;
r = json(await acall('edgegap_revoke_relay_user', { session_id: 'abc123-S', user_authorization_token: 901 }));
check('revoke_relay_user: posts the player token', JSON.stringify(calls.find((x) => x.method === 'POST')?.body) === JSON.stringify({ session_id: 'abc123-S', authorization_token: 901 }) && r.revoked === 901);
res = await acall('edgegap_revoke_relay_user', { session_id: '*', user_authorization_token: 1 });
check('revoke_relay_user: a wildcard session_id is refused', res.isError === true);

// ----------------------------------------- 12. results: masked, structured ----
console.log('\n12. every result masked and structured');
res = await acall('edgegap_get_app_version', { application: 'my-game', version: 'echo-1' });
check('a token echoed in a successful response is masked', !text(res).includes(REAL) && !JSON.stringify(res.structuredContent ?? {}).includes(REAL) && /<redacted-token>/.test(text(res)), text(res).slice(0, 200));
res = await acall('edgegap_list_locations', {});
check('results carry structuredContent equal to the JSON text', res.structuredContent?.locations?.length === 2 && JSON.stringify(res.structuredContent) === JSON.stringify(JSON.parse(res.content.at(-1).text)));
res = await acall('edgegap_update_app_version', { application: 'my-game', version: 'build-42' });
check('errors carry no structuredContent', res.isError && res.structuredContent === undefined);
// ------------------------------------- 12b. Gameye-parity tools (0.14.0) ----
console.log('\n12b. deploy options, limits and housekeeping tools');
calls.length = 0;
r = json(await acall('edgegap_deploy', { ...dep, require_cached_locations: true, webhook_on_ready: 'https://hooks.example.com/ready', webhook_on_terminated: 'https://hooks.example.com/end' }));
let post = calls.find((x) => x.method === 'POST');
check('deploy: require_cached_locations and webhooks sent as the v2 spec shapes', post?.body?.require_cached_locations === true && post?.body?.webhook_on_ready?.url === 'https://hooks.example.com/ready' && post?.body?.webhook_on_terminated?.url === 'https://hooks.example.com/end' && post?.body?.webhook_on_error === undefined, JSON.stringify(post?.body));
for (const [label, extra] of [['http webhook', { webhook_on_ready: 'http://hooks.example.com/r' }], ['webhook with credentials', { webhook_on_error: 'https://u:p@hooks.example.com/e' }], ['token in a webhook URL', { webhook_on_ready: `https://hooks.example.com/?t=${REAL}` }]]) {
  calls.length = 0;
  res = await acall('edgegap_deploy', { ...dep, ...extra });
  check(`deploy, ${label}: refused, nothing sent`, res.isError && !calls.some((x) => x.method === 'POST'), text(res).slice(0, 120));
}
calls.length = 0;
r = json(await acall('edgegap_deploy', { ...dep, private_host_ids: ['host-a', 'host-a', 'host-b'] }));
post = calls.find((x) => x.method === 'POST');
check('deploy with private_host_ids: POST /v2/private-fleets/deployments, IDs de-duplicated, guardrails kept', post?.url === '/v2/private-fleets/deployments' && JSON.stringify(post.body.private_host_ids) === JSON.stringify(['host-a', 'host-b']) && post.body.tags.includes('edgegap-mcp') && r.request_id === 'fleetdep0001', JSON.stringify(post));
calls.length = 0;
res = await acall('edgegap_deploy', { ...dep, version: 'crowded-1' });
check('deploy refused by the API (422): names the deployment it still created', res.isError && /leftover0001/.test(text(res)) && /edgegap_stop_deployment/.test(text(res)) && /Likely cause/.test(text(res)), text(res).slice(0, 300));
check('...and not the healthy deploy of the same version made just before it', !/concurrent01/.test(text(res)), text(res).slice(0, 300));
crowdedRefused = false;
calls.length = 0;
res = await acall('edgegap_deploy', { ...dep, version: 'uncached-1', require_cached_locations: true });
check('require_cached_locations on an uncached version (422): hint names force_cache, not allocation', res.isError && /force_cache: true/.test(text(res)) && !/could not allocate/.test(text(res)), text(res).slice(0, 400));
check('...looked it up by application, version, agent tag and time', (() => { const q = calls.find((x) => x.method === 'GET' && x.url.startsWith('/v1/deployments?') && x.url.includes('created_at')); const fl = q && JSON.parse(new URL(q.url, 'http://x').searchParams.get('query')).filters; return fl && ['application', 'version', 'tags', 'created_at'].every((k) => fl.some((x) => x.field === k)); })());

const capped = await connect({ EDGEGAP_API_TOKEN: REAL, EDGEGAP_MAX_DEPLOYS_PER_RUN: '2' });
await capped.callTool({ name: 'edgegap_deploy', arguments: dep });
await capped.callTool({ name: 'edgegap_deploy', arguments: { ...dep, version: 'crowded-1' } });
calls.length = 0;
res = await capped.callTool({ name: 'edgegap_deploy', arguments: dep });
check('EDGEGAP_MAX_DEPLOYS_PER_RUN: the third deploy is refused (a failed one counts), nothing sent', res.isError && /EDGEGAP_MAX_DEPLOYS_PER_RUN=2/.test(text(res)) && calls.length === 0, text(res).slice(0, 160));
res = await capped.callTool({ name: 'edgegap_deploy', arguments: { ...dep, dry_run: true } });
check('...a dry run still works past the cap', !res.isError);
await capped.close();

const ownOnly = await connect({ EDGEGAP_API_TOKEN: REAL, EDGEGAP_STOP_OWN_ONLY: '1' });
calls.length = 0;
res = await ownOnly.callTool({ name: 'edgegap_stop_deployment', arguments: { request_id: 'othersdep001' } });
check('EDGEGAP_STOP_OWN_ONLY: a deployment without the agent tag is refused, not stopped', res.isError && /EDGEGAP_STOP_OWN_ONLY/.test(text(res)) && !calls.some((x) => x.method === 'DELETE'), text(res).slice(0, 160));
res = await ownOnly.callTool({ name: 'edgegap_stop_deployment', arguments: { request_id: '7e709a0d8efd' } });
check('...an agent-tagged one is stopped', !res.isError && calls.some((x) => x.method === 'DELETE' && x.url === '/v1/stop/7e709a0d8efd'));
await ownOnly.close();

calls.length = 0;
r = json(await acall('edgegap_tag_deployment', { request_id: '7e709a0d8efd', add: ['playtest', 'match-1'], remove: ['match-1x'] }));
check('tag_deployment: adds only missing tags, notes the rest', calls.filter((x) => x.method === 'POST').map((x) => x.body.name).join() === 'playtest' && r.notes?.some((n) => /match-1" was already/.test(n)) && r.notes?.some((n) => /match-1x" was not/.test(n)), JSON.stringify(r));
calls.length = 0;
json(await acall('edgegap_tag_deployment', { request_id: '7e709a0d8efd', remove: ['match-1'] }));
check('tag_deployment: removes a tag with DELETE', calls.some((x) => x.method === 'DELETE' && x.url === '/v1/deployments/7e709a0d8efd/tags/match-1'));
for (const [label, extra] of [['removing edgegap-mcp', { remove: ['edgegap-mcp'] }], ['nothing to do', {}], ['token as a tag', { add: [REAL.slice(0, 36)] }]]) {
  calls.length = 0;
  res = await acall('edgegap_tag_deployment', { request_id: '7e709a0d8efd', ...extra });
  check(`tag_deployment, ${label}: refused, nothing sent`, res.isError && calls.length === 0, text(res).slice(0, 120));
}

calls.length = 0;
r = json(await acall('edgegap_report_deployment', { request_id: '7e709a0d8efd', reason: 'griefing', metadata: { match_id: 'm-42' } }));
post = calls.find((x) => x.method === 'POST');
check('report_deployment: POST :report with reason and metadata', post?.url === '/v1/deployments/7e709a0d8efd:report' && post.body.reason === 'griefing' && post.body.metadata.match_id === 'm-42' && r.reported === true);

calls.length = 0;
res = await acall('edgegap_delete_app_version', { application: 'my-game', version: 'build-42' });
check('delete_app_version: refused while a deployment of it runs, nothing deleted', res.isError && /7e709a0d8efd/.test(text(res)) && !calls.some((x) => x.method === 'DELETE'), text(res).slice(0, 160));
calls.length = 0;
r = json(await acall('edgegap_delete_app_version', { application: 'cleanup-game', version: 'old-1' }));
check('delete_app_version: deletes an idle version', r.deleted_version === 'old-1' && calls.some((x) => x.method === 'DELETE' && x.url === '/v1/app/cleanup-game/version/old-1'));
res = await acall('edgegap_delete_app_version', { application: 'cleanup-game', version: 'old-*' });
check('delete_app_version: a wildcard is refused', res.isError && /one exact version/.test(text(res)));
calls.length = 0;
res = await acall('edgegap_delete_app', { application: 'cleanup-game' });
check('delete_app: refused while it has versions (default max_versions 0), nothing deleted', res.isError && /old-1, old-2/.test(text(res)) && !calls.some((x) => x.method === 'DELETE'), text(res).slice(0, 160));
calls.length = 0;
r = json(await acall('edgegap_delete_app', { application: 'cleanup-game', max_versions: 2 }));
check('delete_app: with max_versions covering them, deleted', r.deleted_application === 'cleanup-game' && calls.some((x) => x.method === 'DELETE' && x.url === '/v1/app/cleanup-game'));
res = await acall('edgegap_delete_app', { application: 'my-game', max_versions: 5 });
check('delete_app: refused while a deployment runs', res.isError && /running deployments/.test(text(res)));

r = json(await acall('edgegap_list_fleet_hosts', { fleet_name: 'my-fleet' }));
check('list_fleet_hosts: hosts with status, ACTIVE counted', r.total === 2 && r.active === 1 && r.hosts[0].host_id === 'host-a');
r = json(await acall('edgegap_list_fleet_hosts', { fleet_name: 'empty-fleet' }));
check('list_fleet_hosts: an empty fleet is a status, not an error', r.status === 'empty' && /next_step|dashboard/.test(JSON.stringify(r)));

r = json(await acall('edgegap_list_endpoint_storage', {}));
check('list_endpoint_storage: endpoints with their pull profiles', r.endpoints?.[0]?.name === 'game-logs' && r.endpoints[0].pull_profiles?.[0]?.name === 'maps');
calls.length = 0;
res = await acall('edgegap_create_endpoint_storage', { name: 'game-logs', endpoint: 'https://s3.us-east-1.amazonaws.com', bucket: 'my-logs', access_key_id: 'AKIAEXAMPLE', secret_access_key: 'very-secret-key-123' });
check('create_endpoint_storage: secret sent once, never in the result', calls.find((x) => x.method === 'POST')?.body?.secret_access_key === 'very-secret-key-123' && !text(res).includes('very-secret-key-123') && /endpoint_storage/.test(json(res).next_step));
res = await acall('edgegap_create_endpoint_storage', { name: 'x', endpoint: 'https://s3.example.com', bucket: 'b', access_key_id: 'k', secret_access_key: 'very-secret-key-123', dry_run: true });
check('create_endpoint_storage dry run: the secret key is masked', !text(res).includes('very-secret-key-123'), text(res).slice(0, 300));
calls.length = 0;
res = await acall('edgegap_create_endpoint_storage', { name: 'x', endpoint: 'http://s3.example.com', bucket: 'b', access_key_id: 'k', secret_access_key: 's' });
check('create_endpoint_storage: a plain-http endpoint is refused, nothing sent', res.isError && calls.length === 0);
calls.length = 0;
calls.length = 0;
res = await acall('edgegap_create_pull_profile', { endpoint_storage: 'game-logs', name: 'maps', source: 'maps/', source_type: 'Folder', destination: '/data/maps' });
check('create_pull_profile: "maps/" refused locally with the fix, nothing sent', res.isError && /"\/maps"/.test(text(res)) && calls.length === 0, text(res).slice(0, 200));
calls.length = 0;
r = json(await acall('edgegap_create_pull_profile', { endpoint_storage: 'game-logs', name: 'maps', source: '/maps', source_type: 'Folder', destination: '/data/maps' }));
check('create_pull_profile: POST with the spec fields', JSON.stringify(Object.keys(calls.find((x) => x.method === 'POST')?.body ?? {}).sort()) === JSON.stringify(['destination', 'name', 'source', 'source_type']) && /edgegap_link_pull_profile/.test(r.next_step));
res = await acall('edgegap_create_pull_profile', { endpoint_storage: 'game-logs', name: 'maps', source: '/maps', source_type: 'Folder', destination: 'data/maps' });
check('create_pull_profile: a relative destination is refused', res.isError);
calls.length = 0;
r = json(await acall('edgegap_link_pull_profile', { endpoint_storage: 'game-logs', pull_profile: 'maps', application: 'my-game', version: 'build-42' }));
check('link_pull_profile: PUT, linked', calls.at(-1)?.method === 'PUT' && r.linked === true);
r = json(await acall('edgegap_link_pull_profile', { endpoint_storage: 'game-logs', pull_profile: 'maps', application: 'my-game', version: 'build-42', unlink: true }));
check('link_pull_profile unlink: DELETE on the same path', calls.at(-1)?.method === 'DELETE' && calls.at(-1)?.url === '/v1/storage/endpoint/game-logs/pull-profile/maps/app/my-game/version/build-42' && r.linked === false);
calls.length = 0;
await acall('edgegap_update_app_version', { application: 'my-game', version: 'build-42', endpoint_storage: 'game-logs' });
check('update_app_version: endpoint_storage sent', calls.find((x) => x.method === 'PATCH')?.body?.endpoint_storage === 'game-logs');

// ------------------------------------------------ 13. argument errors ----
console.log('\n13. argument errors the agent can act on');
res = await acall('edgegap_deploy', { application: 1 });
t = text(res);
check('bad arguments: host label first, like every result', res.isError && res.content[0].text.startsWith('['), res.content[0].text);
check('bad arguments: one line per problem, in plain words', /- application: must be string \(got number\)/.test(t) && /- version: missing \(required\)/.test(t) && /- users: missing \(required\)/.test(t), t);
check('bad arguments: lists required and optional parameters', /Required: application, version, users\./.test(t) && /Optional: .*dry_run/.test(t), t);
await ac.close();

// ------------------------------------------------- token prefix in env ----
const dbl = await connect({ EDGEGAP_API_TOKEN: 'token token fake-api-token' });
calls.length = 0;
await dbl.callTool({ name: 'edgegap_list_app_versions', arguments: { application: 'my-game' } });
check('EDGEGAP_API_TOKEN "token token <value>" is sent as "token <value>"', calls.at(-1)?.auth === 'token fake-api-token', calls.at(-1)?.auth);
await dbl.close();

mock.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
