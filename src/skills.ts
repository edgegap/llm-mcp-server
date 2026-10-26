/**
 * The Edgegap agent skills, served by this MCP server.
 *
 * The skills (github.com/edgegap/llm-agent-skills) are the workflows,
 * templates and pitfalls an agent needs to take a game from "works on my
 * machine" to matched players on a dedicated server. Serving them here means
 * every agent connected to Edgegap MCP has them, whether or not it can install
 * SKILL.md skills itself.
 *
 * They are bundled at build time (src/skills.generated.ts, written by
 * scripts/sync-skills.mjs at the commit pinned in scripts/skills-pin.txt), so
 * the server needs no network or file system to serve them — the Cloudflare
 * Worker has neither — and each release names exactly which skills it carries.
 */

export interface SkillFile {
  /** Relative to the skill folder, "/"-separated, e.g. "references/deploy.md". */
  path: string;
  content: string;
}

export interface Skill {
  name: string;
  description: string;
  version: string;
  /** SKILL.md first, then the rest in path order. */
  files: SkillFile[];
}

export interface SkillsPack {
  version: string;
  commit: string;
  source: string;
  skills: Skill[];
}

import { SKILLS_PACK } from './skills.generated.js';

export { SKILLS_PACK };

export function findSkill(name: string): Skill | undefined {
  return SKILLS_PACK.skills.find((s) => s.name === name);
}

/**
 * Exact match on a bundled path only. Nothing is read from disk, and a path
 * that is not in the bundle — "../x", an absolute path, a typo — is simply
 * not found, so there is no traversal to defend against.
 */
export function findSkillFile(skill: Skill, path = 'SKILL.md'): SkillFile | undefined {
  const wanted = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return skill.files.find((f) => f.path === wanted);
}

/** "edgegap-skill://edgegap-unity/references/deploy.md" */
export function skillUri(skill: string, path: string): string {
  return `edgegap-skill://${skill}/${path}`;
}

export function mimeType(path: string): string {
  if (path.endsWith('.md')) return 'text/markdown';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.cs')) return 'text/x-csharp';
  if (/\.(h|cpp)$/.test(path)) return 'text/x-c++src';
  if (path.endsWith('.xml')) return 'application/xml';
  if (/\.(ts|mjs)$/.test(path)) return 'text/javascript';
  if (path.endsWith('.html')) return 'text/html';
  if (path.endsWith('.css')) return 'text/css';
  return 'text/plain';
}

/**
 * Files bundled for completeness but of no use to an agent: Unity .meta
 * files hold asset GUIDs. They stay in the bundle, because a project that
 * copies the templates needs them next to their assets (and
 * edgegap_update_skills rewrites hand-copied skills from the bundle), but they
 * are never listed: an agent shown one tends to read it, and one session read
 * EdgegapSettings.cs.meta 14 times. Still readable by exact path.
 */
export function isListable(path: string): boolean {
  return !path.endsWith('.meta');
}

/** The skill's other files, so an agent knows what it can fetch next. */
export function fileIndex(skill: Skill): string[] {
  return skill.files.filter((f) => f.path !== 'SKILL.md' && isListable(f.path)).map((f) => f.path);
}
