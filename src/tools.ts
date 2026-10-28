/**
 * The golden-path tools: getting a server image right and into a registry,
 * deploying it as an authoritative dedicated server, matching players into it,
 * and — for games built host-client — relays as the alternative.
 *
 * Tool descriptions are written for a coding agent, not a human reading docs.
 * Each one says when to reach for it and what to call next, because the main
 * failure mode in agent flows is not a bad call, it is a call made out of order.
 */

import { z } from 'zod';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EdgegapClient, EdgegapApiError, DeploymentStatus, RelaySession, PlannedRequest, AppVersionRecord, MetricSeries, maskSecrets } from './client.js';
import { Config, assertAppAllowed, redact, hostLabel } from './config.js';
import { VERSION } from './version.js';
import { TokenSource, TokenUnavailableError } from './auth.js';
import {
  validateServerConfig,
  PROTOCOLS,
  NETCODE_NAMES,
} from './serverconfig.js';
import { generateDockerfile, DockerfileInputError } from './dockerfile.js';
import { buildMatchmakerConfig, DASHBOARD_URL } from './matchmaker.js';
import { badImage, badTag, ENCRYPTED_PLACEHOLDER, isEncryptedPlaceholder, looksSecret, TAG_FIX } from './image.js';
import { OUTPUT } from './outputs.js';
import { finishReport, codeForStatus, type CallMeta, type ErrorCode, type ToolCallReport } from './callreport.js';
import { SKILLS_PACK, findSkill, findSkillFile, fileIndex, mimeType, skillUri } from './skills.js';
import {
  SKILLS_CLI,
  SKILL_NAME_RE,
  compareVersions,
  latestPack,
  latestSkillVersions,
  servedPackStatus,
  skillsCheckFromEnv,
  type SkillsCheckOptions,
} from './skillsversion.js';
import type { SkillsEnv, SkillsInstall, InstalledSkill } from './skillsversion.js';

/**
 * The one definition of "dedicated server vs relay" this server gives agents.
 * Used in the server instructions, the relay tool description, and every relay
 * result, so the recommendation cannot drift between them.
 *
 * Agents left alone tend to pick relays because they need no server image.
 * That optimises the agent's effort, not the developer's game, so the default
 * here is the authoritative server and relays need a stated reason.
 */
export const ARCHITECTURE_GUIDANCE =
  'Dedicated server vs relay — recommend a dedicated server by default.\n' +
  '- Dedicated (authoritative) server (edgegap_deploy): Edgegap runs the headless server ' +
  'build, and the server owns the game state. No player has host advantage, cheating is ' +
  'much harder, the match survives any player leaving, every player is one hop from the ' +
  'server, and performance does not depend on a player\'s PC or home connection.\n' +
  '- Relay (edgegap_create_relay_session): NOT a game server. Edgegap only forwards traffic ' +
  'between players; one player\'s game is the host and owns the state. The host can cheat ' +
  'and has zero latency while everyone else has two hops, the host\'s machine and upload ' +
  'bandwidth cap the match, and the match ends when the host quits unless the game ' +
  'implements host migration.\n' +
  'Use a relay only when the developer explicitly wants peer-to-peer/host-client, or the ' +
  'game\'s netcode is already built as a listen server and moving to a dedicated server is ' +
  'not an option. "It needs no server image" is not a reason: edgegap_generate_dockerfile ' +
  'removes most of that work. If unsure, ask the developer before choosing a relay.';

/**
 * Server instructions, shared by the local server and the hosted Worker so
 * both give agents the same golden path. Only the credential paragraph differs.
 */
export function serverInstructions(mode: 'local' | 'hosted'): string {
  const credentials =
    mode === 'local'
      ? 'Credentials: if no token was configured, the first tool call asks the developer for one. '
      : 'Credentials: the token comes from the Authorization header on this connection. ';
  // The skills line comes first, on purpose. Clients truncate or skim long
  // instructions, and in 0.5.0 it sat 1,259 characters in, below the
  // architecture guidance, where reviewers and agents missed it.
  return (
    `Before acting, read ${skillUri('edgegap', 'SKILL.md')} ` +
    `(Unity: ${skillUri('edgegap-unity', 'SKILL.md')}, ` +
    `Unity with NGO: ${skillUri('edgegap-ngo', 'SKILL.md')}, ` +
    `Unity with FishNet: ${skillUri('edgegap-fishnet', 'SKILL.md')}, ` +
    `Unity with PurrNet: ${skillUri('edgegap-purrnet', 'SKILL.md')}, ` +
    `Unity with Photon Fusion: ${skillUri('edgegap-fusion', 'SKILL.md')}, ` +
    `Photon's Simple FPS sample: ${skillUri('edgegap-fusion-simplefps', 'SKILL.md')}, ` +
    `Unreal Engine: ${skillUri('edgegap-unreal', 'SKILL.md')}, ` +
    `voice chat in an Unreal game: ${skillUri('edgegap-eos-voice', 'SKILL.md')}, ` +
    `Godot 4 with a Godot server: ${skillUri('edgegap-godot', 'SKILL.md')}, ` +
    `Colyseus server: ${skillUri('edgegap-colyseus', 'SKILL.md')}, ` +
    `Nakama backend: ${skillUri('edgegap-nakama', 'SKILL.md')}, ` +
    `PlayFab Matchmaking: ${skillUri('edgegap-playfab', 'SKILL.md')}, ` +
    `Three.js or other browser game with its own Node.js server: ${skillUri('edgegap-threejs', 'SKILL.md')}, ` +
    `browser game built with Manus: ${skillUri('edgegap-manus', 'SKILL.md')}, ` +
    `designing matchmaking, parties, regions or backfill: ${skillUri('edgegap-matchmaking', 'SKILL.md')}). ` +
    'If your client cannot read MCP resources, call edgegap_get_skill with the skill name ' +
    '(edgegap, edgegap-unity, edgegap-ngo, edgegap-fishnet, edgegap-purrnet, edgegap-fusion, edgegap-fusion-simplefps, edgegap-unreal, edgegap-eos-voice, edgegap-godot, edgegap-colyseus, edgegap-nakama, edgegap-playfab, edgegap-threejs, edgegap-manus or edgegap-matchmaking) instead. ' +
    'These Edgegap skills hold the tested workflow, templates and known pitfalls; follow them over general knowledge. ' +
    'edgegap_list_skills lists all of them.\n\n' +
    'Host multiplayer games on Edgegap. The recommended setup is an authoritative dedicated ' +
    'server per match; relays exist for games built host-client.\n\n' +
    ARCHITECTURE_GUIDANCE +
    '\n\n' +
    'Golden path for a first dedicated-server deployment:\n' +
    '1. edgegap_generate_dockerfile if the project has no Dockerfile, or ' +
    'edgegap_validate_server_config on the one it has, before building\n' +
    '2. edgegap_get_registry_credentials, then docker build --platform linux/amd64 and push\n' +
    '3. edgegap_list_registry_tags to confirm the push landed\n' +
    '4. edgegap_list_apps, then edgegap_create_app if no suitable application exists\n' +
    '5. edgegap_create_app_version to register the image\n' +
    '6. edgegap_deploy to start a server near the players\n' +
    '7. edgegap_wait_for_deployment to get the connection address\n' +
    '8. edgegap_stop_deployment when finished\n' +
    'To match players into those servers, edgegap_build_matchmaker_config produces the ' +
    'config the developer uploads in the dashboard.\n' +
    'For every later build, suggest CI over repeating steps 2-7 by hand: the GitHub Action ' +
    'edgegap/deploy-action creates the version from an existing one, smoke-tests it on a real ' +
    'deployment and promotes it (details in the edgegap-launch skill). Do not write Deploy API ' +
    'code for a CI job that only ships a build.\n\n' +
    'Deployments and relay sessions cost money while running. Stop deployments and delete ' +
    'relay sessions you created before ending the task; edgegap_list_deployments with ' +
    `only_agent_deployments: true lists every deployment tagged "${AGENT_TAG}". If a ` +
    'deployment errors, read the container logs before redeploying.\n\n' +
    'Guardrails: edgegap_context shows which API and limits this session has. Every tool that ' +
    'changes something takes dry_run: true to show the exact request and send nothing; use it ' +
    'when unsure. Never put the API token in env vars, tags or URLs: such calls are refused.\n\n' +
    credentials +
    'That token is org-wide and cannot be scoped by Edgegap, so it authorises far more than ' +
    'any single task needs. Treat it as a supervised credential: do not use it for work the ' +
    'developer did not ask for, do not enumerate or modify unrelated applications, and do ' +
    'not repeat operations against it to explore what is possible. If the developer declines ' +
    'to provide a token, stop and report which operation needed it — do not retry.'
  );
}

/** 1x1 transparent PNG. The create-app endpoint requires an image and agents
 *  have no sensible one to supply; a placeholder beats a blocked flow. */
const PLACEHOLDER_IMAGE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Port protocols, uppercased. The API accepts "WS" but returns "Websocket". */
const WS_PROTOCOLS = new Set(['WS', 'WEBSOCKET']);
/** tls_upgrade is only valid on WebSocket and HTTP ports (per the API spec). */
const TLS_PROTOCOLS = new Set(['WS', 'WEBSOCKET', 'HTTP']);

const TERMINAL_OK = ['READY', 'STATUS_READY'];
const TERMINAL_BAD = ['ERROR', 'STATUS_ERROR', 'TERMINATED', 'STATUS_TERMINATED'];

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  /** The same payload as the JSON text, for clients that read structured results. */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  /** For the analytics report only; removed before the result is returned. */
  meta?: CallMeta;
};

/** Attaches analytics facts to a result. See src/callreport.ts. */
function withMeta(result: ToolResult, meta: CallMeta): ToolResult {
  return {
    ...result,
    meta: {
      ...result.meta,
      ...meta,
      props: { ...result.meta?.props, ...meta.props },
      hash: { ...result.meta?.hash, ...meta.hash },
      milestones: [...(result.meta?.milestones ?? []), ...(meta.milestones ?? [])],
    },
  };
}

/** JSON.stringify replacer: null fields are left out, like undefined ones. The
 *  API sends many (fqdn before a deployment is placed, unset error_detail), and
 *  an absent field reads the same to an agent at fewer tokens. */
const dropNulls = (_key: string, value: unknown) => (value === null ? undefined : value);

function ok(payload: unknown, notice?: string): ToolResult {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload, dropNulls, 2);
  const structured =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (JSON.parse(body) as Record<string, unknown>)
      : undefined;
  return {
    content: [{ type: 'text', text: notice ? `${body}\n\nNOTE: ${notice}` : body }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/**
 * Strips the API token from a whole result, success or failure. Errors were
 * already redacted at the source; this covers anything the API echoes back in
 * a successful response, and any text a tool builds from it.
 */
function scrubToken(result: ToolResult, token: string | undefined): ToolResult {
  if (!token || token.length < 8) return result;
  const needles = [token, token.replace(/-/g, '')].filter((n, i, all) => n.length >= 8 && all.indexOf(n) === i);
  const clean = (text: string) => needles.reduce((t, n) => redact(t, n), text);
  const hit = (text: string) => needles.some((n) => text.includes(n));
  const structuredText = result.structuredContent ? JSON.stringify(result.structuredContent) : '';
  if (!result.content.some((c) => hit(c.text)) && !hit(structuredText)) return result;
  return {
    ...result,
    content: result.content.map((c) => ({ ...c, text: clean(c.text) })),
    ...(result.structuredContent ? { structuredContent: JSON.parse(clean(structuredText)) } : {}),
  };
}

function fail(message: string, code?: ErrorCode): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true, ...(code ? { meta: { code } } : {}) };
}

/**
 * An empty or "not set up" state, reported as a normal result with the next
 * action. Agents recover from "there is nothing here yet, do X" far better
 * than from an error, and stop retrying a call that already did its job.
 */
function emptyState(
  status: 'empty' | 'not_configured' | 'not_found' | 'not_ready' | 'expired',
  payload: Record<string, unknown>,
  nextStep: string
): ToolResult {
  return withMeta(ok({ status, ...payload, next_step: nextStep }), { props: { result_state: status } });
}

/**
 * What a 404 means, per kind of resource. A 404 from Edgegap only says "not
 * found"; which thing is missing, and what to do next, depends on the tool.
 * One generic hint used to be attached to every 404, which sent agents to
 * edgegap_list_apps for stopped deployments and missing registry images.
 */
const NOT_FOUND = {
  app:
    'the application or version name does not exist. Call edgegap_list_apps, then ' +
    'edgegap_list_app_versions, to find the right names.',
  deployment:
    'no deployment with that request_id. It may have stopped and been cleaned up, or the ' +
    'request_id is wrong. Running deployments are listed by edgegap_list_deployments.',
  logs:
    'no logs for this deployment. Container logs only exist while a deployment is running; ' +
    'once it has stopped they are gone, unless Endpoint Storage was configured on the version ' +
    'before it ran. If it is still running, check the request_id with edgegap_list_deployments.',
  relay: 'no relay session with that session_id. It may already have been deleted.',
} as const;

/**
 * What a 403 means, per kind of resource. The API's own text is a bare "You
 * are not authorized to access this resource", which reads like a bad token
 * and sends agents to ask for a new one. A rejected token is a 401; a 403 is
 * a token that works but may not use this feature.
 */
const FORBIDDEN = {
  relay:
    'the token is valid, but this organization cannot use relays. Relays are not enabled on ' +
    'every plan or account; check the Relays page in the dashboard (https://app.edgegap.com) ' +
    'or ask Edgegap support. A new token will not help. Consider a dedicated server ' +
    '(edgegap_deploy) instead.',
  generic:
    'the token is valid, but this organization may not use this feature or resource. It may ' +
    'not be enabled on the plan, or the resource belongs to another organization. A new token ' +
    'will not help; check the feature in the dashboard (https://app.edgegap.com) or ask the developer.',
} as const;

/** Wraps a handler so API errors come back as readable, self-correctable text
 *  rather than a protocol-level exception the agent cannot act on. */
function guard(
  auth: TokenSource,
  fn: () => Promise<ToolResult>,
  notFound?: string,
  forbidden?: string
): Promise<ToolResult> {
  const handled = fn().catch((err: unknown): ToolResult => {
    if (err instanceof TokenUnavailableError) {
      // Not a failure to correct — a decision the human made. Say so plainly
      // so the agent stops rather than looping on the same tool.
      const code: ErrorCode =
        err.reason === 'foreign' ? 'AUTH_FOREIGN' : err.reason === 'declined' ? 'AUTH_DECLINED' : 'AUTH_ABSENT';
      return fail(err.message, code);
    }
    if (err instanceof EdgegapApiError) {
      const hint = errorHint(err, notFound, forbidden);
      const details = apiDetails(err.details, auth.current);
      return withMeta(fail(`${err.message}${details ? `\n${details}` : ''}${hint ? `\n\nLikely cause: ${hint}` : ''}`), {
        code: codeForStatus(err.status, notFoundCode(notFound), forbidden === FORBIDDEN.relay ? 'NO_RELAY_ACCESS' : undefined, err.apiMessage),
        stage: 'upstream',
      });
    }
    const message = redact((err as Error).message ?? String(err), auth.current);
    return fail(message, /timed out after/.test(message) ? 'TIMEOUT' : /Network error calling/.test(message) ? 'NETWORK' : 'INTERNAL');
  });

  // The org-wide-scope reminder is attached to whichever call first used a
  // freshly supplied token, success or failure. A developer who just handed
  // over a credential should hear about its blast radius even if the call
  // they were making went on to fail.
  return handled.then((result) => {
    const notice = auth.current ? auth.consumeFirstUseNotice() : undefined;
    if (!notice) return result;
    return {
      ...result,
      content: [...result.content, { type: 'text' as const, text: `NOTE: ${notice}` }],
    };
  });
}

/** guard() with the 404 hint first, so it reads at the call site. */
function guarded(
  auth: TokenSource,
  notFound: string,
  fn: () => Promise<ToolResult>
): Promise<ToolResult> {
  return guard(auth, fn, notFound, notFound === NOT_FOUND.relay ? FORBIDDEN.relay : undefined);
}

/** The error code for a tool's 404 hint. */
function notFoundCode(notFound: string | undefined): ErrorCode | undefined {
  switch (notFound) {
    case NOT_FOUND.app: return 'APP_NOT_FOUND';
    case NOT_FOUND.deployment: return 'DEPLOYMENT_NOT_FOUND';
    case NOT_FOUND.logs: return 'LOGS_NOT_FOUND';
    case NOT_FOUND.relay: return 'RELAY_NOT_FOUND';
    default: return undefined;
  }
}

/**
 * The API's own field-level validation detail, when it sends one, so the
 * agent can fix the call instead of guessing (a duplicate version name, an
 * invalid port). Secrets masked, capped at 600 characters.
 */
function apiDetails(details: unknown, token: string | undefined): string | undefined {
  if (details === undefined || details === null || details === '') return undefined;
  const text = redact(typeof details === 'string' ? details : JSON.stringify(maskSecrets(details, token)), token);
  if (!text || text === '{}' || text === '[]') return undefined;
  return `Details: ${text.length > 600 ? `${text.slice(0, 600)}…` : text}`;
}

/** Plan or quota wording in an API error, so the hint can say which limit. */
const QUOTA = /quota|limit reached|exceed|upgrade your plan|plan limit|maximum number/i;

function errorHint(err: EdgegapApiError, notFound?: string, forbidden?: string): string | undefined {
  if (QUOTA.test(err.apiMessage) && [400, 402, 403, 429].includes(err.status)) {
    return (
      'a plan or quota limit was reached (the message above names it). Retrying will not help. ' +
      'Stop deployments that are no longer needed (edgegap_list_deployments only_agent_deployments: true), ' +
      'or ask the developer to raise the limit on the Billing page of the dashboard (https://app.edgegap.com).'
    );
  }
  switch (err.status) {
    case 401:
      // Deliberately does not promise a re-prompt: the local server asks again
      // on the next call, the hosted relay cannot, and a hint that lies about
      // what happens next sends the developer looking in the wrong place.
      return (
        'Edgegap rejected the token. It may be expired, revoked, or from a ' +
        'different organization. Check it at ' +
        'https://app.edgegap.com/user-settings?tab=tokens. The token has been ' +
        'discarded from this session.'
      );
    case 400:
      // The deployment endpoints answer an unknown request_id with 400 ("Bad
      // Request ID provided", or a generic "could not understand" for logs),
      // not 404. Their only input is the request_id, so a 400 means that.
      return notFound === NOT_FOUND.deployment || notFound === NOT_FOUND.logs ? notFound : undefined;
    case 403:
      return forbidden ?? FORBIDDEN.generic;
    case 404:
      // Only the tool knows what was not found; no hint beats a wrong one.
      return notFound;
    case 429:
      return 'Edgegap rate-limited this token. Wait a few seconds before the next call, and do not retry in a loop.';
    case 409:
      return 'a resource with that name already exists. Pick a different name or reuse the existing one.';
    case 422:
      // require_cached_locations on a version without force_cache (live, 2026-10-28).
      if (/caching disabled|enable caching/i.test(err.apiMessage)) {
        return (
          'require_cached_locations needs image caching on the version. Turn it on with edgegap_update_app_version ' +
          'force_cache: true and wait for caching_percent (edgegap_get_app_version) to rise, or deploy without ' +
          'require_cached_locations.'
        );
      }
      return 'Edgegap could not allocate a server for the requested location or resources. Try different user coordinates, or lower cpu_units/memory_mb.';
    case 424:
      return 'Edgegap could not pull the container image. Check docker_repository, docker_image, docker_tag, and registry credentials.';
    default:
      return undefined;
  }
}

/**
 * Builds the count fields for a paginated list.
 *
 * The API's total_count is the total across all pages, not the number of rows
 * returned. Reporting it alone makes a truncated page look complete, and an
 * agent that believes it has the full list will confidently tell a developer
 * their application does not exist. When the page is short, say so and say
 * what to do about it.
 */
function pageInfo(totalCount: number | undefined, returned: number, page: number) {
  const total = totalCount ?? returned;
  if (total <= returned) return { total };
  return {
    total,
    showing: returned,
    truncated: true,
    next_step: `Only page ${page} is shown. Call again with page: ${page + 1} ` +
      `(or raise limit) to see the rest before concluding something is missing.`,
  };
}

/** Trims a deployment status down to what an agent needs to act. */
/** The last `cap` characters of a deployment's container logs, or undefined
 *  if there are none or they cannot be read. Never throws. */
async function logTail(client: EdgegapClient, requestId: string, cap: number): Promise<string | undefined> {
  try {
    const res = await client.getDeploymentLogs(requestId);
    const text = [res.logs, res.crash_logs].filter(Boolean).join('\n');
    if (!text.trim()) return undefined;
    return text.length > cap ? `...[truncated]...\n${text.slice(-cap)}` : text;
  } catch {
    return undefined;
  }
}

/**
 * Stop is idempotent: stopping a deployment that has already stopped, or that
 * Edgegap no longer knows, leaves nothing running, which is what was asked.
 * Returns the success payload in that case, or undefined to report the error.
 * An unknown request_id cannot be told apart from a cleaned-up one (both are a
 * 400 or 404), so the result says so instead of claiming it was stopped.
 */
async function alreadyStopped(client: EdgegapClient, requestId: string, err: unknown) {
  if (!(err instanceof EdgegapApiError) || ![400, 404, 409, 410].includes(err.status)) return undefined;
  let status: DeploymentStatus;
  try {
    status = await client.getDeployment(requestId);
  } catch (statusErr) {
    if (statusErr instanceof EdgegapApiError && [400, 404].includes(statusErr.status)) {
      return {
        request_id: requestId,
        result: 'not_running',
        note:
          'Edgegap has no running deployment with this request_id: it already stopped and was ' +
          'cleaned up, or the request_id is wrong. Nothing is left to stop. If you expected it ' +
          'to be running, check edgegap_list_deployments.',
      };
    }
    return undefined;
  }
  const current = (status.current_status ?? '').toUpperCase();
  if (status.running && !current.includes('TERMINAT')) return undefined;
  return {
    request_id: requestId,
    result: 'already_stopped',
    status: status.current_status,
    note: 'This deployment was already stopped or stopping. Nothing more to do.',
  };
}

function compactDeployment(d: DeploymentStatus) {
  const ports = Object.entries(d.ports ?? {}).map(([key, p]) => ({
    name: p.name ?? key,
    connect: p.link,
    external: p.external,
    internal: p.internal,
    protocol: p.protocol,
  }));
  return {
    request_id: d.request_id,
    status: d.current_status,
    running: d.running,
    error: d.error || undefined,
    error_detail: d.error_detail || undefined,
    fqdn: d.fqdn,
    public_ip: d.public_ip,
    application: d.app_name,
    version: d.app_version,
    location: d.location
      ? [d.location.city, d.location.country].filter(Boolean).join(', ')
      : undefined,
    elapsed_seconds: d.elapsed_time,
    ports,
  };
}

/** The version fields every version tool shows. Never the registry token. */
function compactVersion(v: AppVersionRecord) {
  const ref = [v.docker_repository, v.docker_image].filter(Boolean).join('/');
  return {
    name: v.name,
    active: v.is_active,
    image: v.docker_tag ? `${ref}:${v.docker_tag}` : ref,
    // Whether a login is set, never the login itself: the API returns the
    // registry token in version responses.
    registry_credentials_set: Boolean(v.private_username && v.private_token),
    cpu_units: v.req_cpu,
    memory_mb: v.req_memory,
    max_duration_minutes: v.max_duration,
    ports: v.ports?.map((p) => ({
      name: p.name,
      port: p.port,
      protocol: p.protocol,
      tls_upgrade: p.tls_upgrade ?? false,
    })),
  };
}

/** Reduces "registry.edgegap.com/<project>/img:tag" to the image path the
 *  registry endpoints take. The project is stripped later only on a 404,
 *  because nested image names are valid. */
function imageNameOnly(input: string): string {
  const parts = input.trim().replace(/@sha256:.*$/, '').split('/');
  if (parts.length > 1 && /[.:]/.test(parts[0])) parts.shift();
  parts[parts.length - 1] = parts[parts.length - 1].replace(/:[^:]*$/, '');
  return parts.join('/');
}

/** Latest, average and peak of one metrics series, plus its labels. */
function summarizeSeries(series: MetricSeries | undefined) {
  const values = (series?.datasets ?? []).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (values.length === 0) return undefined;
  const round = (x: number) => Math.round(x * 100) / 100;
  return {
    latest: round(values[values.length - 1]),
    average: round(values.reduce((a, b) => a + b, 0) / values.length),
    peak: round(Math.max(...values)),
    samples: values.length,
    labels: series?.labels?.length ? [...new Set(series.labels)].slice(0, 5) : undefined,
    from: series?.timestamps?.[0],
    to: series?.timestamps?.[series.timestamps.length - 1],
  };
}

const userSchema = z
  .object({
    ip_addresses: z
      .array(z.string())
      .optional()
      .describe('Public IPv4/IPv6 addresses of the players. Edgegap places the server near them.'),
    geo_coordinates: z
      .array(z.object({ latitude: z.number(), longitude: z.number() }))
      .optional()
      .describe('Latitude/longitude pairs, as an alternative to IP addresses.'),
  })
  .describe('Where the players are. Exactly one of these two is required.');

function buildUsers(input: z.infer<typeof userSchema>) {
  const users: Array<{ user_type: string; user_data: Record<string, unknown> }> = [];
  for (const ip of input.ip_addresses ?? []) {
    users.push({ user_type: 'ip_address', user_data: { ip_address: ip } });
  }
  for (const geo of input.geo_coordinates ?? []) {
    users.push({
      user_type: 'geo_coordinates',
      user_data: { latitude: geo.latitude, longitude: geo.longitude },
    });
  }
  return users;
}

// ================================================================ guardrails ====

/**
 * Added to every deployment this server starts, whatever tags the caller
 * passes, so agent deployments can always be found and cleaned up:
 * edgegap_list_deployments with only_agent_deployments: true.
 */
export const AGENT_TAG = 'edgegap-mcp';

/**
 * A single Edgegap request_id ("61b1be8f54d9"). Anything else — empty, a
 * wildcard, a list, whitespace — is refused before a stop is sent, so a stop
 * can only ever hit the one deployment it names.
 */
const REQUEST_ID = /^[A-Za-z0-9]{6,64}$/;
/** A single relay session_id, e.g. "0724828881e2-S". */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{4,63}$/;

function checkRequestId(id: string): ToolResult | undefined {
  if (REQUEST_ID.test(id)) return undefined;
  return fail(
    `"${id.slice(0, 80)}" is not a single request_id. Pass exactly one request_id, e.g. "61b1be8f54d9", ` +
      'as returned by edgegap_deploy or edgegap_list_deployments. Wildcards, lists and empty IDs ' +
      'are refused, and there is no bulk stop.'
  );
}

/** Refuses an empty, wildcard or list-like name where one exact name is required. */
function exactName(name: string, what: string): ToolResult | undefined {
  if (name.trim() === name && name.length > 0 && !/[*?,\s]/.test(name)) return undefined;
  return fail(`"${name.slice(0, 80)}" is not one exact ${what} name. Pass a single name; wildcards and lists are refused.`);
}

/** The dry_run parameter every write tool takes. */
const dryRunParam = z
  .boolean()
  .optional()
  .describe(
    'Show the exact request (method, host, path, body) with secrets masked, and send nothing. ' +
      'Local checks still run. Use it to confirm a billable or destructive call before making it.'
  );

function dryRunResult(requests: PlannedRequest[], notes: string[] = []): ToolResult {
  return ok({
    dry_run: true,
    sent: false,
    requests,
    notes: notes.length ? notes : undefined,
    next_step: 'Nothing was sent. Call again without dry_run to do it.',
  });
}

/**
 * Refuses to put the server's own API token into a container or a URL.
 *
 * Env vars, tags and webhook URLs end up in places the agent and other people
 * can read — container environments, the dashboard, third-party endpoints. An
 * agent that "helpfully" passes the token along (say, so the game server can
 * call the API) would hand an org-wide credential to all of them. Nothing is
 * sent when this fires, and the matching value is never echoed.
 *
 * Returns undefined when clean. In a dry run the token is only checked if this
 * session already holds one: a dry run must not trigger the token prompt.
 */
/**
 * Refuses a registry login or env value that is the API's stand-in for a
 * stored secret: it shows up when an agent copies an existing version's
 * settings, and sent back it overwrites the real secret.
 */
function encryptedPlaceholder(
  fields: Array<[label: string, value: string | undefined]>,
  keepHint: string
): ToolResult | undefined {
  const hits = fields.filter(([, v]) => isEncryptedPlaceholder(v)).map(([label]) => label);
  if (hits.length === 0) return undefined;
  return fail(
    `Refused: ${hits.join(', ')} ${hits.length > 1 ? 'are' : 'is'} "${ENCRYPTED_PLACEHOLDER}". Nothing was sent. ` +
      'That is the placeholder the Edgegap API returns instead of a stored secret, not the secret ' +
      'itself; saved, it replaces the real value and image pulls fail with "Unable to login". ' +
      'Copy only non-secret settings (image, resources, ports, non-secret env vars) from an ' +
      'existing version. The registry login comes from the dashboard\'s Container Registry page ' +
      `(${DASHBOARD_URL}) for registry.edgegap.com, or from the developer for any other registry; ` +
      `secret env values come from the developer. ${keepHint}`
  );
}

async function tokenLeak(
  auth: TokenSource,
  dryRun: boolean | undefined,
  fields: Array<[label: string, value: string | undefined]>
): Promise<ToolResult | undefined> {
  const token = dryRun ? auth.current : await auth.get();
  if (!token) return undefined;
  const needles = [token, token.replace(/-/g, '')].filter((n) => n.length >= 16);
  const hit = fields.find(([, v]) => v && needles.some((n) => v.toLowerCase().includes(n.toLowerCase())));
  if (!hit) return undefined;
  return fail(
    `Refused: ${hit[0]} contains this server's Edgegap API token. Nothing was sent. ` +
      'The token is organization-wide; putting it in a container, tag or URL exposes it to ' +
      'everything that can read those. If the game server needs to call Edgegap, give it a ' +
      'separate, purpose-made credential, and never this one.'
  );
}

const WEBHOOKS = ['webhook_on_ready', 'webhook_on_error', 'webhook_on_terminated'] as const;

/** Why a deploy webhook URL is refused: Edgegap would POST deployment details to it. */
export function webhookProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `"${raw.slice(0, 80)}" is not a URL.`;
  }
  if (url.protocol !== 'https:') return 'must be an https URL: Edgegap sends deployment details (IP, ports) to it.';
  if (url.username || url.password) return 'must not contain a username or password.';
  return undefined;
}

/**
 * How long a new deployment can run before Edgegap stops it, from the
 * version's max_duration. The API takes no per-deployment limit, so this is
 * the only bound there is, and the agent should hear it on every deploy.
 */
function autoStop(maxDuration: number | undefined): Record<string, unknown> {
  if (maxDuration === undefined || maxDuration === null) {
    return { auto_stop: 'unknown: the version did not report max_duration. Stop this deployment when done.' };
  }
  if (maxDuration <= 0) {
    return {
      auto_stop: 'none',
      warning:
        'This version has no max_duration, so the deployment runs and bills until it is stopped. ' +
        'Stop it with edgegap_stop_deployment when done, or give the version a max_duration.',
    };
  }
  const hours = maxDuration >= 120 ? ` (${Math.round(maxDuration / 60)} hours)` : '';
  return {
    auto_stop_after_minutes: maxDuration,
    ...(maxDuration > 60
      ? {
          warning:
            `Edgegap stops this deployment after ${maxDuration} minutes${hours}, the version's ` +
            'max_duration. Stop it yourself when done testing; versions created with ' +
            'edgegap_create_app_version are capped by EDGEGAP_MAX_DURATION_MINUTES instead.',
        }
      : {}),
  };
}

/**
 * Rewrites the SDK's "Input validation error: Invalid arguments for tool X:
 * a: Invalid input: expected string, received undefined, b: ..." into one line
 * per argument, plus the tool's required and optional parameters, so the agent
 * can fix the call in one try. Undefined for any other message.
 */
export function argumentError(message: string, inputs: Map<string, Record<string, z.ZodType>>): string | undefined {
  const m = message.match(/Input validation error: Invalid arguments for tool (\S+?): ([\s\S]*)$/);
  if (!m) return undefined;
  const [, toolName, detail] = m;
  // Two wordings: SDK v1 (local) "expected string, received number at application",
  // one per line; SDK v2 (hosted) "application: expected string, received number",
  // comma-joined.
  const problems = detail
    .split('\n')
    .flatMap((line) => line.split(/,\s+(?=[\w.[\]]+: )/))
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const v2 = p.match(/^([\w.[\]]+): (?:Invalid input: )?expected (\w+), received (\w+)$/);
      const v1 = p.match(/^(?:Invalid input: )?expected (\w+), received (\w+) at ([\w.[\]]+)$/);
      const [field, want, got] = v2 ? [v2[1], v2[2], v2[3]] : v1 ? [v1[3], v1[1], v1[2]] : [];
      if (!field) return `- ${p}`;
      return got === 'undefined' ? `- ${field}: missing (required)` : `- ${field}: must be ${want} (got ${got})`;
    });
  const shape = inputs.get(toolName) ?? {};
  const required = Object.keys(shape).filter((k) => !shape[k].safeParse(undefined).success);
  const optional = Object.keys(shape).filter((k) => !required.includes(k));
  return (
    `Invalid arguments for ${toolName}. Nothing was sent.\n${problems.join('\n')}\n\n` +
    `Required: ${required.join(', ') || 'none'}.` +
    (optional.length ? ` Optional: ${optional.join(', ')}.` : '') +
    ' Fix the arguments and call again.'
  );
}

/** Prepends "[api.edgegap.com]" (or "[custom · host]") to a tool result. */
function withHost(result: ToolResult, label: string): ToolResult {
  return { ...result, content: [{ type: 'text', text: `[${label}]` }, ...result.content] };
}

/**
 * The local server's access to the skills installed on this machine. Only
 * src/index.ts passes it, so the hosted Worker never loads node:fs or
 * node:child_process.
 */
export interface LocalSkills {
  env: SkillsEnv;
  findSkillsInstalls: (env: SkillsEnv) => Promise<SkillsInstall[]>;
  updateCommands: (install: SkillsInstall, outdated: string[]) => string[][];
  replaceFromBundle: (env: SkillsEnv, skill: InstalledSkill) => Promise<string>;
}

export interface RegisterOptions {
  /** Where the skills version check reads from. Default: from the environment. */
  skillsCheck?: SkillsCheckOptions;
  /** The local stdio server only. */
  localSkills?: LocalSkills;
  /**
   * Called once per tool call with what it did (src/callreport.ts). Only the
   * hosted Worker passes it, for analytics; nothing else is told.
   */
  onToolCall?: (report: ToolCallReport) => void | Promise<void>;
}

export function registerTools(
  server: McpServer,
  client: EdgegapClient,
  config: Config,
  auth: TokenSource,
  options: RegisterOptions = {}
): void {
  const mutating = !config.readOnly;
  // Deploys sent by this server instance; see EDGEGAP_MAX_DEPLOYS_PER_RUN.
  let deploysSent = 0;

  // Every result names the API host it came from, first, so a session pointed
  // at a custom EDGEGAP_BASE_URL can never be mistaken for production.
  const label = hostLabel(config);
  // ...and never carries the API token, whatever the API echoed back.
  const inputs = new Map<string, Record<string, z.ZodType>>();
  // The API statuses a call caused are the entries it added to client.upstream.
  // Concurrent calls on one server would share entries; that only happens on
  // the local server, which has no onToolCall. The list is cleared whenever no
  // call is running, so it cannot grow.
  const onToolCall = options.onToolCall;
  let inFlight = 0;
  const tool = ((name: string, def: unknown, cb: (...a: unknown[]) => Promise<ToolResult>) => {
    inputs.set(name, ((def as { inputSchema?: Record<string, z.ZodType> }).inputSchema) ?? {});
    return server.registerTool(name, def as never, (async (...a: unknown[]) => {
      const startedAt = Date.now();
      const from = client.upstream.length;
      inFlight++;
      let result: ToolResult;
      try {
        result = withHost(scrubToken(await cb(...a), auth.current), label);
      } finally {
        inFlight--;
      }
      const { meta, ...clean } = result;
      if (onToolCall) {
        const extra = a.find((x): x is { requestId?: string | number } => !!x && typeof x === 'object' && 'requestId' in x);
        const args = a[0] && typeof a[0] === 'object' && a[0] !== extra ? (a[0] as Record<string, unknown>) : {};
        try {
          await onToolCall(
            finishReport({
              tool: name,
              requestId: extra?.requestId,
              isError: clean.isError === true,
              text: clean.content.map((c) => c.text).join('\n'),
              token: auth.current,
              args,
              meta,
              upstream: client.upstream.slice(from),
              latencyMs: Date.now() - startedAt,
              dryRun: args.dry_run === true,
            })
          );
        } catch {
          // Analytics never changes a result.
        }
      }
      if (inFlight === 0) client.upstream.length = 0;
      return clean;
    }) as never);
  }) as unknown as typeof server.registerTool;

  // Errors the SDK raises itself (bad arguments, a handler that throws) skip
  // the wrapper above. Both SDK versions route them through createToolError,
  // so give those the same host label and token scrub, and turn argument
  // errors into a list the agent can act on.
  const sdk = server as unknown as { createToolError?: (message: string) => ToolResult };
  const sdkToolError = sdk.createToolError?.bind(server);
  if (sdkToolError) {
    sdk.createToolError = (message: string) => {
      const friendly = argumentError(message, inputs);
      const result = withHost(scrubToken(friendly ? fail(friendly) : sdkToolError(message), auth.current), label);
      // Rejected by the SDK before any handler ran: bad arguments or an unknown tool.
      const named = message.match(/(?:Invalid arguments for tool|Tool) (\S+?):? /);
      if (onToolCall && named) {
        Promise.resolve(
          onToolCall(
            finishReport({
              tool: named[1],
              isError: true,
              text: result.content.map((c) => c.text).join('\n'),
              token: auth.current,
              meta: { code: /not found/.test(message) ? 'NOT_FOUND' : 'VALIDATION_FAILED', stage: 'pre_flight' },
              upstream: [],
              latencyMs: 0,
            })
          )
        ).catch(() => {});
      }
      return result;
    };
  }

  // ---------------------------------------------------------------- 0 ----
  // No token, no network: describes this server's own configuration, so an
  // agent can check where it is pointed and what is allowed before acting.
  tool(
    'edgegap_context',
    {
      title: 'Show this Edgegap MCP server\'s configuration',
      description:
        'Report which Edgegap API this server talks to, its version, whether it is the local or ' +
        'hosted server, and the guardrails in force: read-only mode, application allowlist, ' +
        'max_duration ceiling, the agent deployment cap, the tag forced onto every deployment, and which tools support ' +
        'dry_run. Also says whether this session has a usable token and, if not, why and how to fix it. Call it ' +
        'first when unsure what this session is allowed to do, before anything billable, or when tool calls fail ' +
        'with a token problem. Makes no API call unless check_token is true, and never shows the token.',
      inputSchema: {
        check_token: z
          .boolean()
          .optional()
          .describe('Make one read-only API call (list one application) to confirm Edgegap accepts the token. Default false.'),
      },
      outputSchema: OUTPUT.context,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ check_token }) => {
      const hosted = config.transport === 'hosted';
      const tokenStatus = await describeToken(client, auth, hosted, check_token === true);
      return withMeta(ok({
        server: `@edgegap/mcp ${VERSION}`,
        transport: hosted ? 'hosted (Streamable HTTP)' : 'local (stdio)',
        api_host: label,
        api_base_url: config.baseUrlV1,
        token: hosted
          ? auth.current
            ? 'received on this request\'s Authorization header'
            : 'none on this request: send it as an Authorization header'
          : config.envToken
            ? 'from EDGEGAP_API_TOKEN'
            : auth.current
              ? 'provided by the developer this session (memory only)'
              : 'not yet provided: the developer is asked on first use',
        token_scope: 'organization-wide (Edgegap cannot scope tokens)',
        token_status: tokenStatus,
        read_only: config.readOnly,
        app_allowlist: config.appAllowlist.length ? config.appAllowlist : 'none (all applications)',
        max_duration_ceiling_minutes: config.maxDurationCeiling,
        max_agent_deployments: config.maxAgentDeployments > 0 ? config.maxAgentDeployments : 'no cap',
        max_deploys_per_run: hosted ? 'n/a (hosted: no state between requests)' : (config.maxDeploysPerRun ?? 0) > 0 ? config.maxDeploysPerRun : 'no cap',
        stop_own_only: config.stopOwnOnly === true,
        ...(hosted ? {} : { skills_updaters_enabled: config.enableSkillsUpdate === true }),
        skills_pack: `${SKILLS_PACK.version} (${SKILLS_PACK.commit.slice(0, 7)}), ${SKILLS_PACK.skills.length} skills`,
        forced_deploy_tag: AGENT_TAG,
        guardrails: {
          dry_run: mutating
            ? 'every write tool: deploy, stop, tag and report deployments, create/update/delete apps and versions, delete_registry_tag, endpoint storage and pull profiles, relays'
            : 'n/a: read-only, no write tools are registered',
          token_in_container: 'deploys and versions are refused if the API token appears in an env var, tag or webhook URL',
          image_tags: 'versions on "latest", an empty or malformed tag, or a docker_image holding a registry or tag are refused; so is deploying a version on "latest"',
          deployment_cap: config.maxAgentDeployments > 0
            ? `deploy is refused while ${config.maxAgentDeployments} or more agent-tagged deployments are running`
            : 'off (EDGEGAP_MAX_AGENT_DEPLOYMENTS=0)',
          secret_env: 'env vars named like secrets (TOKEN, SECRET, PASSWORD, API_KEY...) are sent hidden',
          stop: config.stopOwnOnly
            ? `one exact request_id per call; no bulk stop; only deployments tagged "${AGENT_TAG}" (EDGEGAP_STOP_OWN_ONLY)`
            : 'one exact request_id per call; no bulk stop',
          auto_stop: 'each deploy reports its version\'s max_duration; Edgegap has no per-deployment time limit',
          long_running: `deploying a version whose max_duration is unlimited or above ${config.maxDurationCeiling} minutes needs allow_long_running: true`,
          deletes: 'one exact app or version per call; refused while its deployments run; an app with versions needs max_versions',
          results: `every result starts with [${label}]`,
        },
        user_agent: `edgegap-mcp/${VERSION} (<MCP client name>)`,
        works_without_token: TOKENLESS_TOOLS,
      }), { props: { token_state: String(tokenStatus.state) } });
    }
  );

  // ---------------------------------------------------------------- 1 ----
  tool(
    'edgegap_list_apps',
    {
      title: 'List Edgegap applications',
      description:
        'List the applications in the Edgegap organization. Start here before creating or ' +
        'deploying anything, so you reuse an existing application instead of making a duplicate. ' +
        'An "application" groups versions of one game server.',
      inputSchema: {
        limit: z.number().int().optional().describe('Results per page, 1-100. Default 50.'),
        page: z.number().int().optional(),
      },
      outputSchema: OUTPUT.listApps,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit, page }) =>
      guard(auth, async () => {
        const p = clamp(page, 1, 100_000, 1);
        const res = await client.listApps({ limit: clamp(limit, 1, 100, 50), page: page === undefined ? undefined : p });
        const apps = (res.applications ?? []).map((a) => ({
          name: a.name,
          active: a.is_active,
          last_updated: a.last_updated,
        }));
        if (apps.length === 0 && p === 1) {
          return emptyState(
            'empty',
            { total: 0, applications: [] },
            'This organization has no applications yet. Create one with edgegap_create_app (usually named after ' +
              'the game), then register the server image with edgegap_create_app_version.'
          );
        }
        const info = pageInfo(res.total_count, apps.length, p);
        return withMeta(
          ok({
            ...info,
            applications: apps,
            ...('next_step' in info
              ? {}
              : {
                  next_step:
                    'Reuse the application that matches this game: edgegap_list_app_versions shows its versions. ' +
                    'Only if none fits, create one with edgegap_create_app.',
                }),
          }),
          { props: { item_count: apps.length }, milestones: ['app_created'] }
        );
      })
  );

  // ---------------------------------------------------------------- 2 ----
  if (mutating) {
    tool(
      'edgegap_create_app',
      {
        title: 'Create an Edgegap application',
        description:
          'Create a new application to hold game server versions. Only call this after ' +
          'edgegap_list_apps confirms no suitable application exists. Creating an application ' +
          'does not deploy anything — follow with edgegap_create_app_version.',
        inputSchema: {
          name: z
            .string()
            .min(3)
            .max(64)
            .describe('Application name, 3-64 chars. Usually the game or project name.'),
          is_active: z.boolean().optional().describe('Whether deployments are allowed. Default true.'),
          dry_run: dryRunParam,
        },
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ name, is_active, dry_run }) =>
        guard(auth, async () => {
          assertAppAllowed(config, name);
          const body = { name, is_active: is_active ?? true, image: PLACEHOLDER_IMAGE };
          if (dry_run) {
            const dry = client.dryRun();
            await dry.client.createApp(body);
            return dryRunResult(dry.requests);
          }
          const res = await client.createApp(body);
          return withMeta(
            ok({
              created: res.name,
              active: res.is_active,
              next_step: 'Call edgegap_create_app_version to attach a container image.',
            }),
            { milestones: ['app_created'] }
          );
        })
    );
  }

  // --------------------------------------------------------------- 2b ----
  if (mutating) {
    tool(
      'edgegap_update_app',
      {
        title: 'Turn an application on or off',
        description:
          'Set whether an application accepts new deployments. Turning it off stops new ' +
          'deployments of every version under it; running deployments keep running. Use it to ' +
          'pause an application without deleting anything.',
        inputSchema: {
          application: z.string().describe('Application name.'),
          is_active: z.boolean().describe('false blocks new deployments; true allows them again.'),
          dry_run: dryRunParam,
        },
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ application, is_active, dry_run }) =>
        guarded(auth, NOT_FOUND.app, async () => {
          assertAppAllowed(config, application);
          const body = { is_active };
          if (dry_run) {
            const dry = client.dryRun();
            await dry.client.updateApp(application, body);
            return dryRunResult(dry.requests);
          }
          const res = await client.updateApp(application, body);
          return ok({ application: res.name ?? application, active: res.is_active ?? is_active });
        })
    );
  }

  // ---------------------------------------------------------------- 3 ----
  tool(
    'edgegap_list_app_versions',
    {
      title: 'List versions of an application',
      description:
        'List the versions under an application, with their container image, resources, ports ' +
        '(including whether TLS Upgrade is on, which browser/WebGL clients need for wss://) and ' +
        'whether a registry login is set for pulling the image. Use this to find the version ' +
        'name to deploy, to check a version is ready before deploying, or to copy the non-secret ' +
        'settings (image, resources, ports) of a working version when creating a new one. The ' +
        'registry login and secret env values are never readable: the API returns "' + ENCRYPTED_PLACEHOLDER + '" ' +
        'for them, so get them from the dashboard\'s Container Registry page or the developer.',
      inputSchema: {
        application: z.string().describe('Application name, as returned by edgegap_list_apps.'),
      },
      outputSchema: OUTPUT.listAppVersions,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ application }) =>
      // Read-only, so not subject to EDGEGAP_APP_ALLOWLIST: the allowlist
      // limits what the agent can create and deploy into, as documented.
      guarded(auth, NOT_FOUND.app, async () => {
        const res = await client.listAppVersions(application);
        const versions = (res.versions ?? []).map(compactVersion);
        if (versions.length === 0) {
          return emptyState(
            'empty',
            { application, total: 0, versions: [] },
            `Application "${application}" has no versions yet. Push the server image, confirm it with ` +
              'edgegap_list_registry_tags, then register it with edgegap_create_app_version.'
          );
        }
        return withMeta(
          ok({
            application,
            ...pageInfo(res.total_count, versions.length, 1),
            versions,
            next_step:
              'Deploy an active version with edgegap_deploy, or register a new image with edgegap_create_app_version.',
          }),
          { props: { item_count: versions.length } }
        );
      })
  );

  // --------------------------------------------------------------- 3b ----
  tool(
    'edgegap_get_app_version',
    {
      title: 'Get one application version',
      description:
        'Read one version in full: image, resources, ports, max_duration, whether image caching ' +
        '(force_cache) and verify_image are on, restart policy, the Endpoint Storage its logs go to, and the names ' +
        'of its env vars (values are never shown). Use it before edgegap_update_app_version or edgegap_deploy ' +
        'to check what a version will do.',
      inputSchema: {
        application: z.string().describe('Application name.'),
        version: z.string().describe('Version name, as listed by edgegap_list_app_versions.'),
      },
      outputSchema: OUTPUT.getAppVersion,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ application, version }) =>
      guarded(auth, NOT_FOUND.app, async () => {
        const v = await client.getAppVersion(application, version);
        return ok({
          application,
          ...compactVersion(v),
          force_cache: v.force_cache,
          caching_percent: v.caching_percent,
          verify_image: v.verify_image,
          restart_policy: v.restart_policy,
          termination_grace_period_seconds: v.termination_grace_period_seconds,
          endpoint_storage: v.endpoint_storage || undefined,
          time_to_deploy_seconds: v.time_to_deploy,
          env: v.envs?.map((e) => ({ key: e.key, hidden: e.is_hidden ?? false })),
          ...autoStop(v.max_duration),
        });
      })
  );

  // ---------------------------------------------------------------- 4 ----
  if (mutating) {
    tool(
      'edgegap_create_app_version',
      {
        title: 'Create an application version',
        description:
          'Register a container image as a deployable version of an application. The image must ' +
          'already be pushed to a registry that Edgegap can pull from (see ' +
          'edgegap_get_registry_credentials and edgegap_list_registry_tags). Resource units: 1024 cpu ' +
          'units = 1 vCPU; memory_mb must be at least 256 and at most double the cpu units. ' +
          'Set verify_image true on the first version so a bad image fails here rather than at ' +
          'deploy time. Refused, with nothing sent, for the "latest" or an empty docker tag (use a build ID so ' +
          'deployments are reproducible) and for a docker_image that also holds a registry host or tag. ' +
          'Env vars named like secrets (TOKEN, SECRET, PASSWORD, API_KEY…) are hidden in the dashboard. ' +
          'When copying an existing version, copy only non-secret settings: the API returns "' +
          ENCRYPTED_PLACEHOLDER + '" for its registry login and secret env values, and that ' +
          'placeholder is refused here.',
        inputSchema: {
          application: z.string().describe('Existing application name.'),
          name: z
            .string()
            .min(1)
            .max(64)
            .describe('Version identifier, typically a build ID or timestamp.'),
          docker_repository: z
            .string()
            .describe('Registry host, e.g. "docker.io" or "registry.edgegap.com".'),
          docker_image: z.string().describe('Namespaced image, e.g. "mystudio/game-server".'),
          docker_tag: z.string().describe('Image tag: a build ID, commit SHA or timestamp. "latest" and empty tags are refused.'),
          cpu_units: z.number().int().min(256).describe('vCPU units. 1024 = 1 vCPU.'),
          memory_mb: z.number().int().min(256).describe('Memory in MB. At most 2x cpu_units.'),
          ports: z
            .array(
              z.object({
                port: z.number().int().min(1).max(59999).describe('Port the server listens on.'),
                protocol: z
                  .string()
                  .describe(`One of ${PROTOCOLS.join(', ')}. Most game servers use UDP.`),
                name: z.string().optional().describe('Label, e.g. "gameport".'),
                to_check: z
                  .boolean()
                  .optional()
                  .describe('Readiness check on this port. Default true.'),
                tls_upgrade: z
                  .boolean()
                  .optional()
                  .describe(
                    'Edgegap terminates TLS on this port, so clients connect with wss:// or https://. ' +
                      'Required for browser (WebGL) clients, which cannot use plain ws:// from an https page. ' +
                      'WS and HTTP ports only. Default false.'
                  ),
              })
            )
            .min(1)
            .describe('Ports to expose. At least one is required for players to connect.'),
          registry_username: z
            .string()
            .optional()
            .describe(
              'Registry username. Needed for private images, including images in your own ' +
                'registry.edgegap.com project: Edgegap pulls with this login, not your API token.'
            ),
          registry_token: z.string().optional().describe('Registry password or token.'),
          max_duration_minutes: z
            .number()
            .int()
            .optional()
            .describe('Auto-stop after this many minutes. Keeps test deployments from running up cost.'),
          verify_image: z
            .boolean()
            .optional()
            .describe('Verify Edgegap can pull the image before accepting the version.'),
          endpoint_storage: z
            .string()
            .min(1)
            .optional()
            .describe('Endpoint Storage name (edgegap_list_endpoint_storage) to export container logs to when deployments end.'),
          env: z
            .array(z.object({ key: z.string(), value: z.string() }))
            .optional()
            .describe('Environment variables injected into the container. Values are never echoed back.'),
          dry_run: dryRunParam,
        },
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) =>
        guarded(auth, NOT_FOUND.app, async () => {
          assertAppAllowed(config, args.application);

          const leak = await tokenLeak(auth, args.dry_run, [
            ...(args.env ?? []).flatMap((e): Array<[string, string]> => [
              [`env var name "${e.key.slice(0, 40)}"`, e.key],
              [`the value of env var "${e.key.slice(0, 40)}"`, e.value],
            ]),
            ['registry_username', args.registry_username],
            ['registry_token', args.registry_token],
          ]);
          if (leak) return leak;

          const placeholder = encryptedPlaceholder(
            [
              ['registry_username', args.registry_username],
              ['registry_token', args.registry_token],
              ...(args.env ?? []).map((e): [string, string] => [`the value of env var "${e.key.slice(0, 40)}"`, e.value]),
            ],
            'Without them, leave registry_username and registry_token out and have the developer add the ' +
              'login to this version in the dashboard.'
          );
          if (placeholder) return placeholder;

          const tagProblem = badTag(args.docker_tag);
          if (tagProblem) return fail(`Refused: ${tagProblem}. ${TAG_FIX}`);
          const imageProblem = badImage(args.docker_repository, args.docker_image);
          if (imageProblem) return fail(`Refused: ${imageProblem}`);

          if (args.memory_mb > args.cpu_units * 2) {
            return fail(
              `memory_mb (${args.memory_mb}) exceeds twice cpu_units (${args.cpu_units}). ` +
                `Edgegap rejects this. Either lower memory_mb to ${args.cpu_units * 2} or raise cpu_units.`
            );
          }

          const badTls = args.ports.find((p) => p.tls_upgrade && !TLS_PROTOCOLS.has(p.protocol.toUpperCase()));
          if (badTls) {
            return fail(
              `Port ${badTls.port} is ${badTls.protocol}; tls_upgrade only works on WS and HTTP ports. ` +
                'Use protocol "WS" for a WebSocket server, or drop tls_upgrade.'
            );
          }

          const requested = args.max_duration_minutes ?? config.maxDurationCeiling;
          const capped = Math.min(requested, config.maxDurationCeiling);
          const hasRegistryLogin = Boolean(args.registry_username && args.registry_token);
          const edgegapRegistry = /(^|\/\/)registry\.edgegap\.com\/?$/.test(args.docker_repository.trim());

          const body = {
            name: args.name,
            is_active: true,
            req_cpu: args.cpu_units,
            req_memory: args.memory_mb,
            docker_repository: args.docker_repository,
            docker_image: args.docker_image,
            docker_tag: args.docker_tag,
            private_username: args.registry_username,
            private_token: args.registry_token,
            verify_image: args.verify_image ?? false,
            ...(args.endpoint_storage ? { endpoint_storage: args.endpoint_storage } : {}),
            max_duration: capped,
            ports: args.ports.map((p) => ({
              port: p.port,
              protocol: p.protocol,
              name: p.name ?? 'gameport',
              to_check: p.to_check ?? true,
              tls_upgrade: p.tls_upgrade ?? false,
            })),
            envs: args.env?.map((e) => ({ key: e.key, value: e.value, is_hidden: looksSecret(e.key) })),
          };

          if (args.dry_run) {
            const dry = client.dryRun();
            await dry.client.createAppVersion(args.application, body);
            return dryRunResult(dry.requests, capped < requested ? [`max_duration capped to ${capped} minutes by EDGEGAP_MAX_DURATION_MINUTES.`] : []);
          }

          let res;
          try {
            res = await client.createAppVersion(args.application, body);
          } catch (err) {
            // verify_image pulls with the version's registry login. Without one
            // — even for the org's own registry.edgegap.com project — Edgegap
            // answers a bare 400 "Unable to login with the given credentials".
            if (err instanceof EdgegapApiError && err.status === 400 && /login|credential/i.test(err.apiMessage)) {
              return fail(registryLoginNeeded(args.docker_repository, hasRegistryLogin));
            }
            throw err;
          }

          const notes: string[] = [];
          if (edgegapRegistry && !hasRegistryLogin) {
            notes.push(
              'No registry login was set. Edgegap pulls images from registry.edgegap.com with the ' +
                'version\'s registry login, not your API token, so deployments of this version will ' +
                'likely fail to pull (424) until the developer adds the Container Registry username ' +
                'and token to this version in the dashboard.'
            );
          }
          for (const p of args.ports) {
            if (WS_PROTOCOLS.has(p.protocol.toUpperCase()) && !p.tls_upgrade) {
              notes.push(
                `Port ${p.port} is WebSocket without tls_upgrade. If clients run in a browser (WebGL), ` +
                  'they need wss://: create the version with tls_upgrade: true on this port.'
              );
            }
          }

          return withMeta(
            ok({
              created: `${args.application}/${res.version?.name ?? args.name}`,
              max_duration_minutes: capped,
              capped_by_server: capped < requested ? config.maxDurationCeiling : undefined,
              notes: notes.length ? notes : undefined,
              next_step:
                `Call edgegap_deploy with application "${args.application}" and version ` +
                `"${res.version?.name ?? args.name}" to start a server, then edgegap_wait_for_deployment.`,
            }),
            { milestones: ['app_version_created'], props: { registry_login_set: hasRegistryLogin } }
          );
        })
    );
  }

  // --------------------------------------------------------------- 4b ----
  if (mutating) {
    tool(
      'edgegap_update_app_version',
      {
        title: 'Update an application version',
        description:
          'Change settings on an existing version instead of creating a new one: point it at a new ' +
          'image tag, turn it on or off, change max_duration, set the registry login, turn on image ' +
          'caching (force_cache: Edgegap pre-loads the image so deployments start faster), or set ' +
          'the shutdown grace period. Only the fields you pass change. Deployments already running ' +
          'keep their old settings; new deployments get the new ones. Same refusals as ' +
          'edgegap_create_app_version: "latest" or empty tags, a docker_image holding a host or ' +
          'tag, and the API token in the registry login or env vars. ports and env REPLACE the ' +
          'version\'s whole list (per the API): read the current ones with edgegap_get_app_version ' +
          'and pass every port or variable to keep; secret env values are not readable, so get them ' +
          'from the developer. Refused, with nothing sent, for a registry login or env value equal to ' +
          'the API\'s "' + ENCRYPTED_PLACEHOLDER + '" placeholder; leave the registry login out to keep it. cpu_units and memory_mb ' +
          'change together (both or neither); to try other resources for one deployment only, override them in ' +
          'edgegap_deploy instead.',
        inputSchema: {
          application: z.string().describe('Application name.'),
          version: z.string().describe('Version name to change.'),
          is_active: z.boolean().optional().describe('false blocks new deployments of this version.'),
          docker_repository: z.string().optional().describe('Registry host, e.g. "registry.edgegap.com".'),
          docker_image: z.string().optional().describe('Image path, e.g. "my-org-abc123/my-game-server".'),
          docker_tag: z.string().optional().describe('New image tag: a build ID, commit SHA or timestamp.'),
          registry_username: z.string().optional(),
          registry_token: z.string().optional().describe('Registry password or token. Never echoed back.'),
          max_duration_minutes: z
            .number()
            .int()
            .optional()
            .describe('Auto-stop after this many minutes. Capped by EDGEGAP_MAX_DURATION_MINUTES.'),
          cpu_units: z
            .number()
            .int()
            .min(256)
            .optional()
            .describe('New vCPU units for later deployments, with memory_mb. 1024 = 1 vCPU.'),
          memory_mb: z
            .number()
            .int()
            .min(256)
            .optional()
            .describe('New memory in MB for later deployments, with cpu_units. At most 2x cpu_units.'),
          force_cache: z.boolean().optional().describe('Pre-load the image on Edgegap so deployments start faster.'),
          verify_image: z.boolean().optional().describe('Check Edgegap can pull the image when saving.'),
          endpoint_storage: z
            .string()
            .min(1)
            .optional()
            .describe('Endpoint Storage name (edgegap_list_endpoint_storage) to export container logs to when deployments end.'),
          termination_grace_period_seconds: z
            .number()
            .int()
            .min(0)
            .max(3600)
            .optional()
            .describe('Seconds between SIGTERM and SIGKILL when a deployment stops.'),
          ports: z
            .array(
              z.object({
                port: z.number().int().min(1).max(59999).describe('Port the server listens on.'),
                protocol: z.string().describe(`One of ${PROTOCOLS.join(', ')}. Most game servers use UDP.`),
                name: z.string().optional().describe('Label, e.g. "gameport".'),
                to_check: z.boolean().optional().describe('Readiness check on this port. Default true.'),
                tls_upgrade: z.boolean().optional().describe('wss:// / https:// for browser clients. WS and HTTP ports only.'),
              })
            )
            .min(1)
            .optional()
            .describe('REPLACES every port on the version. Include the ports to keep, not only new ones.'),
          env: z
            .array(z.object({ key: z.string(), value: z.string() }))
            .optional()
            .describe('REPLACES every env var on the version; [] removes them all. Values are never echoed back.'),
          dry_run: dryRunParam,
        },
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async (args) =>
        guarded(auth, NOT_FOUND.app, async () => {
          assertAppAllowed(config, args.application);

          const leak = await tokenLeak(auth, args.dry_run, [
            ['registry_username', args.registry_username],
            ['registry_token', args.registry_token],
            ...(args.env ?? []).flatMap((e): Array<[string, string]> => [
              [`env var name "${e.key.slice(0, 40)}"`, e.key],
              [`the value of env var "${e.key.slice(0, 40)}"`, e.value],
            ]),
          ]);
          if (leak) return leak;

          const placeholder = encryptedPlaceholder(
            [
              ['registry_username', args.registry_username],
              ['registry_token', args.registry_token],
              ...(args.env ?? []).map((e): [string, string] => [`the value of env var "${e.key.slice(0, 40)}"`, e.value]),
            ],
            'To keep the version\'s current registry login, leave registry_username and registry_token ' +
              'out. env replaces every variable, so leave env out to keep the current ones.'
          );
          if (placeholder) return placeholder;

          const badTls = args.ports?.find((p) => p.tls_upgrade && !TLS_PROTOCOLS.has(p.protocol.toUpperCase()));
          if (badTls) {
            return fail(
              `Port ${badTls.port} is ${badTls.protocol}; tls_upgrade only works on WS and HTTP ports. ` +
                'Use protocol "WS" for a WebSocket server, or drop tls_upgrade.'
            );
          }

          if (args.docker_tag !== undefined) {
            const tagProblem = badTag(args.docker_tag);
            if (tagProblem) return fail(`Refused: ${tagProblem}. ${TAG_FIX}`);
          }
          if (args.docker_image !== undefined) {
            const imageProblem = badImage(args.docker_repository ?? '', args.docker_image);
            if (imageProblem) return fail(`Refused: ${imageProblem}`);
          }
          // The PATCH takes req_cpu and req_memory separately, but the 2x
          // ratio spans both, so take them together like edgegap_deploy does.
          if ((args.cpu_units === undefined) !== (args.memory_mb === undefined)) {
            return fail('Pass both cpu_units and memory_mb to change the version\'s resources, or neither to keep them.');
          }
          if (args.cpu_units !== undefined && args.memory_mb !== undefined && args.memory_mb > args.cpu_units * 2) {
            return fail(
              `memory_mb (${args.memory_mb}) exceeds twice cpu_units (${args.cpu_units}). Edgegap rejects this. ` +
                `Lower memory_mb to ${args.cpu_units * 2} or raise cpu_units.`
            );
          }

          const capped =
            args.max_duration_minutes === undefined
              ? undefined
              : Math.min(args.max_duration_minutes, config.maxDurationCeiling);
          const body: Record<string, unknown> = {
            is_active: args.is_active,
            docker_repository: args.docker_repository,
            docker_image: args.docker_image,
            docker_tag: args.docker_tag,
            private_username: args.registry_username,
            private_token: args.registry_token,
            req_cpu: args.cpu_units,
            req_memory: args.memory_mb,
            max_duration: capped,
            force_cache: args.force_cache,
            verify_image: args.verify_image,
            endpoint_storage: args.endpoint_storage,
            termination_grace_period_seconds: args.termination_grace_period_seconds,
            ports: args.ports?.map((p) => ({
              port: p.port,
              protocol: p.protocol,
              name: p.name ?? 'gameport',
              to_check: p.to_check ?? true,
              tls_upgrade: p.tls_upgrade ?? false,
            })),
            envs: args.env?.map((e) => ({ key: e.key, value: e.value, is_hidden: looksSecret(e.key) })),
          };
          for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
          if (Object.keys(body).length === 0) {
            return fail('Nothing to change: pass at least one field to update.');
          }

          const notes =
            capped !== undefined && capped < (args.max_duration_minutes ?? 0)
              ? [`max_duration capped to ${capped} minutes by EDGEGAP_MAX_DURATION_MINUTES.`]
              : [];
          if (args.ports) notes.push(`ports replaced: the version now has exactly these ${args.ports.length}.`);
          if (args.env) notes.push(`env replaced: the version now has exactly these ${args.env.length} variables.`);
          if (args.dry_run) {
            const dry = client.dryRun();
            await dry.client.updateAppVersion(args.application, args.version, body);
            return dryRunResult(dry.requests, notes);
          }
          await client.updateAppVersion(args.application, args.version, body);
          return ok({
            updated: `${args.application}/${args.version}`,
            changed: Object.keys(body).map((k) => (k === 'private_token' ? 'registry_token' : k === 'private_username' ? 'registry_username' : k)),
            notes: notes.length ? notes : undefined,
            next_step: 'Running deployments keep the old settings. Check the result with edgegap_get_app_version.',
          });
        })
    );
  }

  // --------------------------------------------------------------- 5b ----
  tool(
    'edgegap_list_locations',
    {
      title: 'List where servers can run',
      description:
        'List the cities Edgegap can deploy to. Pass application and version to see only the ' +
        'locations with capacity for that version right now. Use it to pick geo_coordinates for ' +
        'edgegap_deploy when you have no player IPs, or to tell a developer where their players ' +
        'can be served from. For the ping beacons game clients use to measure latency, see ' +
        'edgegap_list_ping_beacons.',
      inputSchema: {
        application: z.string().optional().describe('With version: only locations with capacity for it now.'),
        version: z.string().optional(),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Default 100.'),
      },
      outputSchema: OUTPUT.listLocations,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ application, version, page, limit }) =>
      guarded(auth, NOT_FOUND.app, async () => {
        if ((application === undefined) !== (version === undefined)) {
          return fail('Pass both application and version to filter by capacity, or neither for every location.');
        }
        const res = await client.listLocations({ app: application, version, page, limit: limit ?? 100 });
        const locations = (res.locations ?? []).map((l) => ({
          city: l.city,
          region: l.administrative_division || undefined,
          country: l.country,
          continent: l.continent,
          latitude: l.latitude,
          longitude: l.longitude,
        }));
        return ok({
          filtered_for: application ? `${application}/${version} (capacity right now)` : undefined,
          ...pageInfo(res.total_count, locations.length, page ?? 1),
          locations,
          messages: res.messages?.length ? res.messages : undefined,
        });
      })
  );

  tool(
    'edgegap_list_ping_beacons',
    {
      title: 'List ping beacons',
      description:
        'List Edgegap\'s ping beacons: one host per region that a game client can ping (UDP or ' +
        'TCP) to measure its latency before matchmaking. The matchmaker\'s latency rules use these ' +
        'measurements. Read-only; the game client does the pinging, not this tool.',
      inputSchema: {
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Default 100.'),
      },
      outputSchema: OUTPUT.listPingBeacons,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ page, limit }) =>
      guard(auth, async () => {
        const res = await client.listBeacons({ page, limit: limit ?? 100 });
        const beacons = (res.locations ?? []).map((b) => ({
          host: b.fqdn ?? b.host,
          udp_port: b.udp_port,
          tcp_port: b.tcp_port,
          city: b.location?.city,
          country: b.location?.country,
          continent: b.location?.continent,
        }));
        return ok({ total: res.count ?? beacons.length, beacons });
      })
  );

  // ---------------------------------------------------------------- 5 ----
  if (mutating) {
    tool(
      'edgegap_deploy',
      {
        title: 'Deploy a game server',
        description:
          'Start one authoritative dedicated game server from an application version, placed near ' +
          'the players you specify. This is the recommended way to host a multiplayer match: the ' +
          'server owns the game state, so no player hosts it. Returns immediately with a request_id; the server is still starting and ' +
          'has no connection details yet. Follow this call with edgegap_wait_for_deployment to ' +
          'get the address players connect to. Always stop deployments you started for testing. ' +
          `Every deployment is tagged "${AGENT_TAG}" in addition to any tags you pass, so ` +
          'edgegap_list_deployments with only_agent_deployments: true finds them all. Runs until ' +
          'stopped or until the version\'s max_duration, which the result reports. Refused, with ' +
          'nothing sent, if the API token appears in an env var or tag, if the version uses the "latest" ' +
          'docker tag, or when too many agent deployments are already running (EDGEGAP_MAX_AGENT_DEPLOYMENTS, ' +
          'default 5): stop finished ones first. Also refused when the version\'s max_duration is unlimited or above ' +
          'EDGEGAP_MAX_DURATION_MINUTES, unless allow_long_running is true (ask the developer first), and on the local ' +
          'server after EDGEGAP_MAX_DEPLOYS_PER_RUN deploys (default 20). Env vars named like secrets are hidden in the ' +
          'dashboard. Optional: webhooks Edgegap calls when the server is ready, errors or ends (instead of polling), ' +
          'require_cached_locations for faster starts, and private_host_ids to place it on your private fleet first.',
        inputSchema: {
          application: z.string().describe('Application name.'),
          version: z.string().describe('Version name within the application.'),
          users: userSchema,
          env: z
            .array(z.object({ key: z.string(), value: z.string() }))
            .optional()
            .describe('Environment variables for this deployment only. Values are never echoed back.'),
          tags: z
            .array(z.string().min(1).max(40))
            .optional()
            .describe(`Extra tags for filtering later, e.g. ["agent-test"]. "${AGENT_TAG}" is always added.`),
          cpu_units: z
            .number()
            .int()
            .min(256)
            .optional()
            .describe('Override the version\'s CPU for this deployment only, with memory_mb. 1024 = 1 vCPU.'),
          memory_mb: z
            .number()
            .int()
            .min(256)
            .optional()
            .describe('Override the version\'s memory for this deployment only, with cpu_units. At most 2x cpu_units.'),
          require_cached_locations: z
            .boolean()
            .optional()
            .describe(
              'Only place it where the image is already cached: starts faster, fewer places to choose from. Needs ' +
                'force_cache on the version (edgegap_update_app_version); without it the API refuses the deploy.'
            ),
          webhook_on_ready: z.string().optional().describe('https URL Edgegap POSTs to when the server is ready.'),
          webhook_on_error: z.string().optional().describe('https URL Edgegap POSTs to when the deployment fails.'),
          webhook_on_terminated: z.string().optional().describe('https URL Edgegap POSTs to when the deployment ends.'),
          private_host_ids: z
            .array(z.string().min(1))
            .min(1)
            .optional()
            .describe(
              'Private fleet host IDs to try first, in order (from edgegap_list_fleet_hosts); Edgegap overflows to ' +
                'its cloud when they are full. Omit for a normal cloud deployment.'
            ),
          allow_long_running: z
            .boolean()
            .optional()
            .describe(
              'Deploy even though the version\'s max_duration is unlimited or above EDGEGAP_MAX_DURATION_MINUTES. ' +
                'Only after the developer agreed: the server bills until it is stopped or that limit.'
            ),
          dry_run: dryRunParam,
        },
        outputSchema: OUTPUT.deploy,
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) =>
        guarded(auth, NOT_FOUND.app, async () => {
          assertAppAllowed(config, args.application);

          const users = buildUsers(args.users);
          if (users.length === 0) {
            return fail(
              'No player locations given. Supply users.ip_addresses (e.g. the developer\'s own ' +
                'public IP) or users.geo_coordinates. Edgegap needs at least one to choose a region.'
            );
          }

          // Forced, whatever the caller passed: the tag is how agent
          // deployments are found and cleaned up, so it cannot be optional.
          const tags = [...new Set([...(args.tags ?? []), AGENT_TAG])];

          const leak = await tokenLeak(auth, args.dry_run, [
            ...(args.env ?? []).flatMap((e): Array<[string, string]> => [
              [`env var name "${e.key.slice(0, 40)}"`, e.key],
              [`the value of env var "${e.key.slice(0, 40)}"`, e.value],
            ]),
            ...tags.map((t): [string, string] => [`tag "${t.slice(0, 8)}…"`, t]),
            ...WEBHOOKS.map((w): [string, string | undefined] => [w, args[w]]),
          ]);
          if (leak) return leak;

          const placeholder = encryptedPlaceholder(
            (args.env ?? []).map((e): [string, string] => [`the value of env var "${e.key.slice(0, 40)}"`, e.value]),
            'Leave the variable out: the deployment already gets the version\'s own env vars.'
          );
          if (placeholder) return placeholder;

          for (const w of WEBHOOKS) {
            const problem = args[w] === undefined ? undefined : webhookProblem(args[w]);
            if (problem) return fail(`${w}: ${problem}`);
          }

          const body: Record<string, unknown> = {
            application: args.application,
            version: args.version,
            users,
            tags,
          };
          if (args.env) {
            body.environment_variables = args.env.map((e) => ({
              key: e.key,
              value: e.value,
              is_hidden: looksSecret(e.key),
            }));
          }
          // The v2 API takes both or neither (DeploymentV2.resources).
          if ((args.cpu_units === undefined) !== (args.memory_mb === undefined)) {
            return fail('Pass both cpu_units and memory_mb to override the version\'s resources, or neither to use the version\'s.');
          }
          if (args.cpu_units !== undefined && args.memory_mb !== undefined) {
            if (args.memory_mb > args.cpu_units * 2) {
              return fail(
                `memory_mb (${args.memory_mb}) exceeds twice cpu_units (${args.cpu_units}). Edgegap rejects this. ` +
                  `Lower memory_mb to ${args.cpu_units * 2} or raise cpu_units.`
              );
            }
            body.resources = { cpu_units: args.cpu_units, memory_mib: args.memory_mb };
          }
          if (args.require_cached_locations !== undefined) body.require_cached_locations = args.require_cached_locations;
          for (const w of WEBHOOKS) if (args[w] !== undefined) body[w] = { url: args[w] };
          const fleet = args.private_host_ids !== undefined;
          if (fleet) body.private_host_ids = [...new Set(args.private_host_ids)];
          const send = (c: EdgegapClient) => (fleet ? c.deployToFleet(body) : c.deploy(body));

          // Counted per process, before the version is read, so a loop that
          // keeps failing still runs out. The hosted server has no process to
          // count in; its cap is EDGEGAP_MAX_AGENT_DEPLOYMENTS alone.
          const perRun = config.transport === 'local' ? (config.maxDeploysPerRun ?? 0) : 0;
          if (!args.dry_run && perRun > 0 && deploysSent >= perRun) {
            return fail(
              `Refused: this server already sent ${deploysSent} deploys, the limit for one run ` +
                `(EDGEGAP_MAX_DEPLOYS_PER_RUN=${perRun}). Nothing was sent. Stop what is running and ask the developer; ` +
                'restarting the MCP server resets the count.'
            );
          }

          // Edgegap has no per-deployment time limit: a deployment runs until
          // stopped or until its version's max_duration (default 1440 minutes,
          // a full day). Read it first so the agent knows how long an
          // unstopped test server will keep billing. A dry run reads it too,
          // so it previews the refusals below, but only with a token already
          // in hand (a dry run must not trigger the token prompt); if the read
          // fails, it still shows the request and says what it could not check.
          let version: AppVersionRecord;
          try {
            if (args.dry_run && !auth.current) throw new Error('no API token in this session yet');
            version = await client.getAppVersion(args.application, args.version);
          } catch (err) {
            if (!args.dry_run) throw err;
            const dry = client.dryRun();
            await send(dry.client);
            return dryRunResult(dry.requests, [
              `Tagged "${AGENT_TAG}" automatically.`,
              `Could not read the version (${err instanceof Error ? err.message.split('\n')[0] : String(err)}), so ` +
                'the docker tag, max_duration and running-deployment checks did not run. A real deploy runs them.',
            ]);
          }
          if (version.docker_tag !== undefined && badTag(version.docker_tag)) {
            return fail(
              `Refused: version "${args.version}" uses docker_tag "${version.docker_tag}". ${TAG_FIX} ` +
                'Then create a new version with edgegap_create_app_version and deploy that.'
            );
          }
          const maxDuration = version.max_duration;
          const longRunning =
            typeof maxDuration === 'number' && (maxDuration <= 0 || maxDuration > config.maxDurationCeiling);
          if (longRunning && !args.allow_long_running) {
            return fail(
              `Refused: version "${args.version}" lets a deployment run ` +
                (maxDuration <= 0 ? 'with no time limit' : `for ${maxDuration} minutes`) +
                `, above this server's EDGEGAP_MAX_DURATION_MINUTES (${config.maxDurationCeiling}). Nothing was sent. ` +
                'Ask the developer; if they agree, deploy again with allow_long_running: true and stop it when done. ' +
                'For tests, a version created with edgegap_create_app_version gets the capped max_duration. Do not ' +
                'lower max_duration on a version live players use.'
            );
          }

          // A looping agent can start servers faster than anyone notices the
          // bill. Count the ones it already has running before adding one.
          if (config.maxAgentDeployments > 0) {
            const running = await client.listDeployments({
              query: JSON.stringify({ filters: [{ field: 'tags', operator: 'in', value: [AGENT_TAG, 'mcp'] }] }),
              limit: 1,
            });
            const count = running.total_count ?? running.data?.length ?? 0;
            if (count >= config.maxAgentDeployments) {
              return fail(
                `Refused: ${count} deployments started through this server are still running, and the limit ` +
                  `is ${config.maxAgentDeployments} (EDGEGAP_MAX_AGENT_DEPLOYMENTS). List them with ` +
                  'edgegap_list_deployments only_agent_deployments: true and stop the ones you are done with ' +
                  'using edgegap_stop_deployment, then deploy again.'
              );
            }
          }

          if (args.dry_run) {
            const dry = client.dryRun();
            await send(dry.client);
            const stop = autoStop(version.max_duration);
            return dryRunResult(dry.requests, [
              `Tagged "${AGENT_TAG}" automatically.`,
              ...(longRunning ? ['long_running: allowed by allow_long_running.'] : []),
              typeof stop.auto_stop_after_minutes === 'number'
                ? `Auto-stop: after ${stop.auto_stop_after_minutes} minutes (the version's max_duration).`
                : `Auto-stop: ${stop.auto_stop}.`,
            ]);
          }

          // A refused deploy can still leave a deployment behind (a 422 "not
          // enough space" did, 2026-10-28) with no request_id in the error.
          // The lookup looks back a minute for clock skew, which also catches
          // deploys of the same version made just before this one (live,
          // 2026-10-28), so note those first and leave them out afterwards.
          const sentAt = new Date(Date.now() - 60_000).toISOString();
          const recentQuery = {
            query: JSON.stringify({
              filters: [
                { field: 'application', operator: 'eq', value: args.application },
                { field: 'version', operator: 'eq', value: args.version },
                { field: 'tags', operator: 'in', value: [AGENT_TAG] },
                { field: 'created_at', operator: 'gte', value: sentAt },
              ],
            }),
            limit: 100,
          };
          const recentIds = () =>
            client
              .listDeployments(recentQuery)
              .then((r) => (r.data ?? []).map((d) => d.request_id).filter(Boolean))
              .catch((): string[] => []);
          const before = new Set(await recentIds());

          deploysSent++;
          let res: { request_id: string };
          try {
            res = await send(client);
          } catch (err) {
            if (!(err instanceof EdgegapApiError)) throw err;
            const left = (await recentIds()).filter((id) => !before.has(id));
            if (left.length === 0) throw err;
            throw new EdgegapApiError(
              err.status,
              `${err.apiMessage}\nThe API still created ${left.length === 1 ? 'a deployment' : 'deployments'} for this ` +
                `request: ${left.join(', ')}. Stop ${left.length === 1 ? 'it' : 'each'} with edgegap_stop_deployment.`,
              err.details
            );
          }
          return withMeta(
            ok({
              request_id: res.request_id,
              status: 'starting',
              tags,
              ...(fleet ? { private_host_ids: body.private_host_ids } : {}),
              ...(longRunning ? { long_running: 'allowed by allow_long_running' } : {}),
              ...autoStop(version.max_duration),
              resources: body.resources,
              next_step: `Call edgegap_wait_for_deployment with request_id ${res.request_id}.`,
            }),
            {
              hash: { request_id: res.request_id },
              props: {
                resources_override: body.resources !== undefined,
                private_fleet: fleet,
                webhooks: WEBHOOKS.filter((w) => args[w] !== undefined).length,
              },
            }
          );
        })
    );
  }

  // ---------------------------------------------------------------- 6 ----
  tool(
    'edgegap_get_deployment',
    {
      title: 'Get deployment status',
      description:
        'Read the current status of one deployment, including connection address and ports once ' +
        'it is ready. For a deployment you just created, prefer edgegap_wait_for_deployment — it ' +
        'polls for you instead of making you call this in a loop.',
      inputSchema: {
        request_id: z.string().describe('The request_id returned by edgegap_deploy.'),
      },
      outputSchema: OUTPUT.deployment,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ request_id }) =>
      guarded(auth, NOT_FOUND.deployment, async () => {
        const d = await client.getDeployment(request_id);
        const status = (d.current_status ?? '').toUpperCase();
        const nextStep = d.error || TERMINAL_BAD.some((s) => status.includes(s))
          ? `It failed or stopped. Read why with edgegap_get_deployment_logs {request_id: "${request_id}"} before redeploying.`
          : d.running || TERMINAL_OK.some((s) => status.includes(s))
            ? `Players connect to fqdn on each port's external number. Stop it with edgegap_stop_deployment {request_id: "${request_id}"} when done: it bills while running.`
            : `Still starting. Call edgegap_wait_for_deployment {request_id: "${request_id}"} instead of polling this.`;
        return ok({ ...compactDeployment(d), next_step: nextStep });
      })
  );

  // ---------------------------------------------------------------- 7 ----
  tool(
    'edgegap_wait_for_deployment',
    {
      title: 'Wait for a deployment to become ready',
      description:
        'Poll a deployment until it is ready, errors, or the timeout expires, then return the ' +
        'connection details. This is the tool to call right after edgegap_deploy. Do not build ' +
        'your own polling loop — this handles backoff and reports the container error detail if ' +
        'the server fails to start.',
      inputSchema: {
        request_id: z.string().describe('The request_id returned by edgegap_deploy.'),
        timeout_seconds: z
          .number()
          .int()
          .optional()
          .describe('How long to wait before giving up, 5-600. Default 180.'),
      },
      outputSchema: OUTPUT.waitForDeployment,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ request_id, timeout_seconds }, extra) =>
      guarded(auth, NOT_FOUND.deployment, async () => {
        const timeoutSeconds = clamp(timeout_seconds, 5, 600, 180);
        const budgetMs = timeoutSeconds * 1000;
        const startedAt = Date.now();
        let intervalMs = 2000;
        let polls = 0;
        let last: DeploymentStatus | undefined;
        const progress = progressReporter(extra, timeoutSeconds);
        const facts = (outcome: 'ready' | 'error' | 'timeout'): CallMeta => ({
          props: { outcome, final_status: last?.current_status ?? 'unknown', timeout_ms_configured: budgetMs, poll_count: polls },
          hash: { request_id },
        });

        while (Date.now() - startedAt < budgetMs) {
          last = await client.getDeployment(request_id);
          polls++;
          const status = (last.current_status ?? '').toUpperCase();

          if (last.error || TERMINAL_BAD.some((s) => status.includes(s))) {
            // Fetched now, not left to the agent: a failed deployment is
            // cleaned up quickly and its logs go with it, so a separate
            // edgegap_get_deployment_logs call often finds nothing.
            const logs = await logTail(client, request_id, 3000);
            return withMeta(
              fail(
                `Deployment ${request_id} failed with status ${last.current_status}.\n` +
                  `${last.error_detail ?? 'No error detail returned.'}\n\n` +
                  (logs
                    ? `Container output (tail):\n${logs}\n\nFix the image or port configuration before redeploying. ` +
                      'Do not redeploy the same version unchanged: it will fail the same way.'
                    : `No container logs could be read here (the container may never have started, or it ` +
                      `was already cleaned up). Try edgegap_get_deployment_logs {request_id: "${request_id}"} once; ` +
                      'if it has nothing either, check the image, tag and ports before redeploying.'),
                'DEPLOYMENT_FAILED'
              ),
              { ...facts('error'), stage: 'upstream' }
            );
          }

          if (last.running || TERMINAL_OK.some((s) => status.includes(s))) {
            return withMeta(
              ok({
                ...compactDeployment(last),
                waited_seconds: Math.round((Date.now() - startedAt) / 1000),
                cost_reminder:
                  'This server bills while it runs. When testing is done, stop it with ' +
                  `edgegap_stop_deployment {request_id: "${request_id}"} unless the developer wants it kept running.`,
                next_step:
                  `Players connect to ${last.fqdn ?? 'the fqdn above'} on each port's external number. ` +
                  `When finished: edgegap_stop_deployment {request_id: "${request_id}"}.`,
              }),
              { ...facts('ready'), milestones: ['deployment_ready'] }
            );
          }

          await progress(Date.now() - startedAt, `Deployment ${request_id}: ${last.current_status ?? 'starting'}`);
          await new Promise((r) => setTimeout(r, intervalMs));
          intervalMs = Math.min(intervalMs * 1.5, 10_000);
        }

        // Not an error: the wait ran out, the deployment did not fail. It is
        // usually still starting (large images pull slowly on a cold host).
        return withMeta(
          ok({
            ...(last ? compactDeployment(last) : { request_id }),
            ready: false,
            waited_seconds: Math.round((Date.now() - startedAt) / 1000),
            next_step:
              `Not ready within ${timeoutSeconds}s, and not failed: it is still ${last?.current_status ?? 'starting'}. ` +
              `Call edgegap_wait_for_deployment again with request_id "${request_id}" to keep waiting; do not deploy ` +
              `a second server. Stop it with edgegap_stop_deployment if it should not keep running.`,
          }),
          facts('timeout')
        );
      })
  );

  // ---------------------------------------------------------------- 8 ----
  tool(
    'edgegap_list_deployments',
    {
      title: 'List running deployments',
      description:
        'List active deployments, optionally filtered and sorted. Use this to find deployments left running ' +
        'from earlier sessions before starting new ones — orphaned servers cost money. ' +
        'Filter by status, application, version, tags, request_id, created_at, fleet_name or host_name, ' +
        'e.g. [{field:"application",operator:"eq",value:"my-game"},{field:"status",operator:"eq",value:"ready"}]. ' +
        'Operators: eq and neq on every field except created_at (eq, gte, lte); in and nin with an array value ' +
        'on request_id, tags, application, version, fleet_name, host_name; ilike with % wildcards on fleet_name ' +
        'and host_name. At most one filter per field. Sort by created_at or available_session_sockets. ' +
        `To find every deployment an agent started through this server, pass only_agent_deployments: true ` +
        `(the same as filtering tags in ["${AGENT_TAG}", "mcp"]).`,
      inputSchema: {
        only_agent_deployments: z
          .boolean()
          .optional()
          .describe(
            `Only deployments started through this server: tagged "${AGENT_TAG}", or "mcp" by versions ` +
              'up to 0.3.3. Cannot be combined with a tags filter.'
          ),
        filters: z
          .array(
            z.object({
              field: z.enum([
                'status', 'request_id', 'tags', 'created_at', 'application',
                'version', 'fleet_name', 'host_name',
              ]),
              operator: z.enum(['eq', 'neq', 'in', 'nin', 'gte', 'lte', 'ilike']),
              value: z
                .union([z.string(), z.array(z.string())])
                .describe('A string, or an array of strings for in/nin. created_at is ISO 8601, e.g. "2026-09-30T00:00:00Z".'),
            })
          )
          .optional()
          .describe('Omit for all deployments.'),
        order_by: z
          .array(
            z.object({
              field: z.enum(['created_at', 'available_session_sockets']),
              order: z.enum(['asc', 'desc']),
            })
          )
          .optional()
          .describe('e.g. [{field:"created_at",order:"asc"}] for oldest first.'),
        limit: z.number().int().optional().describe('1-100. Default 50.'),
      },
      outputSchema: OUTPUT.listDeployments,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ only_agent_deployments, filters: given, order_by, limit }) =>
      guard(auth, async () => {
        let filters = given;
        if (only_agent_deployments) {
          if (given?.some((f) => f.field === 'tags')) {
            return fail('only_agent_deployments already filters on tags. Drop the tags filter, or drop only_agent_deployments.');
          }
          filters = [...(given ?? []), { field: 'tags' as const, operator: 'in' as const, value: [AGENT_TAG, 'mcp'] }];
        }
        const fields = (filters ?? []).map((f) => f.field);
        const repeated = fields.find((f, i) => fields.indexOf(f) !== i);
        if (repeated) {
          return fail(`Only one filter per field is allowed, and "${repeated}" has more than one. Combine them with "in" or "nin".`);
        }
        const query =
          filters?.length || order_by?.length
            ? JSON.stringify({ filters: filters ?? [], ...(order_by?.length ? { order_by } : {}) })
            : undefined;
        const res = await client.listDeployments({ query, limit: clamp(limit, 1, 100, 50) });
        const rows = (res.data ?? []).map((d) => ({
          request_id: d.request_id,
          ready: d.ready,
          fqdn: d.fqdn,
          started: d.start_time,
          tags: d.tags,
        }));
        if (rows.length === 0) {
          return emptyState(
            'empty',
            { total: 0, deployments: [] },
            only_agent_deployments
              ? 'No deployment started through this server is running: nothing is left to stop.'
              : filters?.length
                ? 'No running deployment matches these filters.'
                : 'No deployments are running. Start one with edgegap_deploy.'
          );
        }
        const info = pageInfo(res.total_count, rows.length, 1);
        return withMeta(
          ok({
            ...info,
            deployments: rows,
            ...('next_step' in info
              ? {}
              : {
                  next_step:
                    'Stop the ones you started and no longer need with edgegap_stop_deployment, one request_id per call.',
                }),
          }),
          { props: { item_count: rows.length, only_agent_deployments: only_agent_deployments === true } }
        );
      })
  );

  // ---------------------------------------------------------------- 9 ----
  if (mutating) {
    tool(
      'edgegap_stop_deployment',
      {
        title: 'Stop a deployment',
        description:
          'Gracefully stop one deployment by request_id, sending SIGTERM to the container. ' +
          'Stop every deployment you started for testing before ending your task. This tool ' +
          'stops exactly one deployment, named by its exact request_id: empty IDs, wildcards ' +
          'and lists are refused, and bulk stop is deliberately not exposed.',
        inputSchema: {
          request_id: z.string().describe('The exact request_id of the one deployment to stop, e.g. "61b1be8f54d9".'),
          dry_run: dryRunParam,
        },
        annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ request_id, dry_run }) =>
        guarded(auth, NOT_FOUND.deployment, async () => {
          const bad = checkRequestId(request_id);
          if (bad) return bad;
          if (config.stopOwnOnly && !dry_run) {
            const own = await client
              .listDeploymentTags(request_id)
              .then((r) => (r.tags ?? []).some((t) => t.name === AGENT_TAG || t.name === 'mcp'));
            if (!own) {
              return fail(
                `Refused: deployment ${request_id} has no "${AGENT_TAG}" tag, so this server did not start it, and ` +
                  'EDGEGAP_STOP_OWN_ONLY is on. Nothing was sent. Ask the developer to stop it from the dashboard.'
              );
            }
          }
          if (dry_run) {
            const dry = client.dryRun();
            await dry.client.stopDeployment(request_id);
            return dryRunResult(dry.requests);
          }
          let res;
          try {
            res = await client.stopDeployment(request_id);
          } catch (err) {
            const gone = await alreadyStopped(client, request_id, err);
            if (gone) return withMeta(ok(gone), { hash: { request_id }, props: { stop_result: gone.result } });
            throw err;
          }
          return withMeta(
            ok({
              request_id,
              result: res.message ?? 'stop requested',
              next_step: 'Before ending the task, confirm nothing else is left with edgegap_list_deployments only_agent_deployments: true.',
            }),
            { hash: { request_id }, milestones: ['deployment_stopped'], props: { stop_result: 'stopped' } }
          );
        })
    );
  }

  // --------------------------------------------------------------- 10 ----
  tool(
    'edgegap_get_deployment_logs',
    {
      title: 'Get container logs for a deployment',
      description:
        'Retrieve stdout/stderr and crash output for a deployment. Call this whenever a ' +
        'deployment errors or a server exits unexpectedly — the crash exit code usually ' +
        'identifies the problem faster than redeploying does. Logs for stopped deployments are ' +
        'only retained if Endpoint Storage was configured on the version beforehand.',
      inputSchema: {
        request_id: z.string().describe('The request_id of the deployment.'),
        max_characters: z
          .number()
          .int()
          .optional()
          .describe('Truncate logs to this length (500-50000), keeping the tail. Default 8000.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ request_id, max_characters }) =>
      guarded(auth, NOT_FOUND.logs, async () => {
        let res;
        try {
          res = await client.getDeploymentLogs(request_id);
        } catch (err) {
          // The logs endpoint answers 400 for every "no logs" case alike. Ask
          // the status endpoint which one this is.
          if (!(err instanceof EdgegapApiError) || ![400, 404].includes(err.status)) throw err;
          const why = await whyNoLogs(client, request_id);
          if (!why) throw err;
          return why;
        }
        const cap = clamp(max_characters, 500, 50_000, 8000);
        const tail = (s: string | null | undefined) =>
          !s ? undefined : s.length > cap ? `...[truncated]...\n${s.slice(-cap)}` : s;

        return ok({
          request_id,
          logs: tail(res.logs) ?? '(no logs returned yet: the server has printed nothing)',
          crash_logs: tail(res.crash_logs),
          exit_code: res.crash_data?.exit_code,
          crash_message: res.crash_data?.message,
          restart_count: res.crash_data?.restart_count,
          storage_link: res.logs_link ?? undefined,
        });
      })
  );

  // --------------------------------------------------------------- 10b ----
  tool(
    'edgegap_get_deployment_metrics',
    {
      title: 'Get CPU, memory and network use of a deployment',
      description:
        'Summarise a deployment\'s resource use over time: CPU, CPU throttling, memory and network, ' +
        'each as latest, average and peak, with the API\'s own labels. Use it to size a version ' +
        '(cpu_units, memory_mb) from a real match, or to check whether a crash was memory or CPU ' +
        'starvation before redeploying. Defaults to the whole life of the deployment.',
      inputSchema: {
        request_id: z.string().describe('The request_id of the deployment.'),
        start_time: z.string().optional().describe('ISO 8601. Default: when the deployment started.'),
        end_time: z.string().optional().describe('ISO 8601. Default: now, or when it stopped.'),
        step: z.string().optional().describe('Averaging step, e.g. "30s" or "5m". Default: the API\'s.'),
      },
      outputSchema: OUTPUT.metrics,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ request_id, start_time, end_time, step }) =>
      guarded(auth, NOT_FOUND.deployment, async () => {
        const bad = checkRequestId(request_id);
        if (bad) return bad;
        const m = await client.getDeploymentMetrics(request_id, { start_time, end_time, steps: step });
        return ok({
          request_id,
          cpu: summarizeSeries(m.cpu),
          cpu_throttle_rate: summarizeSeries(m.cpu_throttle_rate),
          memory: summarizeSeries(m.mem),
          network_receive: summarizeSeries(m.network?.receive),
          network_transmit: summarizeSeries(m.network?.transmit),
          totals: m.total
            ? {
                received: summarizeSeries(m.total.receive_total)?.latest,
                transmitted: summarizeSeries(m.total.transmit_total)?.latest,
                disk_read: summarizeSeries(m.total.disk_read_total)?.latest,
                disk_written: summarizeSeries(m.total.disk_write_total)?.latest,
              }
            : undefined,
          note: 'Units are as the API labels them; values are averaged per step.',
        });
      })
  );

  // ============================================= before the first deploy ====

  // -------------------------------------------------------------- 11a ----
  // Pure text generation: no token, no network, so it is always registered and
  // never goes through guard().
  tool(
    'edgegap_generate_dockerfile',
    {
      title: 'Generate a game server Dockerfile',
      description:
        'Write a Dockerfile for this project\'s headless game server build, ready for Edgegap: ' +
        'linux/amd64 base, the build folder copied in, the binary made executable, the right ' +
        'headless flags (Unity -batchmode -nographics, Godot --headless), a non-root user where ' +
        'the engine needs it (Unreal refuses root), CRLF fixes for start scripts, and EXPOSE ' +
        'lines matching the ports. Call this when the project has no Dockerfile, before ' +
        'building anything. Look at the build output first so you can pass the real build ' +
        'folder, binary name and port; anything you omit is assumed and listed under ' +
        'assumptions, which you must confirm with the developer or the project files. Write the ' +
        'result to Dockerfile, then build. The output is checked against ' +
        'edgegap_validate_server_config before it is returned. Makes no API calls.',
      inputSchema: {
        engine: z.enum(['unity', 'unreal', 'godot', 'other']).describe('Game engine of the server build.'),
        build_path: z
          .string()
          .optional()
          .describe(
            'Server build folder, relative to where docker build runs. Defaults: unity ' +
              '"Builds/EdgegapServer", unreal "." (run from inside the packaged LinuxServer folder), godot "build".'
          ),
        executable: z
          .string()
          .optional()
          .describe(
            'File name of the server binary or start script inside build_path. Defaults: unity ' +
              '"ServerBuild", unreal "StartServer.sh", godot "server.x86_64". Required for "other".'
          ),
        ports: z
          .array(
            z.object({
              port: z.number().int().min(1).max(59999),
              protocol: z.enum(PROTOCOLS),
              name: z.string().optional(),
              tls_upgrade: z.boolean().optional().describe('TLS Upgrade (wss/https) on a WS or HTTP port, for browser clients.'),
            })
          )
          .optional()
          .describe('Ports the server listens on. Default: 7777, with the protocol the netcode uses (UDP if unknown).'),
        netcode: z
          .string()
          .optional()
          .describe(`Networking transport, to pick the protocol. Known: ${NETCODE_NAMES.join(', ')}.`),
        launch_args: z
          .array(z.string())
          .optional()
          .describe('Extra server arguments, one per entry, e.g. ["-log", "-port=7777"].'),
        base_image: z.string().optional().describe('Default "ubuntu:22.04".'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      let generated;
      try {
        generated = generateDockerfile(args);
      } catch (err) {
        if (err instanceof DockerfileInputError) return fail(err.message);
        throw err;
      }

      // Never hand back something our own validator would reject.
      const check = validateServerConfig({
        dockerfile: generated.dockerfile,
        engine: args.engine,
        netcode: args.netcode,
        ports: generated.ports,
      });
      if (check.errors.length > 0) {
        return fail(
          'The generated Dockerfile failed validation, which means these inputs combine badly:\n- ' +
            check.errors.map((e) => `${e.message} ${e.fix}`).join('\n- ')
        );
      }

      const ref = '<image>:<unique-build-tag>';
      const portFlags = generated.ports
        .flatMap((p) =>
          p.protocol === 'TCP/UDP'
            ? [`-p ${p.port}:${p.port}/udp`, `-p ${p.port}:${p.port}/tcp`]
            : [`-p ${p.port}:${p.port}/${p.protocol === 'UDP' ? 'udp' : 'tcp'}`]
        )
        .join(' ');

      return ok({
        dockerfile: generated.dockerfile,
        assumptions: generated.assumptions,
        warnings: check.warnings.length ? check.warnings : undefined,
        ports_for_create_app_version: generated.ports,
        commands: {
          build: `docker build --platform linux/amd64 -t ${ref} .`,
          // --platform belongs on build only: the image is already linux/amd64.
          test_locally: `docker run --rm ${portFlags} ${ref}`,
        },
        next_step:
          'Confirm every assumption, write this to Dockerfile, build it, and run it locally to check ' +
          'the server starts and stays up. Then push it (edgegap_get_registry_credentials) and ' +
          'register it with edgegap_create_app_version using ports_for_create_app_version.',
      });
    }
  );

  // --------------------------------------------------------------- 11 ----
  // Pure text analysis: no token, no network, so it is always registered and
  // never goes through guard().
  tool(
    'edgegap_validate_server_config',
    {
      title: 'Validate a game server Dockerfile and port config',
      description:
        'Check a game server Dockerfile and the ports/resources you intend to register against ' +
        'what Edgegap requires, BEFORE building and pushing. Catches the failures that otherwise ' +
        'only show up after a build, push, version and deploy: ARM or Windows images (Edgegap ' +
        'runs linux/amd64), Unreal running as root, missing Unity -batchmode -nographics, a ' +
        'server bound to localhost, EXPOSE ports that do not match the version ports, a protocol ' +
        'that does not match the netcode transport, the "latest" tag, and bad CPU/memory ratios. ' +
        'Pass the Dockerfile text (read it from disk first). If there is no Dockerfile yet, call ' +
        'edgegap_generate_dockerfile instead. Makes no API calls.',
      inputSchema: {
        dockerfile: z.string().optional().describe('Full text of the Dockerfile.'),
        engine: z
          .enum(['unity', 'unreal', 'godot', 'other'])
          .optional()
          .describe('Game engine. Detected from the Dockerfile when omitted.'),
        netcode: z
          .string()
          .optional()
          .describe(`Networking transport, to check the port protocol. Known: ${NETCODE_NAMES.join(', ')}.`),
        ports: z
          .array(
            z.object({
              port: z.number().int(),
              protocol: z.string(),
              name: z.string().optional(),
              tls_upgrade: z.boolean().optional().describe('TLS Upgrade (wss/https) on a WS or HTTP port, for browser clients.'),
            })
          )
          .optional()
          .describe('Ports you plan to pass to edgegap_create_app_version.'),
        cpu_units: z.number().int().optional(),
        memory_mb: z.number().int().optional(),
        docker_repository: z.string().optional(),
        docker_image: z.string().optional(),
        docker_tag: z.string().optional(),
      },
      outputSchema: OUTPUT.validateServerConfig,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const { engine, errors, warnings } = validateServerConfig(args);
      // A known-good starting point when there is nothing to check, or what was
      // checked is broken. Only for engines with a real default binary name.
      const reference =
        engine !== 'other' && (args.dockerfile === undefined || errors.length > 0)
          ? generateDockerfile({ engine, ports: args.ports, netcode: args.netcode }).dockerfile
          : undefined;
      const verdict = errors.length > 0 ? 'fail' : warnings.length > 0 ? 'pass_with_warnings' : 'pass';

      return withMeta(ok({
        verdict,
        engine,
        errors,
        warnings,
        checked: {
          dockerfile: args.dockerfile !== undefined,
          ports: args.ports !== undefined,
          resources: args.cpu_units !== undefined || args.memory_mb !== undefined,
          image: args.docker_tag !== undefined || args.docker_image !== undefined,
        },
        reference_dockerfile: reference,
        next_step:
          verdict === 'fail'
            ? 'Fix every error and call this again before building. Do not build or push an image that ' +
              'fails here. edgegap_generate_dockerfile can write a correct one for this project.'
            : 'Build with "docker build --platform linux/amd64 -t <image>:<unique-tag> ." and run it ' +
              'locally with the same port mapping to confirm it starts. Then push it; ' +
              'edgegap_get_registry_credentials gives you a registry and the exact commands.',
      }), {
        props: {
          validation_result: errors.length > 0 ? 'fail' : 'pass',
          issue_count: errors.length + warnings.length,
          error_count: errors.length,
          warning_count: warnings.length,
          engine,
          checked_dockerfile: args.dockerfile !== undefined,
        },
      });
    }
  );

  // --------------------------------------------------------------- 12 ----
  // Mutating-only: it can provision the registry project, and it hands a
  // secret to the agent. A read-only session has no business receiving one.
  if (mutating) {
    tool(
      'edgegap_get_registry_credentials',
      {
        title: 'Get Edgegap container registry push credentials',
        description:
          'Get the push login for this organization\'s private Edgegap container registry ' +
          '(registry.edgegap.com) and the exact docker login, build and push commands for your ' +
          'image. Use this when the server image is not in a registry yet. Edgegap only hands ' +
          'these credentials to the quick-start token the Unity/Unreal plugins use; with a ' +
          'regular API token this tool cannot fetch them and instead returns the steps to copy ' +
          'them from the dashboard\'s Container Registry page — ask the developer for them then, ' +
          'do not retry. When it does return a token, it is registry-scoped (push/pull images in ' +
          'this project), not the org API token: pass it to docker login via --password-stdin, ' +
          'never as a command-line argument, and do not write it into files. Call ' +
          'edgegap_validate_server_config before building. Any other registry Edgegap can pull from ' +
          '(Docker Hub, GHCR, ECR, GitLab) works too: then skip this tool and pass that registry and its ' +
          'pull login to edgegap_create_app_version.',
        inputSchema: {
          image_name: z
            .string()
            .regex(/^[a-z0-9]+([._-][a-z0-9]+)*$/, 'lowercase letters, digits, ".", "_" or "-"')
            .optional()
            .describe('Image name without project or tag, e.g. "my-game-server". Used to build the commands.'),
          tag: z
            .string()
            .optional()
            .describe('Unique build tag for the commands, e.g. a build ID. Never "latest".'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ image_name, tag }) =>
        guard(auth, async () => {
          const tagProblem = tag === undefined ? undefined : badTag(tag);
          if (tagProblem) return fail(`Refused: ${tagProblem}. ${TAG_FIX}`);

          // Both wizard endpoints answer 403 to a regular API token: they belong
          // to the plugins' quick-start flow. 403 is the token type, not a
          // missing registry, so it must not trigger provisioning (which only
          // fails with a second, more confusing 403). Only a 404 — a
          // quick-start token whose project is not provisioned yet — does.
          const unavailable = () => manualStepsResult(registryCredentialsUnavailable(image_name, tag));
          let creds;
          try {
            creds = await client.getRegistryCredentials();
          } catch (err) {
            if (!(err instanceof EdgegapApiError)) throw err;
            if (err.status === 403) return unavailable();
            if (err.status !== 404) throw err;
            try {
              await client.initQuickStart('mcp');
            } catch (initErr) {
              if (initErr instanceof EdgegapApiError && initErr.status === 403) return unavailable();
              throw initErr;
            }
            creds = await client.getRegistryCredentials();
          }

          if (!creds.project || !creds.username || !creds.token) return unavailable();

          const host = (creds.registry_url || 'registry.edgegap.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
          const image = image_name ?? '<image-name>';
          const buildTag = tag ?? '<unique-build-tag>';
          const ref = `${host}/${creds.project}/${image}:${buildTag}`;

          return withMeta(ok({
            registry_url: host,
            project: creds.project,
            username: creds.username,
            token: creds.token,
            image_ref: ref,
            commands: {
              login:
                `printf '%s' "$EDGEGAP_REGISTRY_TOKEN" | docker login ${host} -u '${creds.username}' --password-stdin`,
              build: `docker build --platform linux/amd64 -t ${ref} .`,
              push: `docker push ${ref}`,
            },
            for_create_app_version: {
              docker_repository: host,
              docker_image: `${creds.project}/${image}`,
              docker_tag: buildTag,
              registry_username: creds.username,
              registry_token: '<the token above>',
            },
            next_step:
              'Export the token as EDGEGAP_REGISTRY_TOKEN in the shell that runs docker login ' +
              '(it never needs to appear in a command line or file), then build and push. ' +
              `Confirm the push with edgegap_list_registry_tags (image_name "${image}", without the project), ` +
              'then call edgegap_create_app_version with the values in for_create_app_version.',
          }), { milestones: ['registry_credentials_ok'], props: { registry_status: 'credentials_returned' } });
        })
    );
  }

  // --------------------------------------------------------------- 13 ----
  tool(
    'edgegap_list_registry_tags',
    {
      title: 'List image tags in the Edgegap registry',
      description:
        'List the tags pushed for one image in this organization\'s Edgegap container registry, ' +
        'with push time and size. Call it after docker push to confirm the tag landed before ' +
        'edgegap_create_app_version, which otherwise fails later with an image-pull error. An image ' +
        'that was never pushed comes back as status "not_found" with no tags, not as an error. Only ' +
        'for registry.edgegap.com: images in Docker Hub, GHCR or another registry are not listed here.',
      inputSchema: {
        image_name: z
          .string()
          .min(1)
          .describe(
            'The image name only, without the project, registry host or tag, e.g. "my-game-server". ' +
              'The API reads the project from your token; "<project>/my-game-server" is not found.'
          ),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().optional().describe('1-100. Default 20.'),
      },
      outputSchema: OUTPUT.listRegistryTags,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ image_name, page, limit }) =>
      guard(auth, async () => {
        // Agents often pass the full reference they pushed. Reduce it to what
        // the API wants: no "registry.edgegap.com/" host, no ":tag".
        let name = imageNameOnly(image_name);

        const query = { page, limit: clamp(limit, 1, 100, 20) };
        const notFound = (err: unknown) => err instanceof EdgegapApiError && err.status === 404;
        let res;
        try {
          try {
            res = await client.listRegistryTags(name, query);
          } catch (err) {
            // Nested image names are valid, so try the name as given first. If
            // it is "<project>/<image>", that 404s; retry without the project.
            if (!notFound(err) || !name.includes('/')) throw err;
            name = name.slice(name.indexOf('/') + 1);
            res = await client.listRegistryTags(name, query);
          }
        } catch (err) {
          // Nothing pushed under that name is a state, not a failure: the
          // answer to "did my push land?" is "no, push it".
          if (notFound(err)) {
            return emptyState(
              'not_found',
              { image_name: name, total: 0, tags: [] },
              `Nothing has been pushed as "${name}" to this organization's Edgegap registry. Check the name (image ` +
                'name only, as used after "registry.edgegap.com/<project>/" in docker push), or push the image ' +
                'first (edgegap_get_registry_credentials has the commands). If the image lives in Docker Hub, GHCR ' +
                'or another registry, skip this check and pass that registry to edgegap_create_app_version.'
            );
          }
          if (err instanceof EdgegapApiError && err.status === 403) {
            return emptyState(
              'not_configured',
              { image_name: name, total: 0, tags: [] },
              'This token cannot read an Edgegap container registry for this organization (403). Ask the developer ' +
                'to open the Container Registry page of the dashboard (https://app.edgegap.com), or push the image to ' +
                'Docker Hub, GHCR or another registry and pass it to edgegap_create_app_version with its pull login.'
            );
          }
          throw err;
        }

        const tags = (res.data ?? []).map((t) => ({
          tag: t.tag,
          pushed: t.last_push_at,
          size_mb: t.artifact?.size_mb,
          digest: t.artifact?.image_hash,
        }));
        const hasNext = res.pagination?.has_next === true;
        if (tags.length === 0 && !hasNext && (page ?? 1) === 1) {
          return emptyState(
            'empty',
            { image_name: name, total: 0, tags: [] },
            `The image "${name}" exists but has no tags. Push a build with a unique tag (never "latest"), then check again.`
          );
        }
        return withMeta(
          ok({
            image_name: name,
            note: name !== image_name ? `Looked up "${name}". Pass the image name only next time.` : undefined,
            total: res.count ?? tags.length,
            ...(hasNext
              ? {
                  showing: tags.length,
                  truncated: true,
                  next_step: `Only page ${page ?? 1} is shown. Call again with page: ${(page ?? 1) + 1} before concluding a tag is missing.`,
                }
              : {
                  next_step:
                    'If the tag you pushed is listed, register it with edgegap_create_app_version (docker_repository ' +
                    `"registry.edgegap.com", docker_image "<project>/${name}", and that tag).`,
                }),
            tags,
          }),
          { props: { item_count: tags.length }, milestones: tags.length ? ['image_pushed'] : [] }
        );
      })
  );

  // --------------------------------------------------------------- 13b ----
  if (mutating) {
    tool(
      'edgegap_delete_registry_tag',
      {
        title: 'Delete one image tag from the Edgegap registry',
        description:
          'Delete one tag, and the image it points to, from this organization\'s Edgegap container ' +
          'registry, to clean up old builds. Takes exactly one image name and one exact tag; ' +
          'wildcards, lists and "latest" are refused, and there is no bulk delete. A version that ' +
          'still uses the tag can no longer start deployments, so check edgegap_list_app_versions ' +
          'first. Cannot be undone.',
        inputSchema: {
          image_name: z.string().min(1).describe('The image name only, e.g. "my-game-server", as for edgegap_list_registry_tags.'),
          tag: z.string().describe('The exact tag to delete, e.g. "build-41".'),
          dry_run: dryRunParam,
        },
        annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ image_name, tag, dry_run }) =>
        guard(auth, async () => {
          let name = imageNameOnly(image_name);
          if (!/^[a-z0-9][a-z0-9._\/-]{0,254}$/.test(name)) {
            return fail(`"${image_name.slice(0, 80)}" is not a single image name. Pass one, e.g. "my-game-server".`);
          }
          if (badTag(tag) || tag.toLowerCase() === 'latest') {
            return fail(`"${tag.slice(0, 80)}" is not one exact tag. Pass a single tag as listed by edgegap_list_registry_tags; "latest" and wildcards are refused.`);
          }
          if (dry_run) {
            const dry = client.dryRun();
            await dry.client.deleteRegistryTag(name, tag);
            return dryRunResult(dry.requests, name !== image_name ? [`Looked up "${name}".`] : []);
          }
          const notFound = (err: unknown) => err instanceof EdgegapApiError && err.status === 404;
          try {
            let res;
            try {
              res = await client.deleteRegistryTag(name, tag);
            } catch (err) {
              // As in edgegap_list_registry_tags: "<project>/<image>" 404s, and
              // a 404 deleted nothing, so retry once without the project.
              if (!notFound(err) || !name.includes('/')) throw err;
              name = name.slice(name.indexOf('/') + 1);
              res = await client.deleteRegistryTag(name, tag);
            }
            return ok({
              image_name: name,
              deleted_tag: res.deleted_tag ?? tag,
              image_deleted: res.artifact?.artifact_deleted,
              freed_mb: res.artifact?.artifact_deleted ? res.artifact?.size_mb : undefined,
              tags_still_on_that_image: res.artifact?.remaining_tags?.length ? res.artifact.remaining_tags : undefined,
            });
          } catch (err) {
            if (notFound(err)) {
              return fail(`No tag "${tag}" on image "${name}" in this organization's registry. List tags with edgegap_list_registry_tags.`);
            }
            throw err;
          }
        })
    );
  }

  // ============================================ deployment housekeeping ====

  // --------------------------------------------------------------- 13c ----
  if (mutating) {
    tool(
      'edgegap_tag_deployment',
      {
        title: 'Add or remove tags on a running deployment',
        description:
          'Add tags to, or remove tags from, one running deployment, e.g. to mark the match it serves or ' +
          'that a test is done, so edgegap_list_deployments can filter on them. Tags are labels only: the ' +
          'game server does not see the change. The "' + AGENT_TAG + '" tag cannot be removed, since it is ' +
          'how agent deployments are found and cleaned up. Returns the tags now on the deployment.',
        inputSchema: {
          request_id: z.string().describe('The exact request_id of the deployment.'),
          add: z.array(z.string().min(1).max(40)).optional().describe('Tags to add, at most 40 characters each.'),
          remove: z.array(z.string().min(1).max(40)).optional().describe('Tags to remove.'),
          dry_run: dryRunParam,
        },
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ request_id, add, remove, dry_run }) =>
        guarded(auth, NOT_FOUND.deployment, async () => {
          const bad = checkRequestId(request_id);
          if (bad) return bad;
          const toAdd = [...new Set(add ?? [])];
          const toRemove = [...new Set(remove ?? [])];
          if (toAdd.length === 0 && toRemove.length === 0) return fail('Nothing to change: pass add, remove or both.');
          if (toRemove.some((t) => t === AGENT_TAG || t === 'mcp')) {
            return fail(`Refused: "${AGENT_TAG}" marks deployments an agent started and stays on. Nothing was sent.`);
          }
          const both = toAdd.filter((t) => toRemove.includes(t));
          if (both.length) return fail(`${both.join(', ')}: in both add and remove. Pick one.`);
          const leak = await tokenLeak(auth, dry_run, toAdd.map((t): [string, string] => [`tag "${t.slice(0, 8)}…"`, t]));
          if (leak) return leak;
          if (dry_run) {
            const dry = client.dryRun();
            for (const t of toAdd) await dry.client.addDeploymentTag(request_id, t);
            for (const t of toRemove) await dry.client.removeDeploymentTag(request_id, t);
            return dryRunResult(dry.requests);
          }
          const current = new Set(((await client.listDeploymentTags(request_id)).tags ?? []).map((t) => t.name));
          const notes: string[] = [];
          for (const t of toAdd) {
            if (current.has(t)) notes.push(`"${t}" was already on it.`);
            else await client.addDeploymentTag(request_id, t);
          }
          for (const t of toRemove) {
            if (!current.has(t)) notes.push(`"${t}" was not on it.`);
            else await client.removeDeploymentTag(request_id, t);
          }
          const after = ((await client.listDeploymentTags(request_id)).tags ?? []).map((t) => t.name);
          return withMeta(ok({ request_id, tags: after, ...(notes.length ? { notes } : {}) }), { hash: { request_id } });
        })
    );

    tool(
      'edgegap_report_deployment',
      {
        title: 'Report a deployment to Edgegap',
        description:
          'Report a problem with one deployment to Edgegap (the API\'s "Report a Deployment", meant for a ' +
          'studio\'s moderation backend), with a short reason and optional key/value details. It does not stop ' +
          'the deployment. Use it only when the developer asks to report a deployment; for a crash, read ' +
          'edgegap_get_deployment_logs first.',
        inputSchema: {
          request_id: z.string().describe('The exact request_id of the deployment.'),
          reason: z.string().min(1).max(255).describe('Why it is reported, 1-255 characters.'),
          metadata: z.record(z.string(), z.string()).optional().describe('Extra key/value details, e.g. {"match_id": "m-42"}.'),
          dry_run: dryRunParam,
        },
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ request_id, reason, metadata, dry_run }) =>
        guarded(auth, NOT_FOUND.deployment, async () => {
          const bad = checkRequestId(request_id);
          if (bad) return bad;
          const leak = await tokenLeak(auth, dry_run, [
            ['reason', reason],
            ...Object.entries(metadata ?? {}).flatMap(([k, v]): Array<[string, string]> => [[`metadata key "${k.slice(0, 40)}"`, k], [`metadata "${k.slice(0, 40)}"`, v]]),
          ]);
          if (leak) return leak;
          const body = { reason, ...(metadata ? { metadata } : {}) };
          if (dry_run) {
            const dry = client.dryRun();
            await dry.client.reportDeployment(request_id, body);
            return dryRunResult(dry.requests);
          }
          await client.reportDeployment(request_id, body);
          return withMeta(ok({ request_id, reported: true, note: 'The deployment keeps running; stop it separately if needed.' }), {
            hash: { request_id },
          });
        })
    );

    tool(
      'edgegap_delete_app_version',
      {
        title: 'Delete one application version',
        description:
          'Delete one version of an application, to clean up test versions. Exactly one exact version name; ' +
          'refused while any deployment of that version is running. The container image stays in the registry ' +
          '(edgegap_delete_registry_tag removes it). Cannot be undone, so confirm with the developer when the ' +
          'version is not one this conversation created.',
        inputSchema: {
          application: z.string().describe('Application name.'),
          version: z.string().min(1).describe('The exact version name to delete.'),
          dry_run: dryRunParam,
        },
        annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ application, version, dry_run }) =>
        guarded(auth, NOT_FOUND.app, async () => {
          assertAppAllowed(config, application);
          const badName = exactName(version, 'version');
          if (badName) return badName;
          if (dry_run) {
            const dry = client.dryRun();
            await dry.client.deleteAppVersion(application, version);
            return dryRunResult(dry.requests, ['A real call first checks that no deployment of this version is running.']);
          }
          const running = await runningOf(application, version);
          if (running.length) return refusedRunning(`version "${version}"`, running);
          await client.deleteAppVersion(application, version);
          return ok({ application, deleted_version: version, image_kept: 'The registry image was not touched.' });
        })
    );

    tool(
      'edgegap_delete_app',
      {
        title: 'Delete an application and all its versions',
        description:
          'Delete one application and every version under it, to clean up a test application. Exactly one ' +
          'exact name; refused while any of its deployments is running, and refused when it has more versions ' +
          'than max_versions (default 0: delete its versions first with edgegap_delete_app_version, or raise ' +
          'max_versions after the developer agreed). Registry images are not touched. Cannot be undone.',
        inputSchema: {
          application: z.string().min(1).describe('The exact application name to delete.'),
          max_versions: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe('Delete only if it has at most this many versions. Default 0.'),
          dry_run: dryRunParam,
        },
        annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ application, max_versions, dry_run }) =>
        guarded(auth, NOT_FOUND.app, async () => {
          assertAppAllowed(config, application);
          const badName = exactName(application, 'application');
          if (badName) return badName;
          if (dry_run) {
            const dry = client.dryRun();
            await dry.client.deleteApp(application);
            return dryRunResult(dry.requests, ['A real call first checks its versions and running deployments.']);
          }
          const versions = ((await client.listAppVersions(application)).versions ?? []).map((v) => v.name);
          const limit = max_versions ?? 0;
          if (versions.length > limit) {
            return fail(
              `Refused: "${application}" has ${versions.length} version${versions.length === 1 ? '' : 's'} ` +
                `(${versions.slice(0, 10).join(', ')}${versions.length > 10 ? ', …' : ''}), more than max_versions ` +
                `(${limit}). Nothing was deleted. Delete them with edgegap_delete_app_version, or pass max_versions ` +
                `${versions.length} once the developer agreed to delete them all.`
            );
          }
          const running = await runningOf(application);
          if (running.length) return refusedRunning(`application "${application}"`, running);
          await client.deleteApp(application);
          return ok({ deleted_application: application, deleted_versions: versions });
        })
    );
  }

  /** Request IDs of running deployments of an application (and version). */
  async function runningOf(application: string, version?: string): Promise<string[]> {
    const filters: Array<Record<string, unknown>> = [{ field: 'application', operator: 'eq', value: application }];
    if (version) filters.push({ field: 'version', operator: 'eq', value: version });
    const res = await client.listDeployments({ query: JSON.stringify({ filters }), limit: 10 });
    return (res.data ?? []).map((d) => d.request_id).filter(Boolean);
  }

  function refusedRunning(what: string, running: string[]): ToolResult {
    return fail(
      `Refused: ${what} still has running deployments (${running.join(', ')}${running.length === 10 ? ', …' : ''}). ` +
        'Nothing was deleted. Stop them with edgegap_stop_deployment first, if the developer agrees.'
    );
  }

  // ============================================ private fleets and storage ====

  // --------------------------------------------------------------- 13d ----
  tool(
    'edgegap_list_fleet_hosts',
    {
      title: 'List the hosts of a private fleet',
      description:
        'List the hosts in one of the organization\'s private fleets (dedicated machines Edgegap manages for ' +
        'you), with status, IP and location. Only ACTIVE hosts accept deployments. Pass their host_id values to ' +
        'edgegap_deploy as private_host_ids to place a server on them first. Organizations without private ' +
        'fleets get an error from the API.',
      inputSchema: {
        fleet_name: z.string().min(1).describe('The private fleet name, as shown in the dashboard.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ fleet_name }) =>
      guard(auth, async () => {
        const hosts = ((await client.listFleetHosts(fleet_name)).data ?? []).map((h) => ({
          host_id: h.host_id,
          status: h.status,
          ip_address: h.ip_address,
          city: h.city,
          country: h.country,
          continent: h.continent,
        }));
        if (hosts.length === 0) {
          return emptyState('empty', { fleet_name, hosts: [] }, 'This fleet has no hosts yet. Add hosts in the dashboard, or deploy to the cloud without private_host_ids.');
        }
        const active = hosts.filter((h) => h.status === 'ACTIVE').length;
        return ok({ fleet_name, total: hosts.length, active, hosts, next_step: active ? 'Pass ACTIVE host_id values to edgegap_deploy as private_host_ids.' : 'No host is ACTIVE yet; deployments would overflow to the cloud.' });
      }, `no private fleet named "${fleet_name}" in this organization. Check the name in the dashboard.`)
  );

  tool(
    'edgegap_list_endpoint_storage',
    {
      title: 'List Endpoint Storage and pull profiles',
      description:
        'List the organization\'s Endpoint Storage: S3-compatible buckets Edgegap exports container logs to ' +
        'when a deployment ends (so logs survive the deployment), and the pull profiles under each, which copy ' +
        'files from the bucket into a container at boot. Secret keys are never returned. A version uses a storage ' +
        'for logs through edgegap_create_app_version / edgegap_update_app_version endpoint_storage, and a pull ' +
        'profile through edgegap_link_pull_profile.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guard(auth, async () => {
        const endpoints = (await client.listEndpointStorage()).endpoints ?? [];
        if (endpoints.length === 0) {
          return emptyState(
            'not_configured',
            { endpoints: [] },
            'No Endpoint Storage yet. To keep logs after deployments stop, create one with edgegap_create_endpoint_storage ' +
              '(the developer supplies the bucket and its access keys), then set endpoint_storage on the version.'
          );
        }
        const withProfiles = await Promise.all(
          endpoints.map(async (e) => ({
            name: e.name,
            endpoint: e.endpoint,
            bucket: e.bucket,
            access_key_id: e.access_key_id,
            container_log_version: e.container_log_version,
            output_format: e.output_format,
            pull_profiles: await client
              .listPullProfiles(e.name)
              .then((r) => (r.pull_profiles ?? []).map((pp) => ({ name: pp.name, source: pp.source, source_type: pp.source_type, destination: pp.destination })))
              .catch(() => 'could not be listed'),
          }))
        );
        return ok({ total: withProfiles.length, endpoints: withProfiles });
      })
  );

  if (mutating) {
    tool(
      'edgegap_create_endpoint_storage',
      {
        title: 'Create an Endpoint Storage (S3 bucket for logs)',
        description:
          'Register an S3-compatible bucket (AWS S3, Cloudflare R2, DigitalOcean Spaces, ...) as Endpoint Storage, ' +
          'so container logs are exported there when deployments end. The developer supplies the bucket, endpoint ' +
          'URL and an access key pair scoped to that bucket; never invent or reuse other credentials, and never pass ' +
          'the Edgegap API token. The secret key is sent once and never echoed back. Then set endpoint_storage on the ' +
          'version (edgegap_update_app_version) to turn log export on.',
        inputSchema: {
          name: z.string().min(1).describe('Name for this storage, e.g. "game-logs".'),
          endpoint: z.string().describe('https URL of the S3 endpoint, without the bucket, e.g. "https://s3.us-east-1.amazonaws.com".'),
          bucket: z.string().min(1).describe('Bucket name.'),
          access_key_id: z.string().min(1).describe('Access key ID for the bucket.'),
          secret_access_key: z.string().min(1).describe('Secret access key for the bucket. Never echoed back.'),
          output_format: z.enum(['TEXT', 'NDJSON']).optional().describe('Log file format. Default TEXT.'),
          container_log_version: z
            .enum(['v1', 'v2'])
            .optional()
            .describe('v1 (default) writes one file per deployment; v2 streams chunks while it runs.'),
          dry_run: dryRunParam,
        },
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) =>
        guard(auth, async () => {
          const leak = await tokenLeak(auth, args.dry_run, [
            ['access_key_id', args.access_key_id],
            ['secret_access_key', args.secret_access_key],
            ['endpoint', args.endpoint],
          ]);
          if (leak) return leak;
          const problem = webhookProblem(args.endpoint);
          if (problem) return fail(`endpoint ${problem.replace('Edgegap sends deployment details (IP, ports) to it', 'the bucket keys travel to it')}`);
          const body: Record<string, unknown> = {
            name: args.name,
            endpoint: args.endpoint,
            bucket: args.bucket,
            access_key_id: args.access_key_id,
            secret_access_key: args.secret_access_key,
            ...(args.output_format ? { output_format: args.output_format } : {}),
            ...(args.container_log_version ? { container_log_version: args.container_log_version } : {}),
          };
          if (args.dry_run) {
            const dry = client.dryRun();
            await dry.client.createEndpointStorage(body);
            return dryRunResult(dry.requests);
          }
          const res = await client.createEndpointStorage(body);
          return ok({
            name: res.name ?? args.name,
            bucket: res.bucket ?? args.bucket,
            output_format: res.output_format,
            container_log_version: res.container_log_version,
            next_step: `Turn on log export with edgegap_update_app_version endpoint_storage: "${res.name ?? args.name}".`,
          });
        })
    );

    tool(
      'edgegap_create_pull_profile',
      {
        title: 'Create a pull profile (copy bucket files into containers)',
        description:
          'Create a pull profile under an Endpoint Storage: at boot, Edgegap copies a file or folder from the ' +
          'bucket into the container (maps, configs, large assets kept out of the image). It does nothing until ' +
          'linked to a version with edgegap_link_pull_profile. Avoid destination paths the image already uses.',
        inputSchema: {
          endpoint_storage: z.string().min(1).describe('Endpoint Storage name, from edgegap_list_endpoint_storage.'),
          name: z.string().min(1).describe('Name for the profile, e.g. "maps".'),
          source: z
            .string()
            .min(1)
            .describe(
              'Path in the bucket, starting with "/" and without a trailing "/", e.g. "/maps" or "/config/server.json". ' +
                'Letters, digits, "_", "-", "+" and "." only.'
            ),
          source_type: z.enum(['File', 'Folder']).describe('Whether source is a file or a folder.'),
          destination: z.string().min(1).describe('Absolute path in the container, e.g. "/data/maps".'),
          dry_run: dryRunParam,
        },
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) =>
        guard(auth, async () => {
          if (!args.destination.startsWith('/')) return fail('destination must be an absolute container path, e.g. "/data/maps".');
          // The API's pattern is ^((\/{1}[A-z0-9-+.]+)*)*$ (live, 2026-10-28): "maps/" is refused.
          const bucketPath = /^(\/[A-Za-z0-9_+.-]+)+$/;
          if (!bucketPath.test(args.source)) {
            const suggestion = `/${args.source.split('/').filter(Boolean).join('/')}`;
            return fail(
              `source "${args.source.slice(0, 80)}" is not a bucket path Edgegap accepts: start it with "/", drop any ` +
                `trailing "/", and use only letters, digits, "_", "-", "+" and "." in each part` +
                (bucketPath.test(suggestion) ? `, e.g. "${suggestion}".` : '.')
            );
          }
          const body = { name: args.name, source: args.source, source_type: args.source_type, destination: args.destination };
          if (args.dry_run) {
            const dry = client.dryRun();
            await dry.client.createPullProfile(args.endpoint_storage, body);
            return dryRunResult(dry.requests);
          }
          const res = await client.createPullProfile(args.endpoint_storage, body);
          return ok({
            endpoint_storage: args.endpoint_storage,
            pull_profile: res.name ?? args.name,
            next_step: 'Link it to a version with edgegap_link_pull_profile; new deployments of that version get the files.',
          });
        }, `no Endpoint Storage named "${args.endpoint_storage}". List them with edgegap_list_endpoint_storage.`)
    );

    tool(
      'edgegap_link_pull_profile',
      {
        title: 'Link or unlink a pull profile and a version',
        description:
          'Link a pull profile to an application version, so its new deployments get the bucket files at boot, or ' +
          'unlink it (unlink: true). Running deployments are not changed.',
        inputSchema: {
          endpoint_storage: z.string().min(1).describe('Endpoint Storage name.'),
          pull_profile: z.string().min(1).describe('Pull profile name.'),
          application: z.string().describe('Application name.'),
          version: z.string().describe('Version name.'),
          unlink: z.boolean().optional().describe('true removes the link instead.'),
          dry_run: dryRunParam,
        },
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async (args) =>
        guard(auth, async () => {
          assertAppAllowed(config, args.application);
          const method = args.unlink ? 'DELETE' : 'PUT';
          if (args.dry_run) {
            const dry = client.dryRun();
            await dry.client.linkPullProfile(method, args.endpoint_storage, args.pull_profile, args.application, args.version);
            return dryRunResult(dry.requests);
          }
          await client.linkPullProfile(method, args.endpoint_storage, args.pull_profile, args.application, args.version);
          return ok({
            endpoint_storage: args.endpoint_storage,
            pull_profile: args.pull_profile,
            application: args.application,
            version: args.version,
            linked: !args.unlink,
          });
        }, 'the Endpoint Storage, pull profile, application or version does not exist. Check them with edgegap_list_endpoint_storage and edgegap_list_app_versions.')
    );
  }

  // ================================================== peer-to-peer relays ====

  // --------------------------------------------------------------- 14 ----
  if (mutating) {
    tool(
      'edgegap_create_relay_session',
      {
        title: 'Create a relay session (host-client games only)',
        description:
          'A relay is NOT a game server and is not the recommended default — for a multiplayer ' +
          'match, deploy an authoritative dedicated server with edgegap_deploy instead. A relay ' +
          'only forwards traffic between players while one player\'s game acts as host and owns ' +
          'the game state: the host can cheat and has a latency advantage, the host\'s PC and ' +
          'connection cap the match, and the match ends if the host quits. Only use this when the ' +
          'developer has chosen peer-to-peer/host-client, or the netcode is already a listen ' +
          'server and a dedicated server is not an option; if that has not been established, ask ' +
          'first. Never pick it only because it needs no server image. ' +
          'Creates an Edgegap relay session for every player\'s public IP, host first, waits until ' +
          'it is ready, and returns the relay address plus per-player authorization tokens for the ' +
          'relay transport. Relay sessions are billed while open: delete test sessions with ' +
          'edgegap_delete_relay_session when finished.',
        inputSchema: {
          user_ips: z
            .array(z.string().min(3))
            .min(1)
            .describe('Public IP of each player, host first. Add late joiners with edgegap_authorize_relay_user.'),
          webhook_url: z.string().url().optional().describe('Called when the session is ready.'),
          wait_until_ready: z.boolean().optional().describe('Poll until the relay is assigned. Default true.'),
          timeout_seconds: z.number().int().min(5).max(120).optional().describe('Default 30.'),
          dry_run: dryRunParam,
        },
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ user_ips, webhook_url, wait_until_ready, timeout_seconds, dry_run }) =>
        guard(auth, async () => {
          const leak = await tokenLeak(auth, dry_run, [['webhook_url', webhook_url]]);
          if (leak) return leak;
          const body = { users: user_ips.map((ip) => ({ ip })), ...(webhook_url ? { webhook_url } : {}) };
          if (dry_run) {
            const dry = client.dryRun();
            await dry.client.createRelaySession(body);
            return dryRunResult(dry.requests);
          }
          const created = await client.createRelaySession(body);

          if (wait_until_ready === false) {
            return ok({
              ...compactRelay(created),
              next_step: `Call edgegap_get_relay_session with session_id ${created.session_id} until ready is true.`,
            });
          }

          const budgetMs = (timeout_seconds ?? 30) * 1000;
          const startedAt = Date.now();
          let intervalMs = 1000;
          let last: RelaySession = created;
          while (!last.ready && !last.error && Date.now() - startedAt < budgetMs) {
            await new Promise((r) => setTimeout(r, intervalMs));
            intervalMs = Math.min(intervalMs * 1.5, 5000);
            last = await client.getRelaySession(created.session_id);
          }

          if (last.error) {
            return fail(
              `Relay session ${created.session_id} failed: ${last.error}\n\n` +
                'Check that every IP is a public address (not 127.x, 10.x, 192.168.x), then delete ' +
                'this session with edgegap_delete_relay_session and create a new one.'
            );
          }
          if (!last.ready) {
            return fail(
              `Relay session ${created.session_id} was not ready after ${timeout_seconds ?? 30}s ` +
                `(status ${last.status ?? 'unknown'}). Call edgegap_get_relay_session to check again.`
            );
          }
          return ok({ ...compactRelay(last), waited_seconds: Math.round((Date.now() - startedAt) / 1000) });
        }, undefined, FORBIDDEN.relay)
    );
  }

  // --------------------------------------------------------------- 15 ----
  tool(
    'edgegap_get_relay_session',
    {
      title: 'Get a relay session',
      description:
        'Read one relay session: whether it is ready, the relay address and ports, and each ' +
        'authorized player with their authorization token. edgegap_create_relay_session already ' +
        'waits for readiness; use this to re-read a session or one created with wait_until_ready false.',
      inputSchema: { session_id: z.string().describe('Returned by edgegap_create_relay_session.') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session_id }) =>
      guarded(auth, NOT_FOUND.relay, async () => ok(compactRelay(await client.getRelaySession(session_id))))
  );

  // --------------------------------------------------------------- 15b ----
  tool(
    'edgegap_list_relay_sessions',
    {
      title: 'List relay sessions',
      description:
        'List this organization\'s active relay sessions: id, status, readiness and player count. ' +
        'Relay sessions bill while open, so use this to find ones left over from earlier sessions ' +
        'and delete them with edgegap_delete_relay_session. Authorization tokens are not listed; ' +
        'read one session with edgegap_get_relay_session.',
      inputSchema: {},
      outputSchema: OUTPUT.listRelaySessions,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guard(auth, async () => {
        let res;
        try {
          res = await client.listRelaySessions();
        } catch (err) {
          // An organization without relays gets 403 here. Listing has nothing
          // to correct: there are no sessions, and none can be billing.
          if (!(err instanceof EdgegapApiError) || err.status !== 403) throw err;
          return emptyState(
            'not_configured',
            { total: 0, sessions: [] },
            'This organization cannot use relays (the API answered 403), so no relay sessions exist or bill. ' +
              'Relays are not enabled on every plan; check the Relays page of the dashboard or ask Edgegap support. ' +
              'For a multiplayer match, a dedicated server (edgegap_deploy) needs no relay.'
          );
        }
        if ((res.sessions ?? []).length === 0) {
          return emptyState('empty', { total: 0, sessions: [] }, 'No relay sessions are open, so none are billing.');
        }
        const sessions = (res.sessions ?? []).map((r) => ({
          session_id: r.session_id,
          status: r.status,
          ready: r.ready,
          linked: r.linked,
          players: r.session_users?.length ?? 0,
          relay: r.relay?.host ?? r.relay?.ip ?? undefined,
          error: r.error || undefined,
        }));
        return ok({ ...pageInfo(res.total_count, sessions.length, 1), sessions });
      }, undefined, FORBIDDEN.relay)
  );

  if (mutating) {
    // ------------------------------------------------------------- 16 ----
    tool(
      'edgegap_authorize_relay_user',
      {
        title: 'Add a player to a relay session',
        description:
          'Authorize one more player (by public IP) on an existing relay session, for a player ' +
          'joining after the session was created. Returns that player\'s authorization token.',
        inputSchema: {
          session_id: z.string(),
          user_ip: z.string().min(3).describe('Public IP of the joining player.'),
          dry_run: dryRunParam,
        },
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ session_id, user_ip, dry_run }) =>
        guarded(auth, NOT_FOUND.relay, async () => {
          if (dry_run) {
            const dry = client.dryRun();
            await dry.client.authorizeRelayUser({ session_id, user_ip });
            return dryRunResult(dry.requests);
          }
          const res = await client.authorizeRelayUser({ session_id, user_ip });
          return ok({
            session_id: res.session_id,
            user_ip,
            user_authorization_token: res.session_user?.authorization_token,
            session_authorization_token: res.authorization_token,
          });
        })
    );

    // ------------------------------------------------------------- 16b ----
    tool(
      'edgegap_revoke_relay_user',
      {
        title: 'Remove a player from a relay session',
        description:
          'Revoke one player\'s access to a relay session, by that player\'s authorization token ' +
          '(from edgegap_get_relay_session or edgegap_authorize_relay_user). The player loses the ' +
          'relay connection; the session and the other players stay.',
        inputSchema: {
          session_id: z.string().describe('The relay session_id, e.g. "0724828881e2-S".'),
          user_authorization_token: z.number().int().describe('The player\'s authorization token, not the session\'s.'),
          dry_run: dryRunParam,
        },
        annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ session_id, user_authorization_token, dry_run }) =>
        guarded(auth, NOT_FOUND.relay, async () => {
          if (!SESSION_ID.test(session_id)) {
            return fail(`"${session_id.slice(0, 80)}" is not a single relay session_id. Pass exactly one, e.g. "0724828881e2-S".`);
          }
          const body = { session_id, authorization_token: user_authorization_token };
          if (dry_run) {
            const dry = client.dryRun();
            await dry.client.revokeRelayUser(body);
            return dryRunResult(dry.requests);
          }
          const res = await client.revokeRelayUser(body);
          return ok({ ...compactRelay(res), revoked: user_authorization_token });
        })
    );

    // ------------------------------------------------------------- 17 ----
    tool(
      'edgegap_delete_relay_session',
      {
        title: 'Delete a relay session',
        description:
          'Close one relay session. Connected players lose their relay connection. Delete every ' +
          'session you created for testing before ending your task. Takes exactly one session_id; ' +
          'empty IDs, wildcards and lists are refused.',
        inputSchema: {
          session_id: z.string().describe('The exact session_id of the one session to delete, e.g. "0724828881e2-S".'),
          dry_run: dryRunParam,
        },
        annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ session_id, dry_run }) =>
        guarded(auth, NOT_FOUND.relay, async () => {
          if (!SESSION_ID.test(session_id)) {
            return fail(`"${session_id.slice(0, 80)}" is not a single relay session_id. Pass exactly one, e.g. "0724828881e2-S".`);
          }
          if (dry_run) {
            const dry = client.dryRun();
            await dry.client.deleteRelaySession(session_id);
            return dryRunResult(dry.requests);
          }
          await client.deleteRelaySession(session_id);
          return ok({ session_id, result: 'deleted' });
        })
    );
  }

  // ============================================================ matchmaker ====

  // --------------------------------------------------------------- 18 ----
  // Edgegap has no public API to create a matchmaker, so this does not create
  // one. It produces the configuration the dashboard asks for, checked against
  // the application version it points at.
  tool(
    'edgegap_build_matchmaker_config',
    {
      title: 'Build a basic matchmaker configuration',
      description:
        'Generate a ready-to-upload Edgegap matchmaker JSON configuration with one profile: team ' +
        'count and size, optional latency rule, and optional expansions that relax the rules the ' +
        'longer a player waits. Checks the referenced application version exists and has ports. ' +
        'Edgegap has no API for creating a matchmaker, so this tool does NOT create one: save the ' +
        'returned config to a file (e.g. matchmaker-config.json) and have the developer upload it ' +
        'on the Matchmaker page of the dashboard. The matchmaker starts an authoritative dedicated ' +
        'server for each match, which is the recommended setup for multiplayer games.',
      inputSchema: {
        profile_name: z.string().describe('Profile clients will queue into, e.g. "casual-2v2".'),
        application: z.string().describe('Application the matchmaker deploys.'),
        version: z.string().describe('Version the matchmaker deploys.'),
        team_count: z.number().int().min(1).describe('Teams per match. 1 for free-for-all or co-op.'),
        min_team_size: z.number().int().min(1),
        max_team_size: z.number().int().min(1),
        max_latency_ms: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Adds a latency rule: drop players above this ping to the chosen region. Needs beacon pings from the client.'),
        latency_difference_ms: z.number().int().min(0).optional().describe('Max ping spread between matched players. Default 100.'),
        expansions: z
          .array(
            z.object({
              after_seconds: z.number().int().min(1),
              min_team_size: z.number().int().min(1).optional(),
              max_latency_ms: z.number().int().min(1).optional(),
            })
          )
          .optional()
          .describe('Rule relaxations after a player has waited this long, e.g. [{after_seconds: 20, min_team_size: 1}]. Keep each below ticket_expiration. Not needed for partial matches: min_team_size below max_team_size already allows them. Expansions cost the matchmaker performance, so add one only to relax a rule.'),
        ticket_expiration: z.string().optional().describe('Default "30s", so a developer testing alone is matched or told to retry within 30 s instead of waiting minutes. Raise it only for production queues.'),
        inspect: z.boolean().optional().describe('Expose the inspection API for debugging. Default true; turn off for production.'),
        verify_version: z.boolean().optional().describe('Look up the application version first. Default true.'),
        allowed_cors_origins: z
          .array(z.string())
          .optional()
          .describe(
            'Origins of web pages allowed to call the matchmaker, e.g. ["https://mygame.example.com", ' +
              '"http://localhost:8080"]. Required when game clients run in a browser (WebGL): browsers ' +
              'block matchmaker calls from any origin not listed. Scheme and host only, no path.'
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      guarded(auth, NOT_FOUND.app, async () => {
        assertAppAllowed(config, args.application);
        const { config: mmConfig, problems, cautions } = buildMatchmakerConfig(args);
        let verified = false;

        if (args.verify_version !== false) {
          try {
            const res = await client.listAppVersions(args.application);
            const v = (res.versions ?? []).find((x) => x.name === args.version);
            if (!v) {
              problems.push(
                `Version "${args.version}" was not found in application "${args.application}". ` +
                  'Create it with edgegap_create_app_version, or pick one from edgegap_list_app_versions.'
              );
            } else {
              if (v.is_active === false) problems.push(`Version "${args.version}" is inactive, so the matchmaker cannot deploy it.`);
              if (!v.ports?.length) problems.push(`Version "${args.version}" has no ports, so matched players have nothing to connect to.`);
            }
            verified = true;
          } catch (err) {
            if (err instanceof EdgegapApiError && err.status === 404) {
              problems.push(`Application "${args.application}" does not exist. Call edgegap_list_apps.`);
            } else if (err instanceof TokenUnavailableError && err.reason !== 'declined') {
              // Building the config needs no token; only the version check
              // does. Without one, hand back the config and say what was skipped.
              cautions.push(
                `Not checked against Edgegap: this session has no API token, so whether "${args.application}/${args.version}" ` +
                  'exists, is active and has ports was not verified. Check it in the dashboard before uploading.'
              );
            } else {
              throw err;
            }
          }
        }

        const facts: CallMeta = {
          props: {
            matchmaker_template: 'single_profile',
            team_count: args.team_count,
            has_latency_rule: args.max_latency_ms !== undefined,
            expansion_count: args.expansions?.length ?? 0,
            problem_count: problems.length,
            version_verified: verified,
          },
        };
        if (problems.length > 0) {
          return withMeta(
            fail(
              `The matchmaker configuration has ${problems.length} problem${problems.length === 1 ? '' : 's'}; fix all of them before uploading:\n- ` +
                problems.join('\n- ') +
                `\n\nDraft config:\n${JSON.stringify(mmConfig, null, 2)}`,
              'VALIDATION_FAILED'
            ),
            facts
          );
        }

        return withMeta(ok({
          config: mmConfig,
          cautions: cautions.length ? cautions : undefined,
          next_steps: [
            'Write config to matchmaker-config.json in the project.',
            `The developer uploads it in the dashboard (${DASHBOARD_URL}, Matchmaker page, Create Matchmaker) and waits for it to show as ready. The free tier runs on a shared test cluster for up to 3 hours per restart.`,
            'The dashboard then shows the matchmaker API URL and auth token. Each game client calls POST {api_url}/tickets ' +
              `with header "Authorization: <auth token>" and profile "${args.profile_name}", then polls GET {api_url}/tickets/{id} (same header) every few seconds. ` +
              'The status goes SEARCHING, then MATCH_FOUND, then HOST_ASSIGNED; at HOST_ASSIGNED, connect to assignment.fqdn on the external port in assignment.ports (e.g. assignment.ports.gameport.external, keyed by the port name of the app version). ' +
              'DELETE {api_url}/tickets/{id} cancels a search.',
            'Parties that must land in the same match use the group API instead (POST {api_url}/groups, then memberships for the other players; see the matchmaker API docs on the dashboard). ' +
              '/memberships endpoints belong to groups only: a plain ticket is polled at /tickets/{id}.',
            'That auth token is safe to ship in game clients: it grants no access to the Edgegap API.',
            args.allowed_cors_origins?.length
              ? `Browser clients are allowed from: ${args.allowed_cors_origins.join(', ')}. Add any other origin the game is served from (each staging or production URL) before uploading.`
              : 'If game clients run in a browser (WebGL), set allowed_cors_origins to the origin of every page that serves the game, including http://localhost:<port> for local testing, or browsers will block the matchmaker calls.',
          ],
        }), facts);
      })
  );

  registerSkills(server, tool, config, options);
}

// ==================================================================== skills ====

/**
 * Serves the bundled Edgegap agent skills three ways, because MCP clients
 * differ in what they surface:
 *   - tools (edgegap_list_skills, edgegap_get_skill): every agent can call these;
 *   - prompts, one per skill: slash commands in clients that show prompts;
 *   - resources, one per file: for clients that browse or @-mention resources.
 * All three read the same bundle (src/skills.generated.ts). No token, no network.
 */
function registerSkills(
  server: McpServer,
  tool: McpServer['registerTool'],
  config: Config,
  options: RegisterOptions
): void {
  const hosted = config.transport === 'hosted';
  const check = options.skillsCheck ?? skillsCheckFromEnv(typeof process === 'undefined' ? {} : process.env);
  const local = hosted ? undefined : options.localSkills;
  const names = SKILLS_PACK.skills.map((s) => s.name);
  const pack = `${SKILLS_PACK.version} (${SKILLS_PACK.commit.slice(0, 7)})`;
  const howToFetch = (skill: string) =>
    `Fetch any of these with edgegap_get_skill {skill: "${skill}", file: "<path>"}, or read the ` +
    `resource ${skillUri(skill, '<path>')}. Template files are meant to be copied into the project ` +
    'where the skill says.';

  tool(
    'edgegap_list_skills',
    {
      title: 'List the Edgegap agent skills',
      description:
        'List the Edgegap agent skills: tested, step-by-step workflows for getting a multiplayer ' +
        'game online on Edgegap, with templates (Dockerfiles, matchmaker configs, Unity C# and ' +
        'Unreal C++ drop-ins) and known pitfalls. Each entry says which engine, netcode or backend ' +
        'it is for, and the server instructions map projects to skills. Before working on a game ' +
        'project, load the matching skill with edgegap_get_skill; "edgegap" covers any other engine ' +
        'and routes to the rest. Also says whether a newer skills pack is on GitHub (reads one ' +
        'version number, no Edgegap API call).',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const status = servedPackStatus(await latestPack(check), hosted);
      return ok({
        pack,
        ...status,
        source: SKILLS_PACK.source,
        skills: SKILLS_PACK.skills.map((s) => ({
          name: s.name,
          version: s.version,
          description: s.description,
          files: s.files.length,
        })),
        next_step:
          'Load the skill that matches the project with edgegap_get_skill, then follow it. ' +
          'If the developer also has Edgegap skills installed in their agent (a skills folder or the Claude Code plugin), ' +
          'edgegap_update_skills checks whether those copies are current.',
      });
    }
  );

  tool(
    'edgegap_get_skill',
    {
      title: 'Load an Edgegap agent skill',
      description:
        'Load one Edgegap agent skill: its SKILL.md (the workflow to follow) by default, or one of ' +
        'its reference documents or templates with file. Load the skill that matches the project ' +
        'before acting (the server instructions and edgegap_list_skills say which; "edgegap" when ' +
        'unsure), then fetch the references and templates it points to as you reach them. No API call.',
      inputSchema: {
        // A string, not an enum: clients cache tool schemas, and a cached enum from an older
        // release would refuse a skill the router already points to. The handler checks the name.
        skill: z
          .string()
          .describe(`Skill name, from edgegap_list_skills: ${names.join(', ')}.`),
        file: z
          .string()
          .optional()
          .describe('A file inside the skill, e.g. "references/deploy.md" or "assets/docker/Dockerfile". Default SKILL.md.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ skill: name, file }) => {
      const skill = findSkill(name);
      if (!skill) {
        const guess = closestSkill(name, names);
        return withMeta(
          fail(
            `No skill named "${name}".${guess ? ` Did you mean "${guess}"?` : ''} The skills are: ${names.join(', ')}.`,
            'SKILL_NOT_FOUND'
          ),
          { props: { skill_name: name.slice(0, 60) } }
        );
      }
      const found = findSkillFile(skill, file);
      if (!found) {
        return withMeta(
          fail(
            `"${file}" is not a file in the ${skill.name} skill. Its files are:\n` +
              ['SKILL.md', ...fileIndex(skill)].map((p) => `- ${p}`).join('\n'),
            'SKILL_NOT_FOUND'
          ),
          { props: { skill_name: skill.name, skill_file: String(file).slice(0, 120) } }
        );
      }
      const status = found.path === 'SKILL.md' ? servedPackStatus(await latestPack(check), hosted) : undefined;
      const header =
        `${skill.name} ${skill.version} · ${found.path} · pack ${pack}` +
        (status?.update ? `\nNote: ${status.update}` : '');
      const others = found.path === 'SKILL.md' ? fileIndex(skill) : [];
      const footer = others.length
        ? `\n\n---\nOther files in this skill:\n${others.map((p) => `- ${p}`).join('\n')}\n\n${howToFetch(skill.name)}`
        : '';
      return {
        content: [{ type: 'text' as const, text: `${header}\n\n${found.content}${footer}` }],
        meta: { props: { skill_name: skill.name, skill_file: found.path, resource_uri: skillUri(skill.name, found.path) } },
      };
    }
  );

  tool(
    'edgegap_update_skills',
    {
      title: 'Check and update the installed Edgegap skills',
      description:
        'Check whether the Edgegap agent skills installed in the developer\'s agent are the latest, and update them. ' +
        (hosted
          ? 'This hosted server cannot see the developer\'s disk: pass installed_versions (each loaded skill\'s ' +
            'metadata.version from its SKILL.md frontmatter) and it compares them with the latest on GitHub and says how to update. '
          : 'Finds installs made with the skills CLI (user-wide or this project), the Claude Code plugin edgegap@edgegap, and skills ' +
            'copied by hand into an agent\'s skills folder, and compares each skill with the latest on GitHub. Without apply it only ' +
            'checks and changes nothing. With apply=true it rewrites hand-copied skills from the files bundled in this server, and ' +
            'runs each outdated install\'s own updater (npx ' + SKILLS_CLI + ' update for the Edgegap skills only, or claude plugin ' +
            'update) only when the operator started the server with EDGEGAP_ENABLE_SKILLS_UPDATE=1; otherwise it lists those ' +
            'commands for the developer to run. Ask the developer before applying. ') +
        'Skill text is never downloaded by this tool. The skills served by edgegap_get_skill need no update here.',
      inputSchema: {
        ...(local
          ? {
              apply: z
                .boolean()
                .optional()
                .describe('Run the updates for outdated installs. Omit or false to only check.'),
            }
          : {}),
        installed_versions: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Skill name → version of skills you have loaded from somewhere this server cannot see, e.g. ' +
              '{"edgegap-unity": "0.1.8"}. The version is metadata.version in the SKILL.md frontmatter.'
          ),
      },
      annotations: { readOnlyHint: !local, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: { apply?: boolean; installed_versions?: Record<string, string> }) => {
      const apply = args.apply === true;
      const given = Object.entries(args.installed_versions ?? {}).filter(([n]) => SKILL_NAME_RE.test(n));
      const installs = local ? await local.findSkillsInstalls(local.env) : [];
      const wanted = [...installs.flatMap((i) => i.skills.map((s) => s.name)), ...given.map(([n]) => n)];
      const [packLatest, latest] = await Promise.all([latestPack(check), latestSkillVersions(wanted, check)]);

      type Row = { name: string; installed: string; latest: string; latest_from: string; status: 'up to date' | 'update available' | 'unknown' };
      const row = (name: string, installed: string | undefined): Row => {
        const l = latest[name];
        const status: Row['status'] =
          !l?.version || !installed ? 'unknown' : compareVersions(installed, l.version) < 0 ? 'update available' : 'up to date';
        return {
          name,
          installed: installed ?? 'no version in its SKILL.md',
          latest: l?.version ?? 'unknown (not in the pack)',
          latest_from: l?.source === 'github' ? 'GitHub main' : l?.source === 'bundled' ? 'this server\'s bundle (GitHub not reachable)' : 'unknown',
          status,
        };
      };
      const report = installs.map((i) => ({ install: i, rows: i.skills.map((s) => row(s.name, s.version)) }));
      const outdatedOf = (rows: Row[]) => rows.filter((r) => r.status !== 'up to date').map((r) => r.name);

      const result: Record<string, unknown> = {
        latest_pack: packLatest.version ?? `unknown: ${packLatest.error}`,
        installs: report.map(({ install, rows }) => ({ where: install.where, kind: install.kind, skills: rows })),
      };
      if (given.length) result.loaded_skills = given.map(([n, v]) => row(n, v));

      const anyOutdated = report.some(({ rows }) => outdatedOf(rows).length) || given.some(([n, v]) => row(n, v).status === 'update available');
      const howToUpdate =
        'Reinstall the way they were installed: npx skills add edgegap/llm-agent-skills --skill "*" (add -g for user-wide); ' +
        'in Claude Code, /plugin marketplace update edgegap then /plugin update edgegap@edgegap; or copy the skills folders from ' +
        'github.com/edgegap/llm-agent-skills again.';

      if (given.some(([n, v]) => row(n, v).status === 'update available')) result.how_to_update = howToUpdate;
      if (!local) {
        result.note = hosted
          ? 'This hosted server cannot see the developer\'s installed skills; only installed_versions was checked.'
          : 'This server does not look for installed skills; only installed_versions was checked.';
        if (anyOutdated) result.how_to_update = howToUpdate;
        return ok(result);
      }
      if (installs.length === 0) {
        result.found = 'No Edgegap skills installed in this machine\'s agent folders, project or Claude Code plugins.';
        if (anyOutdated) result.how_to_update = howToUpdate;
        return ok(result);
      }
      if (!anyOutdated) {
        result.status = 'Every installed Edgegap skill is current.';
        return ok(result);
      }

      type Step = { action: string; commands?: string[][]; skill?: InstalledSkill; canCopy?: boolean };
      const plan: Step[] = report.flatMap(({ install, rows }): Step[] => {
        const names = outdatedOf(rows);
        if (!names.length) return [];
        if (install.kind === 'copy') {
          return names.map((n) => {
            const bundled = SKILLS_PACK.skills.find((s) => s.name === n)?.version;
            const r = rows.find((x) => x.name === n)!;
            const canCopy = bundled && (r.installed === 'no version in its SKILL.md' || compareVersions(r.installed, bundled) < 0);
            return {
              skill: install.skills.find((s) => s.name === n)!,
              action: canCopy
                ? `rewrite ${n} in ${install.skills.find((s) => s.name === n)!.dir} from this server's bundle (${bundled})`
                : `${n}: GitHub has ${r.latest} but this server bundles ${bundled ?? 'nothing newer'}; recopy it from github.com/edgegap/llm-agent-skills`,
              canCopy: Boolean(canCopy),
            };
          });
        }
        const commands = local.updateCommands(install, names);
        return [{ commands, action: commands.map((c) => c.join(' ')).join(' && ') }];
      });

      if (!apply) {
        result.would_run = plan.map((p) => p.action);
        result.next_step = config.readOnly
          ? 'Read-only mode (EDGEGAP_READ_ONLY): this server will not apply updates. Run the commands above yourself.'
          : 'Ask the developer, then call edgegap_update_skills again with apply=true to run these.';
        return ok(result);
      }
      if (config.readOnly) {
        return fail('Read-only mode (EDGEGAP_READ_ONLY) is on, so skills are not updated from here. Call without apply to see the commands to run yourself.');
      }

      const applied: string[] = [];
      let failed = false;
      for (const p of plan) {
        if (p.commands && !config.enableSkillsUpdate) {
          applied.push(
            `not run (EDGEGAP_ENABLE_SKILLS_UPDATE is not set, so this server starts no updater): ${p.action}. ` +
              'The developer can run it in a terminal.'
          );
        } else if (p.commands) {
          for (const cmd of p.commands) {
            try {
              const out = await local.env.run(cmd[0], cmd.slice(1), local.env.cwd);
              applied.push(`ran: ${cmd.join(' ')}${out ? `\n${out.split('\n').slice(-10).join('\n')}` : ''}`);
            } catch (err) {
              failed = true;
              applied.push(`failed: ${(err as Error).message.split('\n').slice(0, 12).join('\n')}`);
              break;
            }
          }
        } else if (p.canCopy && p.skill) {
          try {
            applied.push(`updated: ${await local.replaceFromBundle(local.env, p.skill)}`);
          } catch (err) {
            failed = true;
            applied.push(`skipped: ${(err as Error).message}`);
          }
        } else {
          applied.push(`not updated: ${p.action}`);
        }
      }
      const after = await local.findSkillsInstalls(local.env);
      result.applied = applied;
      result.after = after.map((i) => ({ where: i.where, skills: i.skills.map((s) => row(s.name, s.version)) }));
      result.reload =
        'The running agent session keeps the skills it already loaded. Start a new session ' +
        '(in Claude Code, /reload-plugins also works for the plugin) to use the update.';
      return failed ? { ...ok(result), isError: true } : ok(result);
    }
  );

  // The one obvious place to start: a prompt that runs the golden path for
  // whatever engine and netcode the project uses.
  server.registerPrompt(
    'deploy-game-server',
    {
      title: 'Deploy my game server to Edgegap',
      description:
        'Start here. Detects the project\'s engine and netcode, loads the matching Edgegap skill, and walks the golden ' +
        'path to a running dedicated server: Dockerfile, registry, app version, deploy, wait, then stop.',
    },
    () => ({
      description: 'Deploy this project\'s game server to Edgegap',
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              'Deploy this project\'s game server to Edgegap as an authoritative dedicated server.\n\n' +
              '1. Look at the project files to find the engine (Unity, Unreal, Godot, or a Node.js/other server) and ' +
              'the netcode (NGO, FishNet, PurrNet, Mirror, Photon Fusion, Colyseus, Nakama, PlayFab...).\n' +
              '2. Load the matching skill with edgegap_get_skill (edgegap_list_skills says which; "edgegap" if unsure) ' +
              'and follow it over anything below.\n' +
              '3. Golden path: edgegap_generate_dockerfile (or edgegap_validate_server_config on an existing ' +
              'Dockerfile) → edgegap_get_registry_credentials, build and push → edgegap_list_registry_tags → ' +
              'edgegap_list_apps / edgegap_create_app → edgegap_create_app_version → edgegap_deploy → ' +
              'edgegap_wait_for_deployment → edgegap_stop_deployment when done.\n' +
              '4. Results with a status such as "empty" or "not_configured" are normal states: do what their ' +
              'next_step says instead of retrying.\n' +
              '5. Before finishing, stop every deployment you started unless I ask to keep it, and confirm with ' +
              'edgegap_list_deployments only_agent_deployments: true.\n\n' +
              'Ask me before anything you are unsure of, and use dry_run: true on a write you want to check first.',
          },
        },
      ],
    })
  );

  for (const skill of SKILLS_PACK.skills) {
    // A prompt per skill: in Claude Code these show up as slash commands.
    server.registerPrompt(
      skill.name,
      {
        title: `Edgegap skill: ${skill.name}`,
        description: skill.description,
      },
      () => {
        const main = findSkillFile(skill)!;
        const others = fileIndex(skill);
        return {
          description: skill.description,
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text:
                  `Follow this Edgegap skill (${skill.name} ${skill.version}, pack ${pack}).\n\n${main.content}` +
                  (others.length
                    ? `\n\n---\nOther files in this skill:\n${others.map((p) => `- ${p}`).join('\n')}\n\n${howToFetch(skill.name)}`
                    : ''),
              },
            },
          ],
        };
      }
    );

    // Only each skill's SKILL.md is listed: one entry per skill instead of every file
    // (257 in pack 0.15), which crowded clients' attach menus and resource
    // lists. The other files are read through the template below.
    const main = findSkillFile(skill)!;
    const uri = skillUri(skill.name, main.path);
    server.registerResource(
      `${skill.name}/${main.path}`,
      uri,
      { title: `${skill.name} skill`, description: skill.description, mimeType: mimeType(main.path) },
      async () => ({ contents: [{ uri, mimeType: mimeType(main.path), text: main.content }] })
    );
  }

  // Any file in any skill, e.g. edgegap-skill://edgegap-unreal/assets/docker/Dockerfile.
  // {+path} keeps the slashes. Not listed (list: undefined): SKILL.md says
  // which files exist, and edgegap_get_skill lists them too.
  server.registerResource(
    'edgegap-skill-file',
    new ResourceTemplate(`${skillUri('{skill}', '').replace(/\/$/, '')}/{+path}`, { list: undefined }),
    {
      title: 'Edgegap skill file',
      description: 'A reference document or template inside an Edgegap skill. SKILL.md lists the files it uses.',
    },
    async (uri, vars) => {
      const skill = findSkill(String(vars.skill));
      const file = skill ? findSkillFile(skill, String(vars.path)) : undefined;
      if (!skill || !file) {
        throw new Error(
          skill
            ? `"${vars.path}" is not a file in the ${skill.name} skill. Its files are: ${skill.files.map((f) => f.path).join(', ')}`
            : `No skill named "${vars.skill}". The skills are: ${names.join(', ')}.`
        );
      }
      return { contents: [{ uri: uri.href, mimeType: mimeType(file.path), text: file.content }] };
    }
  );
}

/**
 * What edgegap_get_registry_credentials says when Edgegap will not hand the
 * registry login to this token. Written as the manual path that works today,
 * so the agent asks the developer instead of retrying or guessing.
 */
/**
 * The registry tool's answer for a regular API token. Not an error: the tool
 * did what it can for that token type, and the steps are the next action.
 * Reported as a failure it counted every regular-token developer as a broken
 * call, and some agents retried it.
 */
function manualStepsResult(steps: string): ToolResult {
  const nextStep =
    'Ask the developer for the registry Project, Username and Token from the Container Registry page, or ' +
    'whether to use Docker Hub, GHCR or another registry instead. Do not call this tool again.';
  return {
    content: [{ type: 'text', text: `status: manual_steps_required (no credentials returned)\n\n${steps}\n\nnext_step: ${nextStep}` }],
    structuredContent: { status: 'manual_steps_required', credentials_returned: false, steps, next_step: nextStep },
    meta: { props: { registry_status: 'manual_steps_required' } },
  };
}

/** A number argument pulled into range, so an agent's limit: 500 is served
 *  as 100 instead of refused before the API is even called. */
function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Tools that need no Edgegap token, for onboarding and the token messages. */
const TOKENLESS_TOOLS = [
  'edgegap_context',
  'edgegap_list_skills',
  'edgegap_get_skill',
  'edgegap_generate_dockerfile',
  'edgegap_validate_server_config',
  'edgegap_build_matchmaker_config (without the version check)',
];

/**
 * Whether this session can call the Edgegap API, and if not, why and how to
 * fix it. Never shows the token: only its last four characters, which is
 * what the developer needs to find it on the tokens page. Edgegap has no
 * endpoint that names the organization a token belongs to, so this cannot.
 */
async function describeToken(
  client: EdgegapClient,
  auth: TokenSource,
  hosted: boolean,
  check: boolean
): Promise<Record<string, unknown> & { state: string }> {
  const fix = `Create a token at ${TOKENS_URL} (no account yet? sign up free at ${SIGNUP_URL}).`;
  if (!auth.current) {
    if (!hosted) {
      return { state: 'not_provided', note: 'The developer is asked for a token on the first call that needs one.', fix };
    }
    try {
      await auth.get();
    } catch (err) {
      const reason = err instanceof TokenUnavailableError ? err.reason : 'absent';
      return {
        state: reason,
        note:
          reason === 'foreign'
            ? 'The Authorization header holds a credential the MCP client issued itself, not an Edgegap token. ' +
              'This client cannot pass an Edgegap token to the hosted server: use the local server ' +
              '(npx -y @edgegap/mcp) with EDGEGAP_API_TOKEN instead.'
            : 'No Authorization header on this connection. Add "Authorization: token <your Edgegap token>" to the MCP client config.',
        fix,
        works_without_token: TOKENLESS_TOOLS,
      };
    }
  }
  const token = auth.current;
  const base = {
    token_ends_with: token ? `…${token.slice(-4)}` : undefined,
    organization: 'not reported: the Edgegap API has no endpoint that names a token\'s organization. Match the token by its last characters on the tokens page.',
  };
  if (!check) return { state: 'present (not checked)', ...base, note: 'Pass check_token: true to confirm Edgegap accepts it.' };
  try {
    await client.listApps({ limit: 1 });
    return { state: 'accepted', ...base };
  } catch (err) {
    if (err instanceof EdgegapApiError && err.status === 401) {
      return { state: 'rejected', ...base, note: 'Edgegap rejected this token: it was revoked, expired or mistyped.', fix };
    }
    return { state: 'unknown', ...base, note: `The check call failed: ${(err as Error).message.slice(0, 200)}` };
  }
}

const TOKENS_URL = 'https://app.edgegap.com/user-settings?tab=tokens';
const SIGNUP_URL = 'https://app.edgegap.com';

/**
 * Sends MCP progress notifications while a tool waits, when the client asked
 * for them (a progressToken in the request). Silently does nothing otherwise,
 * and a client that cannot take them never breaks the call.
 */
function progressReporter(extra: unknown, totalSeconds: number) {
  const e = extra as
    | { _meta?: { progressToken?: string | number }; sendNotification?: (n: never) => Promise<void> }
    | undefined;
  const progressToken = e?._meta?.progressToken;
  const send = e?.sendNotification;
  if (progressToken === undefined || !send) return async (_elapsedMs: number, _message: string) => {};
  return async (elapsedMs: number, message: string) => {
    try {
      await send({
        method: 'notifications/progress',
        params: { progressToken, progress: Math.round(elapsedMs / 1000), total: totalSeconds, message },
      } as never);
    } catch {
      // Progress is a courtesy; the wait goes on without it.
    }
  };
}

/**
 * Why a deployment has no logs, from its status: it does not exist (or is
 * another organization's), it has not started, or it has stopped and its logs
 * went with it. Undefined when the status does not explain it, so the caller
 * reports the original API error.
 */
async function whyNoLogs(client: EdgegapClient, requestId: string): Promise<ToolResult | undefined> {
  let d: DeploymentStatus;
  try {
    d = await client.getDeployment(requestId);
  } catch (err) {
    if (err instanceof EdgegapApiError && [400, 404].includes(err.status)) {
      return withMeta(
        fail(
          `No deployment with request_id "${requestId}" in this organization: it was never created here, belongs ` +
            'to another organization, or stopped long enough ago to be cleaned up. Check the request_id with ' +
            'edgegap_list_deployments.',
          'DEPLOYMENT_NOT_FOUND'
        ),
        { stage: 'upstream' }
      );
    }
    return undefined;
  }
  const status = (d.current_status ?? '').toUpperCase();
  if (d.error || TERMINAL_BAD.some((s) => status.includes(s))) {
    return emptyState(
      'expired',
      { request_id: requestId, deployment_status: d.current_status, error_detail: d.error_detail || undefined, logs: '' },
      'This deployment has stopped, and its container logs went with it (they are only kept when Endpoint ' +
        'Storage was set on the version). error_detail is what Edgegap kept. Fix the cause and redeploy; ' +
        'edgegap_wait_for_deployment returns the log tail itself when a start fails.'
    );
  }
  if (!d.running && !TERMINAL_OK.some((s) => status.includes(s))) {
    return emptyState(
      'not_ready',
      { request_id: requestId, deployment_status: d.current_status, logs: '' },
      `The container has not started yet, so it has no logs. Call edgegap_wait_for_deployment {request_id: "${requestId}"}, ` +
        'then read the logs if it fails or misbehaves.'
    );
  }
  return undefined;
}

/** The skill name an agent most likely meant: "unity" → "edgegap-unity". */
function closestSkill(input: string, names: string[]): string | undefined {
  const wanted = input.trim().toLowerCase().replace(/^edgegap[-_ ]?/, '').replace(/[_ ]/g, '-');
  if (!wanted) return 'edgegap';
  return (
    names.find((n) => n === `edgegap-${wanted}`) ??
    names.find((n) => n.replace(/^edgegap-?/, '').startsWith(wanted)) ??
    names.find((n) => wanted.includes(n.replace(/^edgegap-/, '')) && n !== 'edgegap')
  );
}

function registryCredentialsUnavailable(imageName?: string, tag?: string): string {
  const image = imageName ?? '<image-name>';
  const buildTag = tag ?? '<unique-build-tag>';
  const ref = `registry.edgegap.com/<project>/${image}:${buildTag}`;
  return (
    'Edgegap does not give container registry credentials to a regular API token: the ' +
    'endpoint only accepts the quick-start token the Unity/Unreal plugins use (it answered ' +
    '403). This is the token type, not a problem with the registry. Do not retry. Ask the ' +
    'developer for the registry login instead:\n\n' +
    `1. In the dashboard (${DASHBOARD_URL}), open the Container Registry page and copy the ` +
    'Project, Username and Token.\n' +
    '2. Log in with the token read from an environment variable, never as an argument:\n' +
    `   printf '%s' "$EDGEGAP_REGISTRY_TOKEN" | docker login registry.edgegap.com -u '<username>' --password-stdin\n` +
    `3. docker build --platform linux/amd64 -t ${ref} .\n` +
    `4. docker push ${ref}\n` +
    `5. Confirm with edgegap_list_registry_tags (image_name "${image}", without the project).\n` +
    '6. Call edgegap_create_app_version with docker_repository "registry.edgegap.com", ' +
    `docker_image "<project>/${image}", docker_tag "${buildTag}", and the same username and ` +
    'token as registry_username/registry_token.\n\n' +
    'Or push to any other registry Edgegap can pull from (Docker Hub, GHCR, ECR, GCR, GitLab) ' +
    'and pass its registry_username/registry_token to edgegap_create_app_version.'
  );
}

/**
 * What edgegap_create_app_version says when Edgegap could not log in to the
 * registry to verify the image. The agent should not be handed the registry
 * login just to get past this, so the dashboard route comes first.
 */
function registryLoginNeeded(repository: string, hadLogin: boolean): string {
  return (
    `Edgegap could not log in to ${repository} to verify the image, so the version was not ` +
    'created. ' +
    (hadLogin
      ? 'The registry_username/registry_token given were rejected: check them.'
      : 'Edgegap pulls images with a registry login set on the version, not your API token — ' +
        'this applies to your own registry.edgegap.com project too.') +
    '\n\nOptions:\n' +
    '1. Create the version again with verify_image false, then have the developer open it in ' +
    `the dashboard (${DASHBOARD_URL}) and add the registry username and token (for ` +
    'registry.edgegap.com, the ones on the Container Registry page). Deployments fail to pull ' +
    'until they do.\n' +
    '2. If the developer chooses to give them to you, pass registry_username and registry_token. ' +
    'They are registry-scoped, not the org API token. Do not write them into files.'
  );
}

/** Trims a relay session down to what a game client integration needs. */
function compactRelay(s: RelaySession) {
  return {
    session_id: s.session_id,
    ready: s.ready ?? false,
    status: s.status,
    error: s.error || undefined,
    session_authorization_token: s.authorization_token,
    relay: s.relay
      ? {
          host: s.relay.host,
          ip: s.relay.ip,
          server_port: s.relay.ports?.server,
          client_port: s.relay.ports?.client,
        }
      : undefined,
    users: (s.session_users ?? []).map((u) => ({
      ip: u.ip_address,
      authorization_token: u.authorization_token,
    })),
    how_to_connect: s.ready
      ? 'Configure the Edgegap relay transport with the relay address, the session authorization ' +
        'token, and each player\'s own authorization token. The host connects on server_port; ' +
        'every other player connects on client_port.'
      : undefined,
    architecture_note:
      'This is a relay, not a game server: the host player\'s game owns the match. If the ' +
      'developer has not explicitly chosen host-client, tell them about the trade-offs. ' +
      ARCHITECTURE_GUIDANCE,
  };
}
