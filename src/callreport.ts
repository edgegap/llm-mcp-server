/**
 * What one tool call did, for analytics: success, a stable error code, the
 * stage it failed at, the Edgegap API status, and a few tool-specific facts.
 *
 * Built by the tool wrapper in tools.ts and handed to RegisterOptions.onToolCall.
 * Only the hosted Worker passes that hook (worker/telemetry.ts); the local
 * server and the Docker image send nothing. Nothing here does I/O, so the
 * same rules run in Node and in the Worker and are unit-tested directly.
 *
 * Values in `props` must already be safe to send: names, counts, enums.
 * Values in `hash` are raw identifiers (a deployment request_id) that the
 * telemetry side hashes before sending; they never leave the Worker as-is.
 */

export type FailedStage = 'pre_flight' | 'upstream' | 'post_process';

/** Stable internal error codes. Add, never rename: dashboards filter on them. */
export type ErrorCode =
  | 'AUTH_ABSENT'
  | 'AUTH_FOREIGN'
  | 'AUTH_REJECTED'
  | 'AUTH_DECLINED'
  | 'FORBIDDEN'
  | 'NO_RELAY_ACCESS'
  | 'NO_REGISTRY'
  | 'APP_NOT_FOUND'
  | 'DEPLOYMENT_NOT_FOUND'
  | 'LOGS_NOT_FOUND'
  | 'IMAGE_NOT_FOUND'
  | 'RELAY_NOT_FOUND'
  | 'NOT_FOUND'
  | 'SKILL_NOT_FOUND'
  | 'CONFLICT'
  | 'NO_CAPACITY'
  | 'IMAGE_PULL_FAILED'
  | 'RATE_LIMITED'
  | 'QUOTA_REACHED'
  | 'DEPLOYMENT_FAILED'
  | 'VALIDATION_FAILED'
  | 'GUARDRAIL_REFUSED'
  | 'UPSTREAM_REJECTED'
  | 'UPSTREAM_ERROR'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'INTERNAL';

/** What a tool may attach to its result for the report. Stripped before the
 *  result reaches the client. */
export interface CallMeta {
  code?: ErrorCode;
  /** Overrides the stage the wrapper would infer. */
  stage?: FailedStage;
  props?: Record<string, string | number | boolean | undefined>;
  hash?: Record<string, string | undefined>;
  /** Funnel milestones this call reached, e.g. "deployment_ready". */
  milestones?: Milestone[];
}

export type Milestone =
  | 'registry_credentials_ok'
  | 'image_pushed'
  | 'app_created'
  | 'app_version_created'
  | 'deployment_ready'
  | 'deployment_stopped';

/** One Edgegap API response seen during a call: an HTTP status, or the
 *  failure that kept one from arriving. */
export type UpstreamResult = number | 'timeout' | 'network';

export interface ToolCallReport {
  tool: string;
  /** JSON-RPC id of the tools/call request, to match the SDK's event. */
  requestId?: string | number;
  success: boolean;
  error_code?: ErrorCode;
  error_message?: string;
  /** Status of the last Edgegap API response, null if the API was never called. */
  upstream_status: number | null;
  upstream_calls: number;
  failed_stage?: FailedStage;
  latency_ms: number;
  dry_run?: boolean;
  props: Record<string, string | number | boolean>;
  hash: Record<string, string>;
  milestones: Milestone[];
}

const MAX_MESSAGE = 300;

/**
 * Error text made safe to send: the API token and anything shaped like a
 * credential or an identifier is masked, then it is cut to 300 characters.
 * The tool layer already strips the session's own token; this is the second
 * net, for registry tokens, other UUIDs, JWTs, IPs and long opaque strings.
 */
export function sanitizeErrorMessage(text: string | undefined, token?: string, args?: Record<string, unknown>): string | undefined {
  if (!text) return undefined;
  let out = text;
  if (token && token.length >= 8) {
    for (const needle of [token, token.replace(/-/g, '')]) {
      if (needle.length >= 8) out = out.split(needle).join('***');
    }
  }
  // The call's own argument values (application and image names, IPs, env
  // values) are the developer's data: replaced by the argument's name.
  for (const [name, value] of argumentStrings(args)) {
    out = out.split(value).join(`<${name}>`);
  }
  out = out
    // "[api.edgegap.com]" host label and "NOTE: ..." first-use notices add nothing.
    .replace(/^\[[^\]\n]+\]\n?/, '')
    .replace(/\n*NOTE: [\s\S]*$/, '')
    .replace(/\b(eyJ[\w-]+\.[\w-]+\.[\w-]+)/g, '***')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '***')
    .replace(/((?:token|password|secret|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1***')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
    .replace(/\b[A-Za-z0-9+/_$-]{32,}={0,2}/g, '***')
    .trim();
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE - 1)}…` : out;
}

/** Every string value in a call's arguments, longest first, with its top-level name. */
function argumentStrings(args: Record<string, unknown> | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (name: string, v: unknown) => {
    if (typeof v === 'string') {
      if (v.trim().length >= 3) out.push([name, v]);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(name, x);
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v)) walk(name, x);
    }
  };
  for (const [k, v] of Object.entries(args ?? {})) walk(k, v);
  return out.sort((a, b) => b[1].length - a[1].length);
}

/** The error code for an Edgegap API status, given what the tool was looking for. */
export function codeForStatus(status: number, notFound?: ErrorCode, forbidden?: ErrorCode, message = ''): ErrorCode {
  if (/quota|limit reached|exceed|upgrade your plan|plan limit/i.test(message) && [400, 402, 403, 429].includes(status)) {
    return 'QUOTA_REACHED';
  }
  switch (status) {
    case 400:
      return notFound === 'DEPLOYMENT_NOT_FOUND' || notFound === 'LOGS_NOT_FOUND' ? notFound : 'UPSTREAM_REJECTED';
    case 401:
      return 'AUTH_REJECTED';
    case 403:
      return forbidden ?? 'FORBIDDEN';
    case 404:
      return notFound ?? 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'NO_CAPACITY';
    case 424:
      return 'IMAGE_PULL_FAILED';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'UPSTREAM_ERROR' : 'UPSTREAM_REJECTED';
  }
}

/** The code for a tool's own refusal, read from its wording. */
export function codeForToolFailure(text: string): ErrorCode {
  if (/^Refused|refused/.test(text)) return 'GUARDRAIL_REFUSED';
  if (/No skill named|is not a file in the/.test(text)) return 'SKILL_NOT_FOUND';
  if (/^Invalid arguments|Input validation error/.test(text)) return 'VALIDATION_FAILED';
  return 'VALIDATION_FAILED';
}

/**
 * Fills in what the tool did not say itself: the code from the API status or
 * the wording, and the stage from whether, and how, the API was called.
 */
export function finishReport(input: {
  tool: string;
  requestId?: string | number;
  isError: boolean;
  text: string;
  token?: string;
  /** The call's arguments, only to mask their values in error_message. */
  args?: Record<string, unknown>;
  meta?: CallMeta;
  upstream: UpstreamResult[];
  latencyMs: number;
  dryRun?: boolean;
}): ToolCallReport {
  const { meta = {}, upstream } = input;
  const statuses = upstream.filter((u): u is number => typeof u === 'number');
  const last = upstream[upstream.length - 1];
  const failedUpstream = upstream.find((u) => typeof u !== 'number' || u >= 400);
  let code = meta.code;
  let stage = meta.stage;
  if (input.isError) {
    if (!code) {
      if (last === 'timeout') code = 'TIMEOUT';
      else if (last === 'network') code = 'NETWORK';
      else if (typeof failedUpstream === 'number') code = codeForStatus(failedUpstream, undefined, undefined, input.text);
      else code = codeForToolFailure(input.text);
    }
    if (!stage) {
      if (code.startsWith('AUTH_') && code !== 'AUTH_REJECTED') stage = 'pre_flight';
      else if (failedUpstream !== undefined) stage = 'upstream';
      else stage = upstream.length ? 'post_process' : 'pre_flight';
    }
  }
  const props: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(meta.props ?? {})) if (v !== undefined) props[k] = v;
  const hash: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta.hash ?? {})) if (v) hash[k] = v;
  return {
    tool: input.tool,
    requestId: input.requestId,
    success: !input.isError,
    ...(input.isError ? { error_code: code, error_message: sanitizeErrorMessage(input.text, input.token, input.args), failed_stage: stage } : {}),
    upstream_status: statuses.length ? statuses[statuses.length - 1] : null,
    upstream_calls: upstream.length,
    latency_ms: input.latencyMs,
    ...(input.dryRun ? { dry_run: true } : {}),
    props,
    hash,
    milestones: input.isError ? [] : [...new Set(meta.milestones ?? [])],
  };
}
