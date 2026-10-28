/**
 * Which Edgegap skills pack is the latest, so the skill tools can say when
 * this server, or a copy of the skills on the developer's machine, is behind.
 *
 * Reads only version numbers from github.com/edgegap/llm-agent-skills, never
 * skill text: updated skills reach agents through this server's own release
 * (the bundle in src/skills.generated.ts) or the developer's package manager,
 * not through anything fetched at run time. Uses only fetch, so the hosted
 * Worker can run it too.
 */

import { SKILLS_PACK } from './skills.js';

/** The skills CLI version the updater runs, not whatever is newest on npm. */
export const SKILLS_CLI = 'skills@1.7.4';

/** raw.githubusercontent.com root of the skills repo's main branch. */
export const DEFAULT_SKILLS_RAW = 'https://raw.githubusercontent.com/edgegap/llm-agent-skills/main';

/** Skill names as the pack writes them; anything else is not looked up. */
export const SKILL_NAME_RE = /^edgegap(?:-[a-z0-9]+)*$/;

export interface SkillsCheckOptions {
  /** false turns every network check off (EDGEGAP_SKILLS_CHECK=off). */
  enabled: boolean;
  /** Repo root to read versions from. Tests point it at a local server. */
  rawBase: string;
  timeoutMs?: number;
}

/** Turns EDGEGAP_SKILLS_CHECK and EDGEGAP_SKILLS_RAW_URL into options. */
export function skillsCheckFromEnv(env: Record<string, string | undefined>): SkillsCheckOptions {
  const off = /^(0|off|false|no)$/i.test(env.EDGEGAP_SKILLS_CHECK?.trim() ?? '');
  const raw = env.EDGEGAP_SKILLS_RAW_URL?.trim();
  // Only https, or plain http to this machine for tests.
  const usable = raw && (/^https:\/\/[^/]+/.test(raw) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(raw));
  return { enabled: !off, rawBase: (usable ? raw : DEFAULT_SKILLS_RAW).replace(/\/+$/, '') };
}

/** -1, 0 or 1 for two X.Y.Z versions; anything unparseable sorts first. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : [-1, -1, -1]);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** metadata.version from a SKILL.md's frontmatter, e.g. `  version: "0.1.14"`. */
export function skillVersionOf(skillMd: string | undefined): string | undefined {
  const fm = skillMd?.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/)?.[1];
  const m = fm?.match(/^metadata:\s*\n(?:[ \t]+.*\n)*?[ \t]+version:\s*["']?(\d+\.\d+\.\d+)["']?\s*$/m);
  return m?.[1];
}

async function getText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
  return res.text();
}

export interface LatestPack {
  /** Latest pack version on GitHub, or undefined when it could not be read. */
  version?: string;
  /** Why version is undefined. */
  error?: string;
}

const CACHE_MS = 60 * 60 * 1000;
let packCache: { at: number; key: string; value: LatestPack } | undefined;

/** The pack version on GitHub main (.claude-plugin/plugin.json), cached for an hour. */
export async function latestPack(opts: SkillsCheckOptions): Promise<LatestPack> {
  if (!opts.enabled) return { error: 'the check is off (EDGEGAP_SKILLS_CHECK=off)' };
  if (packCache && packCache.key === opts.rawBase && Date.now() - packCache.at < CACHE_MS) return packCache.value;
  let value: LatestPack;
  try {
    const plugin = JSON.parse(await getText(`${opts.rawBase}/.claude-plugin/plugin.json`, opts.timeoutMs ?? 3_000)) as { version?: unknown };
    const v = typeof plugin.version === 'string' && /^\d+\.\d+\.\d+$/.test(plugin.version) ? plugin.version : undefined;
    value = v ? { version: v } : { error: 'plugin.json on GitHub has no X.Y.Z version' };
  } catch (err) {
    value = { error: `GitHub could not be reached (${(err as Error).message})` };
  }
  // Failures are cached too, so an offline machine pays the timeout once an hour, not per call.
  packCache = { at: Date.now(), key: opts.rawBase, value };
  return value;
}

/**
 * Latest version of each named skill: GitHub main where it answers, otherwise
 * the version bundled in this server. `source` says which.
 */
export async function latestSkillVersions(
  names: string[],
  opts: SkillsCheckOptions
): Promise<Record<string, { version?: string; source: 'github' | 'bundled' | 'unknown' }>> {
  const out: Record<string, { version?: string; source: 'github' | 'bundled' | 'unknown' }> = {};
  await Promise.all(
    [...new Set(names)].filter((n) => SKILL_NAME_RE.test(n)).map(async (name) => {
      const bundled = SKILLS_PACK.skills.find((s) => s.name === name)?.version;
      let remote: string | undefined;
      if (opts.enabled) {
        try {
          remote = skillVersionOf(await getText(`${opts.rawBase}/skills/${name}/SKILL.md`, opts.timeoutMs ?? 5_000));
        } catch {
          remote = undefined;
        }
      }
      if (remote && (!bundled || compareVersions(remote, bundled) >= 0)) out[name] = { version: remote, source: 'github' };
      else if (bundled) out[name] = { version: bundled, source: 'bundled' };
      else out[name] = { source: 'unknown' };
    })
  );
  return out;
}

/** What edgegap_list_skills and edgegap_get_skill say about the pack this server serves. */
export function servedPackStatus(latest: LatestPack, hosted: boolean): { latest_pack: string; served_is_latest?: boolean; update?: string } {
  if (!latest.version) return { latest_pack: `unknown: ${latest.error}` };
  const behind = compareVersions(SKILLS_PACK.version, latest.version) < 0;
  return {
    latest_pack: latest.version,
    served_is_latest: !behind,
    ...(behind
      ? {
          update: hosted
            ? `Pack ${latest.version} is on GitHub; this hosted server still serves ${SKILLS_PACK.version} until its next release. The skills served here are still correct to follow.`
            : `Pack ${latest.version} is on GitHub; this server bundles ${SKILLS_PACK.version}. A newer @edgegap/mcp may carry it: restart the server through npx -y @edgegap/mcp@latest, or update the Edgegap extension. The bundled skills are still correct to follow.`,
        }
      : {}),
  };
}

// Types for src/skillsinstall.ts, kept here so the Worker can name them without loading node:fs.

/** How a set of skills was installed. Each kind updates differently. */
export type InstallKind = 'skills-cli-global' | 'skills-cli-project' | 'claude-plugin' | 'copy';

export interface InstalledSkill {
  name: string;
  version?: string;
  /** Folder holding its SKILL.md. */
  dir: string;
}

export interface SkillsInstall {
  kind: InstallKind;
  /** Where, for people: "user-wide", "this project", a folder. */
  where: string;
  skills: InstalledSkill[];
}

/** Everything outside this module, so tests can replace it. */
export interface SkillsEnv {
  home: string;
  cwd: string;
  platform: string;
  readText: (path: string) => Promise<string | undefined>;
  writeText: (path: string, text: string) => Promise<void>;
  /** True when the path is a symlink or junction, or holds a .git folder. */
  isManaged: (dir: string) => Promise<boolean>;
  run: (cmd: string, args: string[], cwd: string) => Promise<string>;
}
