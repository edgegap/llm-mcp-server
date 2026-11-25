// Tool-list snapshot. Agents build against the tool names, descriptions and
// input schemas they last read, so a change to any of them is a change to the
// server's interface, even when no test breaks. This fails on any difference
// from test/tools.snapshot.json, so each one is made on purpose:
//
//   node test/snapshot.mjs           compare
//   node test/snapshot.mjs --update  rewrite the snapshot (commit it with the change)
//
// Covers normal and read-only mode, and the local server instructions.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const FILE = 'test/tools.snapshot.json';

async function read(extraEnv) {
  const c = new Client({ name: 'snapshot', version: '1.0.0' });
  await c.connect(new StdioClientTransport({
    command: 'node', args: ['dist/index.js'], stderr: 'ignore',
    env: { PATH: process.env.PATH, EDGEGAP_API_TOKEN: 'snapshot-fake-token', ...extraEnv },
  }));
  const { tools } = await c.listTools();
  const instructions = c.getInstructions();
  await c.close();
  return {
    instructions,
    tools: tools
      .map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const current = { normal: await read({}), read_only: { tools: (await read({ EDGEGAP_READ_ONLY: '1' })).tools.map((t) => t.name) } };
const text = JSON.stringify(current, null, 2) + '\n';

if (process.argv.includes('--update')) {
  writeFileSync(FILE, text);
  console.log(`\nWrote ${FILE}: ${current.normal.tools.length} tools, ${current.read_only.tools.length} in read-only mode.`);
  process.exit(0);
}

console.log('\ntool-list snapshot');
if (!existsSync(FILE)) {
  console.log(`  FAIL ${FILE} is missing. Run: node test/snapshot.mjs --update`);
  process.exit(1);
}
const saved = JSON.parse(readFileSync(FILE, 'utf8'));
const diffs = [];
const byName = (list) => Object.fromEntries(list.map((t) => [t.name, t]));
const a = byName(saved.normal.tools), b = byName(current.normal.tools);
for (const n of Object.keys(a)) if (!b[n]) diffs.push(`removed tool ${n}`);
for (const n of Object.keys(b)) if (!a[n]) diffs.push(`new tool ${n}`);
for (const n of Object.keys(b)) {
  if (!a[n]) continue;
  for (const k of ['title', 'description', 'inputSchema', 'outputSchema', 'annotations']) {
    if (JSON.stringify(a[n][k]) !== JSON.stringify(b[n][k])) diffs.push(`${n}: ${k} changed`);
  }
}
if (saved.normal.instructions !== current.normal.instructions) diffs.push('server instructions changed');
if (JSON.stringify(saved.read_only.tools) !== JSON.stringify(current.read_only.tools)) diffs.push('read-only tool list changed');

// Directory reviews (OpenAI's among them) ask every tool to state both hints
// explicitly; a read-only tool is never destructive.
for (const t of current.normal.tools) {
  const { readOnlyHint, destructiveHint } = t.annotations ?? {};
  if (typeof readOnlyHint !== 'boolean' || typeof destructiveHint !== 'boolean') diffs.push(`${t.name}: readOnlyHint and destructiveHint must both be set`);
  else if (readOnlyHint && destructiveHint) diffs.push(`${t.name}: a read-only tool cannot be destructive`);
}

// Anthropic's directory review: tools that change or remove existing data carry
// destructiveHint: true (create-only tools stay false).
const CHANGES_EXISTING = [
  'edgegap_update_app', 'edgegap_update_app_version', 'edgegap_tag_deployment', 'edgegap_link_pull_profile',
  'edgegap_stop_deployment', 'edgegap_delete_registry_tag', 'edgegap_delete_app_version', 'edgegap_delete_app',
  'edgegap_delete_pull_profile', 'edgegap_delete_endpoint_storage',
];
for (const name of CHANGES_EXISTING) {
  const t = current.normal.tools.find((x) => x.name === name);
  if (t && t.annotations?.destructiveHint !== true) diffs.push(`${name}: changes existing data, so destructiveHint must be true`);
}

// Directory reviews reject tool descriptions that promote products, quote prices
// or tell the model how to behave beyond the tool's function.
const PROMO = [/\$\d/, /recommended (way|setup)/i, /before acting/i, /free egress/i];
for (const t of current.normal.tools) {
  for (const re of PROMO) if (re.test(t.description ?? '')) diffs.push(`${t.name}: description matches ${re}`);
}

if (diffs.length) {
  for (const d of diffs) console.log(`  FAIL ${d}`);
  console.log('\nIf these changes are intended, run: node test/snapshot.mjs --update, and commit test/tools.snapshot.json.');
  process.exit(1);
}
console.log(`  ok   ${current.normal.tools.length} tools, ${current.read_only.tools.length} read-only, instructions unchanged`);
console.log('\nAll checks passed.');
