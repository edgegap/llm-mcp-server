// edgegap_update_skills and the skills version check, against a fake home
// folder and a local stand-in for GitHub (EDGEGAP_SKILLS_RAW_URL), so nothing
// on this machine is read or changed and no real network call is made.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SKILLS_PACK } from '../dist/skills.generated.js';
import { skillVersionOf, compareVersions } from '../dist/skillsversion.js';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}
const body = (r) => r.content.filter((x, i) => !(i === 0 && /^\[[^\]]+\]$/.test(x.text))).map((x) => x.text).join('\n');
const json = (r) => JSON.parse(body(r));

console.log('\nversion parsing');
check('reads metadata.version', skillVersionOf('---\nname: x\nmetadata:\n  version: "0.1.14"\n---\nbody') === '0.1.14');
check('reads it with CRLF and single quotes', skillVersionOf("---\r\nname: x\r\nmetadata:\r\n  author: e\r\n  version: '1.2.3'\r\n---\r\n") === '1.2.3');
check('ignores a version outside the frontmatter', skillVersionOf('---\nname: x\n---\nmetadata:\n  version: "9.9.9"') === undefined);
check('compares numerically, not as text', compareVersions('0.1.9', '0.1.14') < 0 && compareVersions('0.15.1', '0.9.0') > 0);

// A stand-in for raw.githubusercontent.com: pack PACK_LATEST, every skill at its bundled version.
const PACK_LATEST = '99.0.0';
let githubHits = 0;
const github = http.createServer((req, res) => {
  githubHits++;
  if (req.url === '/.claude-plugin/plugin.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ name: 'edgegap', version: PACK_LATEST }));
  }
  const m = req.url.match(/^\/skills\/([a-z0-9-]+)\/SKILL\.md$/);
  const skill = m && SKILLS_PACK.skills.find((s) => s.name === m[1]);
  if (skill) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(skill.files[0].content);
  }
  res.writeHead(404).end();
});
await new Promise((r) => github.listen(0, '127.0.0.1', r));
const RAW = `http://127.0.0.1:${github.address().port}`;

// A fake home: one hand-copied skill (old), one git checkout (old), one current copy.
const home = mkdtempSync(join(tmpdir(), 'edgegap-skills-'));
const project = join(home, 'project');
mkdirSync(project, { recursive: true });
const unity = SKILLS_PACK.skills.find((s) => s.name === 'edgegap-unity');
const ngo = SKILLS_PACK.skills.find((s) => s.name === 'edgegap-ngo');
const fishnet = SKILLS_PACK.skills.find((s) => s.name === 'edgegap-fishnet');
const old = (name) => `---\nname: ${name}\ndescription: old\nmetadata:\n  version: "0.0.1"\n---\nold body\n`;
const userSkills = join(home, '.claude', 'skills');
mkdirSync(join(userSkills, 'edgegap-unity'), { recursive: true });
writeFileSync(join(userSkills, 'edgegap-unity', 'SKILL.md'), old('edgegap-unity'));
writeFileSync(join(userSkills, 'edgegap-unity', 'my-notes.md'), 'mine');
mkdirSync(join(userSkills, 'edgegap-ngo', '.git'), { recursive: true });
writeFileSync(join(userSkills, 'edgegap-ngo', 'SKILL.md'), old('edgegap-ngo'));
mkdirSync(join(userSkills, 'edgegap-fishnet'), { recursive: true });
writeFileSync(join(userSkills, 'edgegap-fishnet', 'SKILL.md'), fishnet.files[0].content);
// Someone's own skill that happens to share a name is not ours.
mkdirSync(join(userSkills, 'edgegap-purrnet'), { recursive: true });
writeFileSync(join(userSkills, 'edgegap-purrnet', 'SKILL.md'), '---\nname: my-purrnet-notes\n---\n');

async function connect(env = {}) {
  const c = new Client({ name: 'update-skills-test', version: '1.0.0' });
  await c.connect(new StdioClientTransport({
    command: 'node', args: [join(process.cwd(), 'dist/index.js')], cwd: project, stderr: 'ignore',
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, EDGEGAP_SKILLS_RAW_URL: RAW, ...env },
  }));
  return c;
}

console.log('\nversion check in the skill tools');
let c = await connect();
let r = await c.callTool({ name: 'edgegap_list_skills', arguments: {} });
let out = json(r);
check('list_skills names the latest pack on GitHub', out.latest_pack === PACK_LATEST, out.latest_pack);
check('and says the served pack is behind, with how to update', out.served_is_latest === false && /npx -y @edgegap\/mcp@latest/.test(out.update ?? ''));
check('and points to edgegap_update_skills', /edgegap_update_skills/.test(out.next_step));
r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-unity' } });
check('get_skill notes the newer pack under its header', /^edgegap-unity .*\nNote: Pack 99\.0\.0 is on GitHub/.test(body(r)) && body(r).includes(unity.files[0].content));
const hitsBefore = githubHits;
await c.callTool({ name: 'edgegap_list_skills', arguments: {} });
check('the pack version is cached, not fetched per call', githubHits === hitsBefore);

console.log('\nedgegap_update_skills: check');
r = await c.callTool({ name: 'edgegap_update_skills', arguments: {} });
out = json(r);
const rows = out.installs.flatMap((i) => i.skills);
const rowOf = (n) => rows.find((s) => s.name === n);
check('finds the hand-copied skills', out.installs.length === 1 && out.installs[0].kind === 'copy', JSON.stringify(out.installs.map((i) => i.where)));
check('old copy: update available', rowOf('edgegap-unity')?.status === 'update available' && rowOf('edgegap-unity').latest === unity.version);
check('current copy: up to date', rowOf('edgegap-fishnet')?.status === 'up to date');
check('a different skill reusing the name is ignored', !rowOf('edgegap-purrnet'));
check('lists what apply would do, changing nothing', out.would_run?.length === 2 && readFileSync(join(userSkills, 'edgegap-unity', 'SKILL.md'), 'utf8').includes('old body'));

r = await c.callTool({ name: 'edgegap_update_skills', arguments: { installed_versions: { 'edgegap-ngo': '0.0.1', 'not a name': '1.0.0' } } });
out = json(r);
check('installed_versions are compared too; bad names dropped', out.loaded_skills?.length === 1 && out.loaded_skills[0].status === 'update available' && /npx skills add edgegap\/llm-agent-skills/.test(out.how_to_update));

console.log('\nedgegap_update_skills: apply');
r = await c.callTool({ name: 'edgegap_update_skills', arguments: { apply: true } });
out = json(r);
const unityNow = readFileSync(join(userSkills, 'edgegap-unity', 'SKILL.md'), 'utf8');
check('rewrites the old copy from the bundle', unityNow === unity.files[0].content);
check('with its other files', unity.files.every((f) => existsSync(join(userSkills, 'edgegap-unity', ...f.path.split('/')))));
check('and keeps files the developer added', readFileSync(join(userSkills, 'edgegap-unity', 'my-notes.md'), 'utf8') === 'mine');
check('leaves a git checkout alone, and says so', readFileSync(join(userSkills, 'edgegap-ngo', 'SKILL.md'), 'utf8').includes('old body') && out.applied.some((a) => /edgegap-ngo.*git checkout/.test(a)));
check('the git checkout makes the result an error', r.isError === true);
check('reports the state after, and to start a new session', out.after?.[0].skills.find((s) => s.name === 'edgegap-unity')?.status === 'up to date' && /new session/.test(out.reload));
await c.close();

console.log('\nedgegap_update_skills: updaters are opt-in');
// A skills CLI install of an old edgegap-colyseus: apply would run npx, which
// needs EDGEGAP_ENABLE_SKILLS_UPDATE=1. Without it nothing is started.
mkdirSync(join(home, '.agents', 'skills', 'edgegap-colyseus'), { recursive: true });
writeFileSync(join(home, '.agents', 'skills', 'edgegap-colyseus', 'SKILL.md'), old('edgegap-colyseus'));
writeFileSync(join(home, '.agents', '.skill-lock.json'), JSON.stringify({ skills: { 'edgegap-colyseus': { source: 'edgegap/llm-agent-skills' } } }));
c = await connect();
r = await c.callTool({ name: 'edgegap_update_skills', arguments: {} });
out = json(r);
check('the skills CLI command is pinned to skills@1.7.4', out.would_run?.some((w) => /^npx -y skills@1\.7\.4 update edgegap-colyseus -g -y$/.test(w)), JSON.stringify(out.would_run));
r = await c.callTool({ name: 'edgegap_update_skills', arguments: { apply: true } });
out = json(r);
check('apply without EDGEGAP_ENABLE_SKILLS_UPDATE runs no updater and says how to', out.applied?.some((a) => /not run \(EDGEGAP_ENABLE_SKILLS_UPDATE/.test(a) && /skills@1\.7\.4/.test(a)) && readFileSync(join(home, '.agents', 'skills', 'edgegap-colyseus', 'SKILL.md'), 'utf8').includes('old body'), JSON.stringify(out.applied));
check('the description says updaters are opt-in', /EDGEGAP_ENABLE_SKILLS_UPDATE=1/.test((await c.listTools()).tools.find((t) => t.name === 'edgegap_update_skills')?.description ?? ''));
await c.close();
rmSync(join(home, '.agents'), { recursive: true, force: true });

console.log('\noff switch and read-only');
const before = githubHits;
c = await connect({ EDGEGAP_SKILLS_CHECK: 'off' });
out = json(await c.callTool({ name: 'edgegap_list_skills', arguments: {} }));
check('EDGEGAP_SKILLS_CHECK=off makes no request', githubHits === before && /check is off/.test(out.latest_pack));
r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-unity' } });
check('and get_skill still works', !r.isError && !/Note:/.test(body(r).split('\n')[1] ?? ''));
await c.close();

writeFileSync(join(userSkills, 'edgegap-unity', 'SKILL.md'), old('edgegap-unity'));
c = await connect({ EDGEGAP_READ_ONLY: '1' });
r = await c.callTool({ name: 'edgegap_update_skills', arguments: {} });
check('read-only still checks', !r.isError && /EDGEGAP_READ_ONLY/.test(json(r).next_step));
r = await c.callTool({ name: 'edgegap_update_skills', arguments: { apply: true } });
check('read-only refuses apply and changes nothing', r.isError && readFileSync(join(userSkills, 'edgegap-unity', 'SKILL.md'), 'utf8').includes('old body'));
await c.close();

console.log('\nhosted (self-hosted HTTP server)');
const port = 19000 + Math.floor(Math.random() * 1000);
const proc = spawn('node', ['dist/index.js', '--http'], {
  env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', HOME: home, USERPROFILE: home, EDGEGAP_SKILLS_RAW_URL: RAW },
  stdio: ['ignore', 'ignore', 'pipe'],
});
await new Promise((resolve, reject) => {
  proc.stderr.on('data', (d) => /listening/.test(d) && resolve());
  proc.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
});
const hc = new Client({ name: 'update-skills-http', version: '1.0.0' });
await hc.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
const tool = (await hc.listTools()).tools.find((t) => t.name === 'edgegap_update_skills');
check('hosted: the tool exists, without apply', tool && !('apply' in tool.inputSchema.properties) && tool.annotations?.readOnlyHint === true);
r = await hc.callTool({ name: 'edgegap_update_skills', arguments: { installed_versions: { 'edgegap-unity': '0.0.1' } } });
out = json(r);
check('hosted: never reads the disk, compares installed_versions', out.installs.length === 0 && out.loaded_skills[0].status === 'update available' && /cannot see/.test(out.note));
out = json(await hc.callTool({ name: 'edgegap_list_skills', arguments: {} }));
check('hosted: list_skills says the hosted server updates on release', /hosted server still serves/.test(out.update ?? ''));
await hc.close();
proc.kill();

github.close();
rmSync(home, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
