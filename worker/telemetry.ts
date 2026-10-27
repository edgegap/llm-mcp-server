/**
 * PostHog MCP Analytics for the hosted endpoint (mcp.edgegap.dev) only, using
 * PostHog's official MCP SDK (@posthog/mcp) on top of posthog-node.
 *
 * The local server (npx @edgegap/mcp) and the self-hosted Docker image never
 * load this file: they run on customers' machines and send nothing but the API
 * calls themselves. Both packages are devDependencies, bundled into the Worker
 * only.
 *
 * WHAT IS SENT. The SDK's events — $mcp_initialize, $mcp_tools_list,
 * $mcp_tool_call, $mcp_resources_list, $mcp_resource_read — filtered through
 * an ALLOWLIST (beforeSend below): only metadata properties pass. Plus ours:
 * mcp_session_started on initialize, $mcp_prompt_get (the TypeScript SDK does
 * not track prompts), and one mcp_milestone_* event per golden-path step a
 * call reached. docs/analytics.md lists every event and property.
 *
 * Every tool call carries what it did (src/callreport.ts): success, a stable
 * error_code, failed_stage (pre_flight / upstream / post_process), the
 * Edgegap API status, latency, and tool-specific facts (wait outcome and poll
 * count, validation result, skill name...). error_message is the tool's own
 * error text with the token, the call's argument values and anything
 * credential-shaped masked, cut to 300 characters.
 *
 * NEVER SENT. The API token. Tool argument values ($mcp_parameters: player IPs,
 * env vars, app and image names, registry credentials), tool responses
 * ($mcp_response), the SDK's raw error text ($mcp_error_message, $exception),
 * and anything a future SDK version adds: a property is dropped unless it is
 * named below. Deployment request_ids are sent only as a salted hash. GeoIP is
 * off; the country comes from Cloudflare.
 *
 * AGENT FIELDS. The SDK can add `context`, `conversation_id` and `llm_model`
 * parameters to every tool, so agents state their intent and correlate calls.
 * That changes every tool's input schema and records free text written by the
 * agent, so it is OFF unless POSTHOG_AGENT_FIELDS is "1".
 *
 * IDENTITY. distinct_id is org_ + HMAC-SHA256(token, TELEMETRY_SALT): one
 * token's events group together, and the token cannot be recovered. Edgegap
 * tokens are organization-wide and the API has no endpoint naming a token's
 * organization, so this hash is also org_id_hash: one organization with two
 * tokens shows as two. is_internal is true when that hash is listed in
 * TELEMETRY_INTERNAL_IDS. With no token or no salt, sessions are anonymous.
 *
 * Off unless POSTHOG_API_KEY is set. A client can opt out of any request with
 * "X-Edgegap-Telemetry: off" (or "DNT: 1"). Events are flushed through
 * ctx.waitUntil, so analytics never delays or breaks an MCP response.
 */

import { PostHog } from 'posthog-node';
import { instrument } from '@posthog/mcp';
import type { BeforeSendFn, MCPAnalyticsOptions } from '@posthog/mcp';
import type { McpServer as McpServerV1 } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sanitizeErrorMessage, type ToolCallReport } from '../src/callreport.js';

export interface TelemetryEnv {
  /** PostHog project API key (phc_...). Analytics is off when unset. Set as a secret. */
  POSTHOG_API_KEY?: string;
  /** "https://us.i.posthog.com" (default) or "https://eu.i.posthog.com". */
  POSTHOG_HOST?: string;
  /** Secret key for hashing tokens into distinct_ids. Anonymous when unset. */
  TELEMETRY_SALT?: string;
  /** "1" lets the SDK add context, conversation_id and llm_model parameters to every tool. */
  POSTHOG_AGENT_FIELDS?: string;
  /**
   * Comma-separated org_ ids (distinct_ids) of Edgegap's own and test tokens,
   * marked is_internal: true. Compute one with `npm run telemetry:id` (reads
   * the token and salt from stdin; prints nothing else). Not a secret.
   */
  TELEMETRY_INTERNAL_IDS?: string;
}

export interface Analytics {
  /** Instruments one per-request MCP server. Call after its tools are registered. */
  instrument(server: unknown): void;
  /** Records initialize and prompt reads from the JSON-RPC body; the SDK misses both. */
  observeRpc(body: unknown): void;
  /** RegisterOptions.onToolCall: what a tool call did, merged into its $mcp_tool_call event. */
  recordToolCall(report: ToolCallReport): Promise<void>;
  /** Sends queued events after the response, without delaying it. */
  flush(): void;
}

/** How long after the response to flush; see Analytics.flush. */
const FLUSH_DELAY_MS = 250;

/** The transport this Worker serves. The local stdio server sends nothing. */
const TRANSPORT = 'streamable_http';

const MILESTONE_EVENTS = [
  'mcp_milestone_registry_credentials_ok',
  'mcp_milestone_image_pushed',
  'mcp_milestone_app_created',
  'mcp_milestone_app_version_created',
  'mcp_milestone_deployment_ready',
  'mcp_milestone_deployment_stopped',
];

/** Events allowed out. Anything else, including $exception, is dropped. */
const EVENTS = new Set([
  '$mcp_initialize',
  '$mcp_tools_list',
  '$mcp_tool_call',
  '$mcp_resources_list',
  '$mcp_resource_read',
  '$mcp_prompt_get',
  '$identify',
  'mcp_session_started',
  ...MILESTONE_EVENTS,
]);

/** Metadata properties allowed out. Everything not named here is dropped. */
const PROPERTIES = new Set([
  '$session_id', '$process_person_profile', '$groups', '$lib', '$lib_version', '$geoip_disable',
  '$mcp_source', '$mcp_protocol_version', '$mcp_client_name', '$mcp_client_version',
  '$mcp_vendor_client', '$mcp_client_user_agent', '$mcp_server_name', '$mcp_server_version',
  '$mcp_server_build', '$mcp_tool_name', '$mcp_tool_category', '$mcp_duration_ms',
  '$mcp_is_error', '$mcp_error_type', '$mcp_input_keys', '$mcp_input_aliases_used',
  '$mcp_listed_tool_names', '$mcp_resource_name',
  // Ours: request facts (eventProperties).
  'read_only', 'has_token', 'auth_problem', 'country', 'skill', 'dry_run', 'prompt', 'prompt_name',
  'error_cause', 'probe', 'is_probe', 'org_id_hash', 'is_internal', 'transport', 'server_version',
  'client_name', 'client_version', 'client_name_source',
  // Ours: what the call did (src/callreport.ts).
  'tool_name', 'success', 'error_code', 'error_message', 'upstream_status', 'upstream_calls',
  'failed_stage', 'latency_ms', 'request_id_hash',
  'skill_name', 'skill_file', 'resource_uri', 'outcome', 'final_status', 'timeout_ms_configured',
  'poll_count', 'validation_result', 'issue_count', 'error_count', 'warning_count', 'engine',
  'checked_dockerfile', 'matchmaker_template', 'team_count', 'has_latency_rule', 'expansion_count',
  'problem_count', 'version_verified', 'registry_status', 'registry_login_set', 'item_count',
  'result_state', 'stop_result', 'token_state', 'resources_override', 'only_agent_deployments',
  'milestone',
]);

/**
 * Why a call failed, as one fixed label, so errors can be broken down without
 * sending their text. Read from the error message, which is dropped after.
 * Order matters: the first match wins. Kept for dashboards built before
 * error_code; error_code is the finer and preferred field.
 */
const ERROR_CAUSES: Array<[RegExp, string | ((m: RegExpMatchArray) => string)]> = [
  [/No Edgegap API token/, 'token_absent'],
  [/does not contain an Edgegap/, 'token_foreign'],
  [/Edgegap API (\d{3})/, (m) => `api_${m[1]}`],
  [/Input validation error|Invalid arguments for tool/, 'validation'],
  [/Tool \S+ not found/, 'unknown_tool'],
  [/failed with status/, 'deployment_failed'],
  [/timed out after \d+ms/, 'request_timeout'],
  [/Network error calling/, 'network'],
  [/No skill named|is not a file in the/, 'unknown_skill'],
  [/Refused|refused|EDGEGAP_[A-Z_]+/, 'guardrail_refused'],
];

export function errorCause(message: unknown): string {
  if (typeof message !== 'string' || !message) return 'unknown';
  for (const [re, label] of ERROR_CAUSES) {
    const m = message.match(re);
    if (m) return typeof label === 'string' ? label : label(m);
  }
  return 'other';
}

/** error_code for an error the tool layer never saw (SDK-level), from error_cause. */
const CAUSE_CODES: Record<string, string> = {
  token_absent: 'AUTH_ABSENT',
  token_foreign: 'AUTH_FOREIGN',
  validation: 'VALIDATION_FAILED',
  unknown_tool: 'NOT_FOUND',
  unknown_skill: 'SKILL_NOT_FOUND',
  guardrail_refused: 'GUARDRAIL_REFUSED',
  request_timeout: 'TIMEOUT',
  network: 'NETWORK',
  deployment_failed: 'DEPLOYMENT_FAILED',
};

/** MCP scanners and health-check crawlers seen in PostHog. They call tools
 *  without a token or with made-up names; flagged so dashboards can drop them. */
const PROBE_CLIENTS = /^(sentinel-probe|verifymcp-probe|mcp-checkup-prober)$/i;
/** Tool names scanners invent ("__verifymcp_ping", "__mcpcheckup_x"). */
const PROBE_TOOLS = /^__|verifymcp|mcpcheckup/i;

/** Extra properties when POSTHOG_AGENT_FIELDS is on: the agent-written fields. */
const AGENT_PROPERTIES = ['$mcp_intent', '$mcp_intent_source', '$mcp_llm_model', '$mcp_llm_model_source', '$mcp_conversation_id'];

type Event = Parameters<BeforeSendFn>[0];

/**
 * The client named by a User-Agent header: its first product token,
 * "claude-code/2.1.310 (cli)" → claude-code 2.1.310. Undefined when there is
 * none to read.
 */
export function clientFromUserAgent(userAgent: string | null | undefined): { name: string; version?: string } | undefined {
  const m = userAgent?.trim().match(/^([A-Za-z0-9][\w.@-]*)(?:\/([\w.+-]+))?/);
  if (!m) return undefined;
  return { name: m[1].slice(0, 80), ...(m[2] ? { version: m[2].slice(0, 40) } : {}) };
}

/**
 * Keeps only allowlisted properties, then derives the fields every event
 * should have from what the SDK set: tool_name, success, latency_ms,
 * client_name, and for errors the tool layer never saw, error_code.
 *
 * client_name comes from MCP clientInfo when the SDK has it. The Worker is
 * stateless (one server per HTTP request), so the SDK only knows clientInfo on
 * the initialize request; every later request falls back to the client named
 * by its User-Agent, and client_name_source says which one it was.
 */
export function allowlist(
  agentFields: boolean,
  userAgentClient?: { name: string; version?: string }
): (event: Event) => Event | null {
  const allowed = new Set([...PROPERTIES, ...(agentFields ? AGENT_PROPERTIES : [])]);
  return (event) => {
    if (!EVENTS.has(event.event)) return null;
    const raw = event.properties ?? {};
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (allowed.has(k)) properties[k] = v;
    }
    const clientName = typeof raw.$mcp_client_name === 'string' && raw.$mcp_client_name ? raw.$mcp_client_name : undefined;
    if (properties.client_name === undefined) {
      if (clientName) {
        properties.client_name = clientName.slice(0, 80);
        properties.client_name_source = 'client_info';
        if (typeof raw.$mcp_client_version === 'string' && properties.client_version === undefined) {
          properties.client_version = raw.$mcp_client_version.slice(0, 40);
        }
      } else if (userAgentClient) {
        properties.client_name = userAgentClient.name;
        properties.client_name_source = 'user_agent';
        if (userAgentClient.version && properties.client_version === undefined) properties.client_version = userAgentClient.version;
      }
    } else if (properties.client_name_source === undefined) {
      properties.client_name_source = 'client_info';
    }
    if (event.event === '$mcp_tool_call') {
      if (properties.tool_name === undefined && typeof raw.$mcp_tool_name === 'string') properties.tool_name = raw.$mcp_tool_name.slice(0, 80);
      if (properties.latency_ms === undefined && typeof raw.$mcp_duration_ms === 'number') properties.latency_ms = raw.$mcp_duration_ms;
      if (properties.success === undefined) properties.success = raw.$mcp_is_error !== true;
    }
    if (raw.$mcp_is_error === true) {
      properties.error_cause = errorCause(raw.$mcp_error_message);
      if (properties.error_code === undefined) {
        // Rejected by the SDK before any handler ran (an unknown tool, say):
        // no report, so read what we can from the SDK's own error.
        properties.error_code = CAUSE_CODES[properties.error_cause as string] ?? 'INTERNAL';
        properties.failed_stage = 'pre_flight';
        properties.upstream_status = null;
        properties.error_message =
          sanitizeErrorMessage(typeof raw.$mcp_error_message === 'string' ? raw.$mcp_error_message : undefined) ?? null;
      }
    }
    const probeClient = typeof properties.client_name === 'string' && PROBE_CLIENTS.test(properties.client_name);
    if (probeClient) properties.probe = true;
    const unauthenticated = properties.has_token === false;
    const fakeTool = typeof properties.tool_name === 'string' && PROBE_TOOLS.test(properties.tool_name);
    if (unauthenticated && (probeClient || fakeTool || properties.error_code === 'NOT_FOUND')) properties.is_probe = true;
    // Skill files are public content; any other resource is reported as "other".
    if (typeof properties.$mcp_resource_name === 'string' && !properties.$mcp_resource_name.startsWith('edgegap-skill://')) {
      properties.$mcp_resource_name = 'other';
    }
    if (event.event === '$mcp_resource_read' && typeof properties.$mcp_resource_name === 'string') {
      const uri = properties.$mcp_resource_name;
      properties.resource_uri = uri.slice(0, 200);
      const skill = uri.match(/^edgegap-skill:\/\/([a-z0-9-]+)\//);
      if (skill) properties.skill_name = skill[1];
    }
    properties.$geoip_disable = true;
    return { ...event, properties };
  };
}

async function hmac(key: string, value: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/** The org_ id for a token: the distinct_id, and the value TELEMETRY_INTERNAL_IDS lists. */
export async function telemetryId(salt: string, token: string): Promise<string> {
  return `org_${await hmac(salt, token)}`;
}

function optedOut(request: Request): boolean {
  const flag = request.headers.get('X-Edgegap-Telemetry')?.trim().toLowerCase();
  return flag === 'off' || flag === '0' || flag === 'false' || request.headers.get('DNT') === '1';
}

// One posthog-node client per isolate and key: it is only a queue and a
// fetch, and creating it per request would lose nothing but time.
let shared: { key: string; host: string; client: PostHog } | undefined;
function client(key: string, host: string): PostHog {
  if (!shared || shared.key !== key || shared.host !== host) {
    shared = { key, host, client: new PostHog(key, { host, disableGeoip: true, flushAt: 20, flushInterval: 0 }) };
  }
  return shared.client;
}

export function createAnalytics(
  env: TelemetryEnv,
  request: Request,
  ctx: ExecutionContext,
  context: {
    serverVersion: string;
    readOnly: boolean;
    token: string | undefined;
    /** Why there is no usable token, from extractToken. */
    authProblem?: 'absent' | 'foreign';
  }
): Analytics | undefined {
  const key = env.POSTHOG_API_KEY?.trim();
  if (!key || optedOut(request)) return undefined;
  const host = (env.POSTHOG_HOST?.trim() || 'https://us.i.posthog.com').replace(/\/+$/, '');
  const posthog = client(key, host);
  const agentFields = env.POSTHOG_AGENT_FIELDS === '1';
  const filter = allowlist(agentFields, clientFromUserAgent(request.headers.get('User-Agent')));

  const salt = env.TELEMETRY_SALT?.trim();
  const distinctId: Promise<string | undefined> =
    context.token && salt ? telemetryId(salt, context.token) : Promise.resolve(undefined);
  const internalIds = new Set(
    (env.TELEMETRY_INTERNAL_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  );
  const country = (request as Request & { cf?: { country?: string } }).cf?.country;
  const authProblem = context.token ? undefined : context.authProblem;

  /** Properties every event of this request carries. */
  const base = async (): Promise<Record<string, unknown>> => {
    const id = await distinctId;
    return {
      read_only: context.readOnly,
      has_token: Boolean(context.token),
      ...(authProblem ? { auth_problem: authProblem } : {}),
      ...(country ? { country } : {}),
      org_id_hash: id ?? null,
      is_internal: id ? internalIds.has(id) : false,
      transport: TRANSPORT,
      server_version: context.serverVersion,
    };
  };

  // What each tool call did, waiting for its $mcp_tool_call event. The SDK
  // builds that event after the handler returns and copies its properties
  // along the way, so the report is merged in beforeSend, matched by tool name
  // (the stateless Worker sees one call per request in practice).
  const reports = new Map<string, Array<Record<string, unknown>>>();

  const beforeSend: BeforeSendFn = async (event) => {
    let report: Record<string, unknown> | undefined;
    if (event.event === '$mcp_tool_call') {
      const name = event.properties?.$mcp_tool_name;
      report = typeof name === 'string' ? reports.get(name)?.shift() : undefined;
    }
    const filtered = filter(report ? { ...event, properties: { ...event.properties, ...report } } : event);
    if (!filtered) return null;
    const milestones = report?._milestones as string[] | undefined;
    if (milestones?.length) {
      const p = filtered.properties ?? {};
      for (const m of milestones) {
        posthog.capture({
          distinctId: filtered.distinct_id,
          event: `mcp_milestone_${m}`,
          properties: {
            milestone: m,
            tool_name: p.tool_name,
            org_id_hash: p.org_id_hash ?? null,
            is_internal: p.is_internal ?? false,
            client_name: p.client_name,
            client_name_source: p.client_name_source,
            transport: TRANSPORT,
            server_version: context.serverVersion,
            $geoip_disable: true,
            ...(p.org_id_hash ? {} : { $process_person_profile: false }),
          },
        });
      }
    }
    return filtered;
  };

  const options: MCPAnalyticsOptions = {
    serverBuild: context.serverVersion,
    context: agentFields,
    enableConversationId: agentFields,
    captureModel: agentFields,
    enableExceptionAutocapture: false,
    identify: async () => {
      const id = await distinctId;
      return id ? { distinctId: id } : null;
    },
    // Facts we choose to add, read from the request without forwarding it.
    eventProperties: async (req) => {
      const args = (req?.params?.arguments ?? {}) as Record<string, unknown>;
      return {
        ...(await base()),
        ...(req?.params?.name === 'edgegap_get_skill' && typeof args.skill === 'string' ? { skill: args.skill.slice(0, 80) } : {}),
        ...(args.dry_run === true ? { dry_run: true } : {}),
      };
    },
    beforeSend,
  };

  /** Sends one event of ours through the same allowlist. */
  const captureOwn = (event: string, properties: Record<string, unknown>) =>
    ctx.waitUntil(
      Promise.all([distinctId, base()])
        .then(([id, common]) => {
          const out = filter({
            event,
            distinct_id: id ?? `anon_${crypto.randomUUID()}`,
            properties: { ...common, ...properties, ...(id ? {} : { $process_person_profile: false }) },
            timestamp: new Date().toISOString(),
            type: 'capture',
          } as Event) as { distinct_id: string; properties: Record<string, unknown> } | null;
          if (!out) return;
          posthog.capture({ distinctId: out.distinct_id, event, properties: out.properties });
          return posthog.flush();
        })
        .catch(() => {})
    );

  return {
    instrument(server) {
      try {
        instrument(server as McpServerV1, posthog, options);
      } catch {
        // Analytics must never stop the server from serving.
      }
    },
    observeRpc(body) {
      for (const msg of Array.isArray(body) ? body : [body]) {
        const m = msg as { method?: string; params?: { name?: unknown; clientInfo?: { name?: unknown; version?: unknown } } } | null;
        if (m?.method === 'initialize') {
          const name = typeof m.params?.clientInfo?.name === 'string' ? m.params.clientInfo.name.slice(0, 80) : undefined;
          const version = typeof m.params?.clientInfo?.version === 'string' ? m.params.clientInfo.version.slice(0, 40) : undefined;
          captureOwn('mcp_session_started', {
            ...(name ? { client_name: name, $mcp_client_name: name } : {}),
            ...(version ? { client_version: version, $mcp_client_version: version } : {}),
          });
        }
        if (m?.method === 'prompts/get' && typeof m.params?.name === 'string') {
          const prompt = m.params.name.slice(0, 80);
          captureOwn('$mcp_prompt_get', { prompt, prompt_name: prompt });
        }
      }
    },
    async recordToolCall(report) {
      const requestIdHash =
        report.hash.request_id && salt ? `req_${(await hmac(salt, `request_id:${report.hash.request_id}`)).slice(0, 16)}` : undefined;
      const props: Record<string, unknown> = {
        tool_name: report.tool,
        success: report.success,
        error_code: report.error_code ?? null,
        error_message: report.error_message ? sanitizeErrorMessage(report.error_message, context.token) : null,
        upstream_status: report.upstream_status,
        upstream_calls: report.upstream_calls,
        failed_stage: report.failed_stage ?? null,
        latency_ms: report.latency_ms,
        ...(report.dry_run ? { dry_run: true } : {}),
        ...report.props,
        ...(requestIdHash ? { request_id_hash: requestIdHash } : {}),
        _milestones: report.milestones,
      };
      const queue = reports.get(report.tool) ?? [];
      queue.push(props);
      reports.set(report.tool, queue);
    },
    flush() {
      // @posthog/mcp builds each event asynchronously (identify, eventProperties,
      // beforeSend) and only then hands it to posthog-node, without exposing that
      // promise. Flushing as the response returns misses the last call's event,
      // so keep the request alive briefly under waitUntil, then flush. The
      // response is never delayed; the wait is idle time, not CPU.
      ctx.waitUntil(
        new Promise((resolve) => setTimeout(resolve, FLUSH_DELAY_MS))
          .then(() => posthog.flush())
          .catch(() => {})
      );
    },
  };
}
