/**
 * Thin client over the Edgegap REST API.
 *
 * Deliberately not generated from the OpenAPI spec: the generated surface is
 * ~60 operations, which is more than an agent can hold in context without
 * picking the wrong one. This wraps only what the golden path needs.
 */

import { Config, redact } from './config.js';
import { TokenSource } from './auth.js';
import { VERSION } from './version.js';
import type { UpstreamResult } from './callreport.js';

/** A request a dry run would have sent, with every secret masked. */
export interface FleetHost {
  host_id: string;
  status?: string;
  ip_address?: string | null;
  city?: string | null;
  country?: string | null;
  continent?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  [key: string]: unknown;
}

export interface EndpointStorage {
  name: string;
  endpoint?: string;
  bucket?: string;
  access_key_id?: string;
  container_log_version?: string;
  output_format?: string;
  create_time?: string;
  last_updated?: string;
}

export interface PullProfile {
  name: string;
  source?: string;
  source_type?: string;
  destination?: string;
}

export interface PlannedRequest {
  method: Method;
  host: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface ClientOptions {
  /** The connected MCP client's name, for the User-Agent. Read per request,
   *  since the client only announces it during the handshake. */
  clientName?: () => string | undefined;
  /** Set on a dry-run client: requests are recorded here and never sent. */
  recorder?: (request: PlannedRequest) => void;
}

const SECRET_KEYS = /^(private_token|registry_token|token|password|secret|api_key|secret_access_key)$/i;

/**
 * Deep copy of a request body with secrets masked: registry tokens and the
 * like by key name, every environment variable value (we never echo those),
 * and the API token anywhere it appears.
 */
export function maskSecrets(value: unknown, apiToken?: string): unknown {
  if (typeof value === 'string') {
    return apiToken && value.includes(apiToken) ? value.split(apiToken).join('***') : value;
  }
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, apiToken));
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const isEnvVar = typeof obj.key === 'string' && 'value' in obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = (SECRET_KEYS.test(k) && v != null) || (isEnvVar && k === 'value') ? '***' : maskSecrets(v, apiToken);
  }
  return out;
}

export class EdgegapApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly apiMessage: string,
    public readonly details?: unknown
  ) {
    super(`Edgegap API ${status}: ${apiMessage}`);
    this.name = 'EdgegapApiError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class EdgegapClient {
  /**
   * Every Edgegap API response this client has seen, in order: the HTTP
   * status, or "timeout"/"network". The tool wrapper reads the entries a call
   * added to report what the API said. Statuses only, never bodies.
   */
  readonly upstream: UpstreamResult[] = [];

  constructor(
    private readonly config: Config,
    private readonly auth: TokenSource,
    private readonly options: ClientOptions = {}
  ) {}

  /**
   * A client that records requests instead of sending them, for dry runs.
   * Tools call it exactly as they call the real one, so the request shown is
   * the request that would be sent — not a second copy of the path logic.
   */
  dryRun(): { client: EdgegapClient; requests: PlannedRequest[] } {
    const requests: PlannedRequest[] = [];
    const client = new EdgegapClient(this.config, this.auth, {
      ...this.options,
      recorder: (r) => requests.push(r),
    });
    return { client, requests };
  }

  /** "edgegap-mcp/<version> (<client>)". Nothing else identifying is sent. */
  private userAgent(): string {
    const client = this.options.clientName?.();
    return `edgegap-mcp/${VERSION}${client ? ` (${client.replace(/[^\w .\-/]/g, '')})` : ''}`;
  }

  private async request<T>(
    method: Method,
    version: 'v1' | 'v2',
    path: string,
    options: { body?: unknown; query?: Record<string, string | number | undefined> } = {}
  ): Promise<T> {
    const base = version === 'v2' ? this.config.baseUrlV2 : this.config.baseUrlV1;
    const url = new URL(base + path);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    if (this.options.recorder) {
      // Dry run: record and stop. Never ask for or read the token here — the
      // header is shown masked, and a dry run must not trigger the prompt.
      this.options.recorder({
        method,
        host: url.host,
        path: url.pathname + url.search,
        headers: { Authorization: 'token ***', 'Content-Type': 'application/json', 'User-Agent': this.userAgent() },
        ...(options.body === undefined ? {} : { body: maskSecrets(options.body, this.auth.current) }),
      });
      return {} as T;
    }

    // Resolved per request rather than at construction: the developer may not
    // have been asked for a token yet.
    const token = await this.auth.get();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers: {
          // Edgegap expects the literal word "token" before the value.
          Authorization: `token ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': this.userAgent(),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        this.upstream.push('timeout');
        throw new Error(
          `Request to ${method} ${path} timed out after ${this.config.requestTimeoutMs}ms.`
        );
      }
      this.upstream.push('network');
      throw new Error(
        redact(`Network error calling ${method} ${path}: ${(err as Error).message}`, token)
      );
    } finally {
      clearTimeout(timer);
    }

    this.upstream.push(response.status);
    const raw = await response.text();
    let parsed: unknown = undefined;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { message: raw.slice(0, 500) };
      }
    }

    if (!response.ok) {
      // A rejected token is worth forgetting immediately, so the next call
      // re-prompts instead of failing repeatedly against a revoked credential.
      if (response.status === 401) this.auth.invalidate();

      const body = (parsed ?? {}) as { message?: string; details?: unknown };
      throw new EdgegapApiError(
        response.status,
        redact(body.message ?? response.statusText, token),
        body.details
      );
    }

    return (parsed ?? {}) as T;
  }

  // --- Applications and versions (v1) ------------------------------------

  listApps(query: { page?: number; limit?: number } = {}) {
    return this.request<ListAppsResponse>('GET', 'v1', '/v1/apps', { query });
  }

  createApp(body: { name: string; is_active: boolean; image: string }) {
    return this.request<AppRecord>('POST', 'v1', '/v1/app', { body });
  }

  updateApp(appName: string, body: Record<string, unknown>) {
    return this.request<AppRecord>('PATCH', 'v1', `/v1/app/${encodeURIComponent(appName)}`, { body });
  }

  listAppVersions(appName: string) {
    return this.request<ListVersionsResponse>(
      'GET',
      'v1',
      `/v1/app/${encodeURIComponent(appName)}/versions`
    );
  }

  /** One version. The response is the version itself, not wrapped. */
  getAppVersion(appName: string, versionName: string) {
    return this.request<AppVersionRecord>(
      'GET',
      'v1',
      `/v1/app/${encodeURIComponent(appName)}/version/${encodeURIComponent(versionName)}`
    );
  }

  updateAppVersion(appName: string, versionName: string, body: Record<string, unknown>) {
    return this.request<{ success: boolean; version: AppVersionRecord }>(
      'PATCH',
      'v1',
      `/v1/app/${encodeURIComponent(appName)}/version/${encodeURIComponent(versionName)}`,
      { body }
    );
  }

  createAppVersion(appName: string, body: Record<string, unknown>) {
    return this.request<{ success: boolean; version: AppVersionRecord }>(
      'POST',
      'v1',
      `/v1/app/${encodeURIComponent(appName)}/version`,
      { body }
    );
  }

  /** Deletes one version. The API refuses nothing here, so callers check first. */
  deleteAppVersion(appName: string, versionName: string) {
    return this.request<{ success?: boolean; message?: string }>(
      'DELETE',
      'v1',
      `/v1/app/${encodeURIComponent(appName)}/version/${encodeURIComponent(versionName)}`
    );
  }

  /** Deletes an application and every version under it. */
  deleteApp(appName: string) {
    return this.request<Record<string, unknown>>('DELETE', 'v1', `/v1/app/${encodeURIComponent(appName)}`);
  }

  // --- Deployments --------------------------------------------------------

  /** v2 deploy. Returns only a request_id; the deployment is still starting. */
  deploy(body: Record<string, unknown>) {
    return this.request<{ request_id: string }>('POST', 'v2', '/deployments', { body });
  }

  /** v2 deploy onto a private fleet: the same body plus private_host_ids. */
  deployToFleet(body: Record<string, unknown>) {
    return this.request<{ request_id: string }>('POST', 'v2', '/private-fleets/deployments', { body });
  }

  listFleetHosts(fleetName: string) {
    return this.request<{ data?: FleetHost[] }>('GET', 'v2', `/private-fleets/${encodeURIComponent(fleetName)}/hosts`);
  }

  listDeploymentTags(requestId: string) {
    return this.request<{ tags?: Array<{ name: string }>; total_count?: number }>(
      'GET',
      'v1',
      `/v1/deployments/${encodeURIComponent(requestId)}/tags`,
      { query: { limit: 100 } }
    );
  }

  addDeploymentTag(requestId: string, name: string) {
    return this.request<{ name: string }>('POST', 'v1', `/v1/deployments/${encodeURIComponent(requestId)}/tags`, {
      body: { name },
    });
  }

  removeDeploymentTag(requestId: string, name: string) {
    return this.request<Record<string, unknown>>(
      'DELETE',
      'v1',
      `/v1/deployments/${encodeURIComponent(requestId)}/tags/${encodeURIComponent(name)}`
    );
  }

  reportDeployment(requestId: string, body: { reason: string; metadata?: Record<string, string> }) {
    return this.request<Record<string, unknown>>(
      'POST',
      'v1',
      `/v1/deployments/${encodeURIComponent(requestId)}:report`,
      { body }
    );
  }

  // --- Endpoint storage (S3 log export and pull profiles, v1) -------------

  listEndpointStorage() {
    return this.request<{ endpoints?: EndpointStorage[]; total_count?: number }>('GET', 'v1', '/v1/storage/endpoints', {
      query: { limit: 100 },
    });
  }

  createEndpointStorage(body: Record<string, unknown>) {
    return this.request<EndpointStorage>('POST', 'v1', '/v1/storage/endpoint', { body });
  }

  listPullProfiles(endpointName: string) {
    return this.request<{ pull_profiles?: PullProfile[]; total_count?: number }>(
      'GET',
      'v1',
      `/v1/storage/endpoint/${encodeURIComponent(endpointName)}/pull-profiles`,
      { query: { limit: 100 } }
    );
  }

  createPullProfile(endpointName: string, body: Record<string, unknown>) {
    return this.request<PullProfile>(
      'POST',
      'v1',
      `/v1/storage/endpoint/${encodeURIComponent(endpointName)}/pull-profile`,
      { body }
    );
  }

  deleteEndpointStorage(endpointName: string) {
    return this.request<void>('DELETE', 'v1', `/v1/storage/endpoint/${encodeURIComponent(endpointName)}`);
  }

  deletePullProfile(endpointName: string, profileName: string) {
    return this.request<void>(
      'DELETE',
      'v1',
      `/v1/storage/endpoint/${encodeURIComponent(endpointName)}/pull-profile/${encodeURIComponent(profileName)}`
    );
  }

  /** PUT links, DELETE unlinks; the path is the same. */
  linkPullProfile(method: 'PUT' | 'DELETE', endpointName: string, profileName: string, appName: string, versionName: string) {
    return this.request<Record<string, unknown>>(
      method,
      'v1',
      `/v1/storage/endpoint/${encodeURIComponent(endpointName)}/pull-profile/${encodeURIComponent(profileName)}` +
        `/app/${encodeURIComponent(appName)}/version/${encodeURIComponent(versionName)}`
    );
  }

  getDeployment(requestId: string) {
    return this.request<DeploymentStatus>(
      'GET',
      'v1',
      `/v1/status/${encodeURIComponent(requestId)}`
    );
  }

  listDeployments(query: { query?: string; page?: number; limit?: number } = {}) {
    return this.request<ListDeploymentsResponse>('GET', 'v1', '/v1/deployments', { query });
  }

  stopDeployment(requestId: string) {
    return this.request<{ message: string; deployment_summary?: DeploymentStatus }>(
      'DELETE',
      'v1',
      `/v1/stop/${encodeURIComponent(requestId)}`
    );
  }

  getDeploymentMetrics(
    requestId: string,
    query: { start_time?: string; end_time?: string; steps?: string } = {}
  ) {
    return this.request<DeploymentMetrics>(
      'GET',
      'v1',
      `/v1/metrics/deployment/${encodeURIComponent(requestId)}`,
      { query }
    );
  }

  // --- Locations ----------------------------------------------------------

  /** With app and version, only locations with capacity for it right now. */
  listLocations(query: { app?: string; version?: string; page?: number; limit?: number } = {}) {
    return this.request<LocationsResponse>('GET', 'v1', '/v1/locations', { query });
  }

  listBeacons(query: { page?: number; limit?: number } = {}) {
    return this.request<BeaconsResponse>('GET', 'v1', '/v1/locations/beacons', { query });
  }

  getDeploymentLogs(requestId: string, format: 'text' | 'ndjson' = 'text') {
    return this.request<DeploymentLogs>(
      'GET',
      'v1',
      `/v1/deployment/${encodeURIComponent(requestId)}/container-logs`,
      { query: { format } }
    );
  }

  // --- Container registry -------------------------------------------------

  /**
   * Push credentials for the organization's project on registry.edgegap.com.
   * Not in the published OpenAPI spec: this is the Unity plugin's quick-start
   * endpoint, and it only accepts that flow's quick-start tokens. A regular
   * API token gets 403 "This token is not a quick start token".
   */
  getRegistryCredentials() {
    return this.request<RegistryCredentials>('GET', 'v1', '/v1/wizard/registry-credentials');
  }

  /** Provisions the registry project for a quick-start token. Returns 204.
   *  Also quick-start only: a regular API token gets 403. */
  initQuickStart(source: string) {
    return this.request<unknown>('POST', 'v1', '/v1/wizard/init-quick-start', { body: { source } });
  }

  /**
   * imageName is the image name only, e.g. "my-game-server": the API takes the
   * project from the token, and "<project>/<image>" is a 404. The route is
   * <path:image_name>, so a nested name keeps its slashes unencoded.
   */
  listRegistryTags(imageName: string, query: { page?: number; limit?: number } = {}) {
    const path = imageName.split('/').map(encodeURIComponent).join('/');
    return this.request<RegistryTagsResponse>(
      'GET',
      'v1',
      `/v1/container-registry/images/${path}/tags`,
      { query }
    );
  }

  /** Deletes one tag and, per the spec, the image it points to. Same
   *  image-name rules as listRegistryTags. */
  deleteRegistryTag(imageName: string, tag: string) {
    const path = imageName.split('/').map(encodeURIComponent).join('/');
    return this.request<RegistryTagDeleted>(
      'DELETE',
      'v1',
      `/v1/container-registry/images/${path}/tags/${encodeURIComponent(tag)}`
    );
  }

  // --- Relays -------------------------------------------------------------

  listRelaySessions() {
    return this.request<{ sessions?: RelaySession[]; total_count?: number }>('GET', 'v1', '/v1/relays/sessions');
  }

  revokeRelayUser(body: { session_id: string; authorization_token: number }) {
    return this.request<RelaySession>('POST', 'v1', '/v1/relays/sessions:revoke-user', { body });
  }

  createRelaySession(body: { users: Array<{ ip: string }>; webhook_url?: string }) {
    return this.request<RelaySession>('POST', 'v1', '/v1/relays/sessions', { body });
  }

  getRelaySession(sessionId: string) {
    return this.request<RelaySession>(
      'GET',
      'v1',
      `/v1/relays/sessions/${encodeURIComponent(sessionId)}`
    );
  }

  authorizeRelayUser(body: { session_id: string; user_ip: string }) {
    return this.request<RelaySession & { session_user?: RelaySessionUser }>(
      'POST',
      'v1',
      '/v1/relays/sessions:authorize-user',
      { body }
    );
  }

  deleteRelaySession(sessionId: string) {
    return this.request<unknown>(
      'DELETE',
      'v1',
      `/v1/relays/sessions/${encodeURIComponent(sessionId)}`
    );
  }
}

// --- Response shapes (only the fields the tools actually surface) ----------

export interface AppRecord {
  name: string;
  is_active: boolean;
  create_time?: string;
  last_updated?: string;
}

export interface ListAppsResponse {
  applications?: AppRecord[];
  total_count?: number;
}

export interface AppVersionRecord {
  name: string;
  is_active?: boolean;
  req_cpu?: number;
  req_memory?: number;
  docker_repository?: string;
  docker_image?: string;
  docker_tag?: string;
  max_duration?: number;
  caching_percent?: number;
  force_cache?: boolean;
  verify_image?: boolean;
  time_to_deploy?: number;
  restart_policy?: string;
  termination_grace_period_seconds?: number;
  endpoint_storage?: string | null;
  /** Values are not surfaced; names only. */
  envs?: Array<{ key: string; value?: string; is_hidden?: boolean }>;
  ports?: Array<{ port: number; protocol: string; name?: string; tls_upgrade?: boolean }>;
  /** Registry login for pulling the image. The API returns the token in
   *  plain text here: read it for presence only, never pass it on. */
  private_username?: string | null;
  private_token?: string | null;
}

export interface ListVersionsResponse {
  versions?: AppVersionRecord[];
  total_count?: number;
}

export interface DeploymentPort {
  name: string;
  link: string;
  internal: number;
  external: number;
  protocol: string;
}

export interface DeploymentStatus {
  request_id: string;
  fqdn: string;
  public_ip: string;
  app_name: string;
  app_version: string;
  current_status: string;
  running: boolean;
  error: boolean;
  error_detail?: string;
  elapsed_time?: number;
  max_duration?: number;
  ports?: Record<string, DeploymentPort>;
  location?: { city?: string; country?: string; continent?: string };
  tags?: string[];
}

export interface ListDeploymentsResponse {
  data?: Array<{
    request_id: string;
    fqdn: string;
    public_ip: string;
    ready: boolean;
    start_time: string;
    ports?: Record<string, DeploymentPort>;
    tags?: string[];
  }>;
  total_count?: number;
}

export interface RegistryCredentials {
  registry_url?: string;
  project?: string;
  username?: string;
  token?: string;
}

export interface RegistryTagsResponse {
  data?: Array<{
    tag: string;
    last_push_at: string;
    artifact?: { image_hash?: string; size_mb?: number; deleted?: boolean };
  }>;
  count?: number;
  pagination?: { number?: number; has_next?: boolean; next_page_number?: number | null };
}

export interface RelayPort {
  port?: number;
  protocol?: string;
  link?: string;
}

export interface RelaySessionUser {
  ip_address?: string;
  latitude?: number;
  longitude?: number;
  authorization_token?: number;
}

export interface RelaySession {
  session_id: string;
  authorization_token?: number;
  status?: string;
  ready?: boolean;
  linked?: boolean;
  error?: string | null;
  session_users?: RelaySessionUser[];
  relay?: {
    ip?: string;
    host?: string;
    ports?: { server?: RelayPort; client?: RelayPort };
  } | null;
  webhook_url?: string | null;
}

/** One series: parallel arrays of labels, values and timestamps. */
export interface MetricSeries {
  labels?: string[];
  datasets?: number[];
  timestamps?: string[];
}

export interface DeploymentMetrics {
  cpu?: MetricSeries;
  cpu_throttle_rate?: MetricSeries;
  cpu_throttle_total?: MetricSeries;
  mem?: MetricSeries;
  network?: { receive?: MetricSeries; transmit?: MetricSeries };
  total?: {
    receive_total?: MetricSeries;
    transmit_total?: MetricSeries;
    disk_read_total?: MetricSeries;
    disk_write_total?: MetricSeries;
  };
}

export interface LocationRecord {
  city?: string;
  country?: string;
  continent?: string;
  administrative_division?: string;
  timezone?: string;
  latitude?: number;
  longitude?: number;
}

export interface LocationsResponse {
  locations?: LocationRecord[];
  messages?: string[];
  total_count?: number;
  pagination?: { number?: number; has_next?: boolean };
}

export interface BeaconsResponse {
  locations?: Array<{ host?: string; fqdn?: string; udp_port?: number; tcp_port?: number; location?: LocationRecord }>;
  count?: number;
}

export interface RegistryTagDeleted {
  deleted_tag?: string;
  artifact?: { artifact_deleted?: boolean; size_mb?: number; remaining_tags?: string[]; image_hash?: string };
}

export interface DeploymentLogs {
  logs?: string;
  crash_logs?: string | null;
  crash_data?: { exit_code?: number; message?: string; restart_count?: number } | null;
  logs_link?: string | null;
}
