/**
 * Configuration and safety gates.
 *
 * Everything here exists to keep the blast radius of an autonomous agent small.
 * The Edgegap API token is org-wide, so the server layers its own limits on top.
 */

export interface Config {
  /** Token from the environment, if supplied. Absent means "ask the developer". */
  envToken?: string;
  baseUrlV1: string;
  baseUrlV2: string;
  /** When true, every mutating tool is hidden from the agent entirely. */
  readOnly: boolean;
  /** If non-empty, tools refuse to touch applications outside this list. */
  appAllowlist: string[];
  /** Ceiling on max_duration (minutes) the agent may request. */
  maxDurationCeiling: number;
  /** Most agent-tagged deployments running at once before deploy refuses; 0 = no cap. */
  maxAgentDeployments: number;
  /** Deploys this process may send in its lifetime; 0 or absent = no cap. Local only: the hosted server keeps no state between requests. */
  maxDeploysPerRun?: number;
  /** When true, edgegap_stop_deployment refuses deployments without the agent tag. */
  stopOwnOnly?: boolean;
  /** When true, edgegap_update_skills may run the skills CLI or claude to update installs. */
  enableSkillsUpdate?: boolean;
  /** Timeout for a single HTTP call, ms. */
  requestTimeoutMs: number;
  /** "local" for the stdio server, "hosted" for the Worker and HTTP server. */
  transport: 'local' | 'hosted';
}

/** Edgegap's production API. A base URL naming this host must be exactly it. */
export const DEFAULT_API_HOST = 'api.edgegap.com';

/**
 * Validates EDGEGAP_BASE_URL and returns it without a trailing slash.
 *
 * The token travels in a header to whatever host this names, so a typo or a
 * plain-http URL is a credential leak, not a misconfiguration. A URL naming
 * Edgegap's own host must be https; anything else is labelled "custom" on
 * every tool result (see hostLabel) so it cannot go unnoticed.
 */
export function parseBaseUrl(raw: string | undefined): string {
  const value = raw?.trim() || `https://${DEFAULT_API_HOST}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`EDGEGAP_BASE_URL "${value}" is not a valid URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`EDGEGAP_BASE_URL must be an http(s) URL, not ${url.protocol}`);
  }
  if (url.hostname === DEFAULT_API_HOST && (url.protocol !== 'https:' || url.port !== '')) {
    throw new ConfigError(
      `EDGEGAP_BASE_URL names ${DEFAULT_API_HOST} but is not https://${DEFAULT_API_HOST}. ` +
        'The API token would be sent unencrypted or to the wrong port. Use https.'
    );
  }
  if (url.username || url.password) {
    throw new ConfigError('EDGEGAP_BASE_URL must not contain a username or password.');
  }
  return value.replace(/\/+$/, '');
}

/** "api.edgegap.com", or "custom · <host>" when EDGEGAP_BASE_URL points elsewhere. */
export function hostLabel(config: Pick<Config, 'baseUrlV1'>): string {
  const host = new URL(config.baseUrlV1).host;
  return host === DEFAULT_API_HOST ? host : `custom · ${host}`;
}

export class ConfigError extends Error {}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env
): Config {
  // The one-click install (manifest.json) fills these from its settings; a
  // value left as an unexpanded "${user_config.x}" placeholder means not set.
  env = Object.fromEntries(Object.entries(env).filter(([, v]) => !/^\$\{user_config\.[a-z_]+\}$/.test(v ?? '')));

  // A token in the environment is optional. When it is absent the server asks
  // the developer for one at first use, which removes the "configure before
  // anything works" step that loses people during onboarding.
  const raw = env.EDGEGAP_API_TOKEN?.trim();

  // Tokens are pasted by hand often enough that it is worth catching the
  // common mistake of including the "token " prefix, once or more.
  const envToken = raw ? stripTokenPrefix(raw) || undefined : undefined;

  return {
    envToken,
    baseUrlV1: parseBaseUrl(env.EDGEGAP_BASE_URL),
    baseUrlV2: parseBaseUrl(env.EDGEGAP_BASE_URL) + '/v2',
    transport: 'local',
    readOnly: env.EDGEGAP_READ_ONLY === '1' || env.EDGEGAP_READ_ONLY === 'true',
    appAllowlist: parseList(env.EDGEGAP_APP_ALLOWLIST),
    maxDurationCeiling: parseIntEnv(env.EDGEGAP_MAX_DURATION_MINUTES, 60),
    maxAgentDeployments: parseIntEnv(env.EDGEGAP_MAX_AGENT_DEPLOYMENTS, 5),
    maxDeploysPerRun: parseIntEnv(env.EDGEGAP_MAX_DEPLOYS_PER_RUN, 20),
    stopOwnOnly: env.EDGEGAP_STOP_OWN_ONLY === '1' || env.EDGEGAP_STOP_OWN_ONLY === 'true',
    enableSkillsUpdate: env.EDGEGAP_ENABLE_SKILLS_UPDATE === '1' || env.EDGEGAP_ENABLE_SKILLS_UPDATE === 'true',
    requestTimeoutMs: parseIntEnv(env.EDGEGAP_TIMEOUT_MS, 30_000),
  };
}

/**
 * Throws if the agent is reaching for an application it was not scoped to.
 * No allowlist configured means no restriction.
 */
export function assertAppAllowed(config: Config, appName: string): void {
  if (config.appAllowlist.length === 0) return;
  if (!config.appAllowlist.includes(appName)) {
    throw new Error(
      `Application "${appName}" is not in EDGEGAP_APP_ALLOWLIST. ` +
        `Allowed: ${config.appAllowlist.join(', ')}. ` +
        `This server is scoped deliberately; ask the human to widen the ` +
        `allowlist rather than trying another application name.`
    );
  }
}

/**
 * Removes any run of "Bearer " / "token " prefixes from a pasted credential.
 *
 * The prefix gets doubled easily: the dashboard shows the header form
 * ("token <uuid>"), so an EDGEGAP_API_TOKEN that already carries it, dropped
 * into a config that adds "token " again, sends "token token <uuid>". Stripping
 * only one left "token <uuid>", which the hosted server then mistook for a
 * foreign credential and refused with a misleading message.
 */
export function stripTokenPrefix(value: string): string {
  return value.trim().replace(/^(?:(?:bearer|token)\s+)+/i, '').trim();
}

/**
 * Strips the live token out of text before it reaches the model.
 * Error strings from HTTP layers sometimes echo request headers back.
 */
export function redact(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join('<redacted-token>');
}
