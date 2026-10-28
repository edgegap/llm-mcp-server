/**
 * Finds the copies of the Edgegap skills installed on this machine and updates
 * them. Local (stdio) server only: it reads the developer's home and project
 * folders and can run their package managers, which neither the hosted Worker
 * nor a self-hosted container can or should do.
 *
 * Updates come from two places only: the developer's own package manager (the
 * skills CLI, `claude plugin update`), or the files bundled in this release of
 * @edgegap/mcp. Skill text is never downloaded here.
 */

import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { SKILLS_PACK } from './skills.js';
import { SKILLS_CLI, SKILL_NAME_RE, compareVersions, skillVersionOf } from './skillsversion.js';
import type { InstallKind, InstalledSkill, SkillsEnv, SkillsInstall } from './skillsversion.js';

export type { InstallKind, InstalledSkill, SkillsEnv, SkillsInstall };

export function defaultSkillsEnv(): SkillsEnv {
  return {
    home: homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    readText: (path) => readFile(path, 'utf8').catch(() => undefined),
    writeText: async (path, text) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, 'utf8');
    },
    isManaged: async (dir) => {
      const link = await lstat(dir).then((s) => s.isSymbolicLink()).catch(() => false);
      const git = await lstat(join(dir, '.git')).then(() => true).catch(() => false);
      return link || git;
    },
    run: (cmd, args, cwd) =>
      new Promise((resolvePromise, reject) => {
        // npx and claude are .cmd shims on Windows, which only start through a
        // shell. Every argument here is a fixed flag or a name matching
        // SKILL_NAME_RE, so nothing reaches the shell that could be parsed.
        const win = process.platform === 'win32';
        const child = execFile(
          cmd,
          args,
          {
            cwd,
            shell: win,
            env: { ...updaterEnv(process.env), NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
            timeout: 120_000,
            killSignal: 'SIGKILL',
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
          },
          (err, stdout, stderr) => {
            const out = `${stdout}${stderr}`.replace(/\x1b\[[0-9;?]*[A-Za-z]|\r/g, '').trim();
            if (err) reject(new Error(`${cmd} ${args.join(' ')} failed: ${err.message}\n${out}`));
            else resolvePromise(out);
          }
        );
        // A prompting CLI fails at once on a closed stdin instead of hanging until the timeout.
        child.stdin?.end();
      }),
  };
}

// What the updaters need to find node, npm and their config, and to get out
// through a proxy. Nothing else: the Edgegap token and any other secret in
// this server's environment must not reach a package manager it starts.
const UPDATER_ENV = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|TEMP|TMP|TMPDIR|USER|USERNAME|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TZ|XDG_[A-Z_]+|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|NPM_CONFIG_[A-Z_]+|CLAUDE_CONFIG_DIR)$/i;
const SECRET_NAME = /token|secret|passw|key|auth|credential|cookie|session/i;

/** The allowlisted part of env, minus EDGEGAP_* and anything named like a secret. */
export function updaterEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || !UPDATER_ENV.test(k) || /^EDGEGAP_/i.test(k) || SECRET_NAME.test(k)) continue;
    out[k] = v;
  }
  return out;
}

const SOURCE_RE = /^(https:\/\/github\.com\/|git@github\.com:|github:)?edgegap\/(llm-agent-skills|edgegap-agent-skills)(\.git)?\/?$/i;
// The skills CLI keeps one copy in .agents/skills when it installs for several
// agents, and copies into the agent's own folder when it installs for one.
const SKILL_DIRS = ['.agents/skills', '.claude/skills', '.codex/skills', '.cursor/skills', '.config/opencode/skills'];
const PLUGIN_ID = 'edgegap@edgegap';

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Skill names a skills CLI lock file records as coming from the Edgegap skills repo. */
function namesInLock(text: string | undefined): string[] {
  const lock = parseJson(text) as { skills?: Record<string, { source?: string; sourceUrl?: string }> } | undefined;
  return Object.entries(lock?.skills ?? {})
    .filter(([name, s]) => SKILL_NAME_RE.test(name) && (SOURCE_RE.test(s?.source ?? '') || SOURCE_RE.test(s?.sourceUrl ?? '')))
    .map(([name]) => name)
    .sort();
}

/** The oldest copy of a skill under root's skill folders, so one stale copy still counts. */
async function readCopies(env: SkillsEnv, root: string, name: string): Promise<InstalledSkill | undefined> {
  let oldest: InstalledSkill | undefined;
  for (const d of SKILL_DIRS) {
    const dir = join(root, d, name);
    const text = await env.readText(join(dir, 'SKILL.md'));
    if (text === undefined) continue;
    const version = skillVersionOf(text);
    if (!oldest || (version && (!oldest.version || compareVersions(version, oldest.version) < 0))) oldest = { name, version, dir };
  }
  return oldest;
}

async function cliInstall(env: SkillsEnv, kind: InstallKind, where: string, lockPath: string, root: string): Promise<SkillsInstall | undefined> {
  const names = namesInLock(await env.readText(lockPath));
  if (names.length === 0) return undefined;
  const skills = await Promise.all(names.map(async (n) => (await readCopies(env, root, n)) ?? { name: n, dir: join(root, SKILL_DIRS[0], n) }));
  return { kind, where, skills };
}

async function pluginInstall(env: SkillsEnv): Promise<SkillsInstall | undefined> {
  const registry = parseJson(await env.readText(join(env.home, '.claude', 'plugins', 'installed_plugins.json'))) as
    | { plugins?: Record<string, Array<{ installPath?: string }>> }
    | undefined;
  const installPath = registry?.plugins?.[PLUGIN_ID]?.[0]?.installPath;
  if (!installPath) return undefined;
  const skills: InstalledSkill[] = [];
  for (const s of SKILLS_PACK.skills) {
    const dir = join(installPath, 'skills', s.name);
    const text = await env.readText(join(dir, 'SKILL.md'));
    if (text !== undefined) skills.push({ name: s.name, version: skillVersionOf(text), dir });
  }
  return { kind: 'claude-plugin', where: `Claude Code plugin ${PLUGIN_ID}`, skills };
}

/** Skills copied by hand into an agent's skills folder: no lock file, no plugin. */
async function copiedSkills(env: SkillsEnv, root: string, where: string, claimed: Set<string>): Promise<SkillsInstall[]> {
  const found: SkillsInstall[] = [];
  for (const d of SKILL_DIRS) {
    const skills: InstalledSkill[] = [];
    for (const s of SKILLS_PACK.skills) {
      const dir = join(root, d, s.name);
      if (claimed.has(dir)) continue;
      const text = await env.readText(join(dir, 'SKILL.md'));
      // Only the Edgegap skill of that name, not someone's own skill that reuses it.
      if (text === undefined || !text.includes(`name: ${s.name}`)) continue;
      skills.push({ name: s.name, version: skillVersionOf(text), dir });
    }
    if (skills.length) found.push({ kind: 'copy', where: `${where} ${join(root, d)}`, skills });
  }
  return found;
}

/** Every install of the Edgegap skills this server can see: user-wide, this project, and the Claude Code plugin. */
export async function findSkillsInstalls(env: SkillsEnv): Promise<SkillsInstall[]> {
  const managed = (
    await Promise.all([
      cliInstall(env, 'skills-cli-global', 'skills CLI, user-wide', join(env.home, '.agents', '.skill-lock.json'), env.home),
      cliInstall(env, 'skills-cli-project', 'skills CLI, this project', join(env.cwd, 'skills-lock.json'), env.cwd),
      pluginInstall(env),
    ])
  ).filter((i): i is SkillsInstall => i !== undefined);
  // A skills CLI install writes into the same folders as a hand copy; count it once.
  const claimed = new Set<string>();
  for (const i of managed) {
    for (const s of i.skills) {
      for (const root of [env.home, env.cwd]) for (const d of SKILL_DIRS) claimed.add(join(root, d, s.name));
    }
  }
  const copies = [
    ...(await copiedSkills(env, env.home, 'copied user-wide into', claimed)),
    ...(resolve(env.cwd) !== resolve(env.home) ? await copiedSkills(env, env.cwd, 'copied into this project,', claimed) : []),
  ];
  return [...managed, ...copies];
}

/** The commands that update a managed install, as argv lists. Copies have none. */
export function updateCommands(install: SkillsInstall, outdated: string[]): string[][] {
  const names = outdated.filter((n) => SKILL_NAME_RE.test(n));
  switch (install.kind) {
    case 'skills-cli-global':
      return [['npx', '-y', SKILLS_CLI, 'update', ...names, '-g', '-y']];
    case 'skills-cli-project':
      return [['npx', '-y', SKILLS_CLI, 'update', ...names, '-p', '-y']];
    case 'claude-plugin':
      return [
        ['claude', 'plugin', 'marketplace', 'update', 'edgegap'],
        ['claude', 'plugin', 'update', PLUGIN_ID],
      ];
    case 'copy':
      return [];
  }
}

/**
 * Rewrites a hand-copied skill from the files bundled in this release. Files
 * the developer added are left alone. Refused for symlinks and git checkouts:
 * those are someone's working copy, not an install.
 */
export async function replaceFromBundle(env: SkillsEnv, skill: InstalledSkill): Promise<string> {
  const bundled = SKILLS_PACK.skills.find((s) => s.name === skill.name);
  if (!bundled) throw new Error(`${skill.name} is not in the bundled pack`);
  if (await env.isManaged(skill.dir)) {
    throw new Error(`${skill.dir} is a symlink or a git checkout, so it was left alone; update it with git`);
  }
  const root = resolve(skill.dir);
  for (const f of bundled.files) {
    const target = resolve(root, ...f.path.split('/'));
    if (!target.startsWith(root + sep)) throw new Error(`refused to write outside ${root}: ${f.path}`);
    await env.writeText(target, f.content);
  }
  return `${skill.name} ${skill.version ?? '?'} → ${bundled.version} (${bundled.files.length} files from @edgegap/mcp's bundle)`;
}
