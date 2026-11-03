#!/usr/bin/env node
// Bundles the Edgegap agent skills (github.com/edgegap/llm-agent-skills)
// into src/skills.generated.ts, so the MCP server can serve them.
//
//   npm run sync-skills                      # the commit in scripts/skills-pin.txt
//   npm run sync-skills -- --ref main        # a newer branch, tag or commit; updates the pin
//   npm run sync-skills -- --from ../llm-agent-skills   # a local checkout, no network
//   npm run check-skills                     # exit 1 if the bundle differs from the pin
//
// Only skills/ is bundled: the evals, fixtures and CI scripts are for working
// on the pack, not for agents. The generated file is committed, so building
// the server never needs the network.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

const REPO = 'https://github.com/edgegap/llm-agent-skills';
const PIN = 'scripts/skills-pin.txt';
const OUT = 'src/skills.generated.ts';
const TEXT_EXT = /\.(md|cs|h|cpp|json|ini|xml|txt|yml|yaml|meta|asset|ts|js|mjs|sh|gd|cfg|go|html|css|sql|patch|snippet)$|(^|\/)(Dockerfile|\.dockerignore|\.funcignore|\.gitattributes|\.gitignore|\.env\.example|go\.mod|go\.sum)$/;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const check = args.includes('--check');
const from = flag('--from');
const ref = flag('--ref') ?? readFileSync(PIN, 'utf8').trim();

function die(message) {
  console.error(`sync-skills: ${message}`);
  process.exit(1);
}

// ------------------------------------------------------------ checkout ----
let root = from;
let tmp;
if (!root) {
  tmp = mkdtempSync(join(tmpdir(), 'edgegap-skills-'));
  root = tmp;
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  execFileSync('git', ['clone', '--quiet', '--filter=blob:none', REPO, root], { stdio: 'inherit' });
  git('checkout', '--quiet', ref);
}
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();

// ------------------------------------------------------------- parsing ----
/** The frontmatter fields the pack uses: name, a one-line description
 *  (plain, single- or double-quoted), and metadata.version. */
function frontmatter(text, file) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) die(`${file}: no frontmatter`);
  const fields = {};
  let inMetadata = false;
  for (const line of m[1].split(/\r?\n/)) {
    if (/^metadata:\s*$/.test(line)) { inMetadata = true; continue; }
    const kv = line.match(/^(\s*)([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, indent, key, raw] = kv;
    if (!indent) inMetadata = false;
    let value = raw.trim();
    if (value.startsWith("'")) {
      if (!/'$/.test(value) || value.length < 2) die(`${file}: ${key} must be a single-line quoted value`);
      value = value.slice(1, -1).replace(/''/g, "'");
    } else if (value.startsWith('"')) {
      value = JSON.parse(value);
    }
    fields[inMetadata && indent ? `metadata.${key}` : key] = value;
  }
  for (const required of ['name', 'description']) {
    if (!fields[required]) die(`${file}: frontmatter has no ${required}`);
  }
  return fields;
}

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const skillsDir = join(root, 'skills');
const plugin = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
const skills = readdirSync(skillsDir)
  .filter((d) => statSync(join(skillsDir, d)).isDirectory())
  .sort()
  .map((dir) => {
    const base = join(skillsDir, dir);
    const files = walk(base)
      .map((full) => relative(base, full).split(sep).join('/'))
      .sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)));
    if (!files.includes('SKILL.md')) die(`${dir}: no SKILL.md`);
    const nonText = files.filter((f) => !TEXT_EXT.test(f));
    if (nonText.length) die(`${dir}: unexpected non-text files ${nonText.join(', ')}. Add the extension to TEXT_EXT if they are text.`);
    const skillMd = readFileSync(join(base, 'SKILL.md'), 'utf8');
    const fm = frontmatter(skillMd, `${dir}/SKILL.md`);
    if (fm.name !== dir) die(`${dir}/SKILL.md: name "${fm.name}" does not match its folder`);
    return {
      name: fm.name,
      description: fm.description,
      version: fm['metadata.version'] ?? plugin.version,
      files: files.map((path) => ({
        path,
        content: readFileSync(join(base, path), 'utf8').replace(/\r\n/g, '\n'),
      })),
    };
  });
if (tmp) rmSync(tmp, { recursive: true, force: true });

// -------------------------------------------------------------- output ----
const pack = { version: plugin.version, commit, source: REPO, skills };
const generated =
  '// GENERATED by scripts/sync-skills.mjs from ' + `${REPO} at ${commit}.\n` +
  '// Do not edit: change the skills in that repo, then run `npm run sync-skills`.\n' +
  "import type { SkillsPack } from './skills.js';\n\n" +
  `export const SKILLS_PACK: SkillsPack = ${JSON.stringify(pack, null, 2)};\n`;

if (check) {
  let current = '';
  try { current = readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n'); } catch {}
  if (current !== generated) die(`${OUT} does not match ${REPO} at ${commit}. Run npm run sync-skills.`);
  console.log(`sync-skills: ${OUT} matches pack ${plugin.version} (${commit.slice(0, 7)}).`);
  process.exit(0);
}

writeFileSync(OUT, generated);
writeFileSync(PIN, commit + '\n');
const bytes = skills.reduce((n, s) => n + s.files.reduce((m, f) => m + f.content.length, 0), 0);
console.log(`sync-skills: bundled ${skills.length} skills, ${skills.reduce((n, s) => n + s.files.length, 0)} files, ` +
  `${Math.round(bytes / 1024)} KB, pack ${plugin.version} at ${commit.slice(0, 7)}.`);
