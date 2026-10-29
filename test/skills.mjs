// The Edgegap agent skills served over MCP: tools, prompts and resources, all
// from the bundle in src/skills.generated.ts. No network, no token needed.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SKILLS_PACK } from '../dist/skills.generated.js';
import { serverInstructions, INSTRUCTIONS_MAX_CHARS } from '../dist/tools.js';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

async function connect(env = {}) {
  const c = new Client({ name: 'skills-test', version: '1.0.0' });
  // No EDGEGAP_API_TOKEN: skills must work before any token exists.
  await c.connect(new StdioClientTransport({ command: 'node', args: ['dist/index.js'], stderr: 'ignore', env: { PATH: process.env.PATH, EDGEGAP_SKILLS_CHECK: 'off', ...env } }));
  return c;
}
const body = (r) => r.content.filter((x, i) => !(i === 0 && /^\[[^\]]+\]$/.test(x.text))).map((x) => x.text).join('\n');
const totalFiles = SKILLS_PACK.skills.reduce((n, s) => n + s.files.length, 0);

console.log('\nbundle');
const pin = readFileSync('scripts/skills-pin.txt', 'utf8').trim();
check('bundle is the pinned commit', SKILLS_PACK.commit === pin, `${SKILLS_PACK.commit} vs ${pin}`);
check('bundle has the core skills', ['edgegap', 'edgegap-unity', 'edgegap-ngo', 'edgegap-fishnet', 'edgegap-purrnet', 'edgegap-fusion', 'edgegap-manus', 'edgegap-unreal', 'edgegap-eos-voice', 'edgegap-fusion-simplefps', 'edgegap-godot', 'edgegap-colyseus', 'edgegap-nakama', 'edgegap-playfab', 'edgegap-threejs'].every((n) => SKILLS_PACK.skills.some((s) => s.name === n)));
check('every skill starts with its SKILL.md', SKILLS_PACK.skills.every((s) => s.files[0].path === 'SKILL.md' && s.files[0].content.includes(`name: ${s.name}`)));
check('no evals, scripts or fixtures bundled', SKILLS_PACK.skills.every((s) => s.files.every((f) => !/^(evals|scripts|fixtures)\//.test(f.path))));
check('no Windows line endings', SKILLS_PACK.skills.every((s) => s.files.every((f) => !f.content.includes('\r\n'))));

const c = await connect();

console.log('\ntools');
let r = await c.callTool({ name: 'edgegap_list_skills', arguments: {} });
const listed = JSON.parse(body(r));
check('edgegap_list_skills works with no token', !r.isError && listed.skills.length === SKILLS_PACK.skills.length);
check('lists names, versions and descriptions', listed.skills.every((s) => s.name && s.version && s.description.length > 40));
check('names the pack version and commit', listed.pack === `${SKILLS_PACK.version} (${SKILLS_PACK.commit.slice(0, 7)})`);

r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-unity' } });
let t = body(r);
const unity = SKILLS_PACK.skills.find((s) => s.name === 'edgegap-unity');
check('get_skill returns SKILL.md by default', !r.isError && t.includes(unity.files[0].content));
check('and lists the other files with how to fetch them', t.includes('references/deploy.md') && t.includes('edgegap_get_skill {skill: "edgegap-unity"'));

const ref = unity.files.find((f) => f.path.startsWith('references/'));
r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-unity', file: ref.path } });
check(`get_skill returns ${ref.path}`, !r.isError && body(r).includes(ref.content));
const asset = unity.files.find((f) => f.path.endsWith('.cs'));
r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-unity', file: asset.path } });
check(`get_skill returns a template (${asset.path}) exactly`, !r.isError && body(r).endsWith(asset.content));
r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-unity', file: `./${ref.path}` } });
check('a leading ./ is accepted', !r.isError);

for (const bad of ['../edgegap/SKILL.md', '/etc/passwd', 'C:\\Windows\\win.ini', 'references/../../package.json', 'missing.md']) {
  r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-unity', file: bad } });
  check(`file "${bad}" is not found, and the real files are listed`, r.isError && /is not a file in the edgegap-unity skill/.test(body(r)) && body(r).includes('- SKILL.md'));
}
r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'not-a-skill' } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
check('an unknown skill is rejected, and the real skills are listed', r.isError === true && body(r).includes('edgegap-purrnet') && body(r).includes('edgegap-manus'));
const getSkill = (await c.listTools()).tools.find((t) => t.name === 'edgegap_get_skill');
check('skill is a plain string, so a cached schema never blocks a newer skill', getSkill.inputSchema.properties.skill.type === 'string' && !getSkill.inputSchema.properties.skill.enum);
check('every skill the router names can be loaded', [...SKILLS_PACK.skills.find((s) => s.name === 'edgegap').files[0].content.matchAll(/edgegap-[a-z-]+[a-z]/g)].map((m) => m[0]).filter((n) => !n.startsWith('edgegap-skill') && !n.startsWith('edgegap-mcp') && !n.startsWith('edgegap-agent')).every((n) => SKILLS_PACK.skills.some((s) => s.name === n)));
r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-manus' } });
check('edgegap-manus loads', !r.isError && body(r).startsWith('edgegap-manus'));
r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-fusion' } });
check('edgegap-fusion loads', !r.isError && body(r).startsWith('edgegap-fusion'));
r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-fusion', file: 'assets/br200/edgegap/start-server.sh' } });
check('edgegap-fusion serves its shell scripts', !r.isError && body(r).includes('#!'));
r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-nakama', file: 'assets/nakama/go.mod' } });
check('edgegap-nakama serves its Go module', !r.isError && body(r).includes('nakama-edgegap'));
r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-playfab', file: 'assets/azure-functions/src/functions/StartEdgegapDeployment.js' } });
check('edgegap-playfab serves its Azure Function', !r.isError && body(r).includes('playfab.matchmaking.match_found'));
r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-unity', file: 'assets/matchmaker/casual.json' } });
check('matchmaker templates name app versions with a UTC timestamp', !r.isError && body(r).includes('"version": "20261022-1430"') && !body(r).includes('"version": "v1"'));
r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-threejs', file: 'assets/client/index.html' } });
check('edgegap-threejs serves its HTML client shell', !r.isError && /<html/i.test(body(r)));
r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-godot' } });
check('edgegap-godot loads', !r.isError && body(r).startsWith('edgegap-godot'));
r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-manus', file: 'assets/backend/joinToken.ts' } });
check('TypeScript templates are bundled', !r.isError && body(r).includes('joinToken.ts'));

console.log('\nprompts');
const { prompts } = await c.listPrompts();
check('one prompt per skill', SKILLS_PACK.skills.every((s) => prompts.some((p) => p.name === s.name)), prompts.map((p) => p.name).join(', '));
const p = await c.getPrompt({ name: 'edgegap-unreal' });
const unreal = SKILLS_PACK.skills.find((s) => s.name === 'edgegap-unreal');
check('a prompt carries the whole SKILL.md as a user message', p.messages[0].role === 'user' && p.messages[0].content.text.includes(unreal.files[0].content));

console.log('\nresources');
const all = [];
let cursor;
do {
  const page = await c.listResources(cursor ? { cursor } : undefined);
  all.push(...page.resources);
  cursor = page.nextCursor;
} while (cursor);
const skillRes = all.filter((x) => x.uri.startsWith('edgegap-skill://'));
check('one listed resource per skill (its SKILL.md)', skillRes.length === SKILLS_PACK.skills.length && skillRes.every((x) => x.uri.endsWith('/SKILL.md')), `${skillRes.length} listed`);
const { resourceTemplates } = await c.listResourceTemplates();
check('every other file is reachable through a template', resourceTemplates.some((t) => t.uriTemplate === 'edgegap-skill://{skill}/{+path}'), JSON.stringify(resourceTemplates.map((t) => t.uriTemplate)));
let unread = 0;
for (const s of SKILLS_PACK.skills) for (const f of s.files) {
  const got = await c.readResource({ uri: `edgegap-skill://${s.name}/${f.path}` }).catch(() => undefined);
  if (got?.contents?.[0]?.text !== f.content) unread++;
}
check(`all ${totalFiles} bundled files read back unchanged`, unread === 0, `${unread} failed`);
const missing = await c.readResource({ uri: 'edgegap-skill://edgegap-unreal/nope.md' }).then(() => 'resolved', (e) => e.message);
check('an unknown file is refused and the real files are listed', /not a file in the edgegap-unreal skill/.test(missing) && /SKILL\.md/.test(missing), missing.slice(0, 120));
const dockerfile = SKILLS_PACK.skills.find((s) => s.name === 'edgegap-unreal').files.find((f) => f.path === 'assets/docker/Dockerfile');
const read = await c.readResource({ uri: 'edgegap-skill://edgegap-unreal/assets/docker/Dockerfile' });
check('reading a resource returns the file', read.contents[0].text === dockerfile.content);
// Unity YAML: the settings asset finds its script by the GUID in the .meta, so
// both must come through byte for byte, trailing spaces included.
const purrnet = SKILLS_PACK.skills.find((s) => s.name === 'edgegap-purrnet');
for (const path of ['assets/unity/EdgegapSettings.cs.meta', 'assets/unity/Resources/EdgegapSettings.asset']) {
  const res = (await c.readResource({ uri: `edgegap-skill://edgegap-purrnet/${path}` })).contents[0];
  check(`${path} is served as plain text, unchanged`, res.mimeType === 'text/plain' && res.text === purrnet.files.find((f) => f.path === path)?.content);
}
check('the settings asset and its .meta share the script GUID', (() => {
  const guid = purrnet.files.find((f) => f.path.endsWith('.cs.meta')).content.match(/guid: (\w+)/)[1];
  return purrnet.files.find((f) => f.path.endsWith('.asset')).content.includes(`guid: ${guid}`);
})());
check('markdown resources are typed text/markdown',skillRes.find((x) => x.uri === 'edgegap-skill://edgegap/SKILL.md')?.mimeType === 'text/markdown');
const ctx = JSON.parse(body(await c.callTool({ name: 'edgegap_context', arguments: {} })));
check('edgegap_context reports the skills pack', ctx.skills_pack?.startsWith(SKILLS_PACK.version));
check('server instructions point at the skills', /edgegap_get_skill/.test(c.getInstructions() ?? ''));
// Agents get the instructions on connect, and clients truncate long ones: the
// skills must be the first thing they read, and every link must resolve.
const instructions = c.getInstructions() ?? '';
check('instructions open with the skills line', instructions.startsWith('Before acting, read edgegap-skill://edgegap/SKILL.md'), instructions.slice(0, 80));
const linked = [...new Set(instructions.match(/edgegap-skill:\/\/[^\s),]+/g) ?? [])];
check('instructions link the core, Unity, NGO, FishNet, PurrNet, Fusion, Simple FPS, Unreal, EOS voice, Godot, Colyseus, Nakama, PlayFab, Three.js and Manus skills', ['edgegap', 'edgegap-unity', 'edgegap-ngo', 'edgegap-fishnet', 'edgegap-purrnet', 'edgegap-fusion', 'edgegap-manus', 'edgegap-unreal', 'edgegap-eos-voice', 'edgegap-fusion-simplefps', 'edgegap-godot', 'edgegap-colyseus', 'edgegap-nakama', 'edgegap-playfab', 'edgegap-threejs'].every((s) => linked.includes(`edgegap-skill://${s}/SKILL.md`)), linked.join(' '));
check('instructions point CI deploys at edgegap/deploy-action', /edgegap\/deploy-action/.test(instructions) && /edgegap-launch/.test(instructions));
// Claude Code cuts instructions at INSTRUCTIONS_MAX_CHARS; 0.15.1 lost its
// safety paragraphs that way. Shorten something before adding a skill line.
for (const mode of ['local', 'hosted']) {
  const text = serverInstructions(mode);
  check(`${mode} instructions fit in ${INSTRUCTIONS_MAX_CHARS} characters`, text.length <= INSTRUCTIONS_MAX_CHARS, `${text.length} characters`);
  const head = text.slice(0, INSTRUCTIONS_MAX_CHARS);
  check(`${mode} instructions keep the cost, guardrail and credential rules`, ['cost money while running', 'dry_run: true', 'org-wide', 'do not retry'].every((s) => head.includes(s)));
}
for (const uri of linked) {
  const got = await c.readResource({ uri }).catch(() => undefined);
  check(`linked resource ${uri} resolves`, Boolean(got?.contents?.[0]?.text?.includes('name: ')));
}
await c.close();

console.log('\nread-only mode');
const ro = await connect({ EDGEGAP_READ_ONLY: '1' });
const names = (await ro.listTools()).tools.map((x) => x.name);
check('skills tools are available in read-only mode', names.includes('edgegap_list_skills') && names.includes('edgegap_get_skill'));
await ro.close();

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
