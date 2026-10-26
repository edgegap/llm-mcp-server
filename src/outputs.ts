/**
 * Output schemas for the tools whose results have a stable shape. Clients that
 * read structuredContent can rely on these fields; the JSON text in content is
 * the same payload.
 *
 * Deliberately loose: every field is optional, and objects keep
 * fields not listed here. The SDK rejects a successful result that does not
 * match its tool's schema, so a schema stricter than the Edgegap API's own
 * answers would turn a working call into an error. They document the fields
 * agents use, rather than police them. ok() drops null fields, so no schema
 * needs nullable (each one doubles the JSON Schema). Dry runs of write tools return their
 * own fields (dry_run, sent, requests), which pass for the same reason.
 */
import { z } from 'zod';

const str = z.string().optional();
const num = z.number().optional();
const bool = z.boolean().optional();
const strs = z.array(z.string()).optional();
const obj = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape).optional();
const list = <T extends z.ZodRawShape>(shape: T) => z.array(z.looseObject(shape)).optional();

/** total, and when a page is short: showing, truncated, next_step. */
const page = { total: num, showing: num, truncated: bool, next_step: str };

const port = { name: str, port: num, protocol: str, tls_upgrade: bool };

const version = {
  name: str,
  active: bool,
  image: str,
  registry_credentials_set: bool,
  cpu_units: num,
  memory_mb: num,
  max_duration_minutes: num,
  ports: list(port),
};

const deployment = {
  request_id: str,
  status: str,
  running: bool,
  ready: bool,
  error: bool,
  error_detail: str,
  fqdn: str,
  public_ip: str,
  application: str,
  version: str,
  location: str,
  elapsed_seconds: num,
  ports: list({ name: str, connect: str, external: num, internal: num, protocol: str }),
  next_step: str,
};

const series = obj({ latest: num, average: num, peak: num, samples: num, labels: strs, from: str, to: str });

/** Loose at the top level too: a raw shape becomes additionalProperties: false
 *  in JSON Schema, and clients that validate results reject extra fields. */
const out = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);

const shapes = {
  context: {
    server: str,
    transport: str,
    api_host: str,
    api_base_url: str,
    read_only: bool,
    max_duration_ceiling_minutes: num,
    skills_pack: str,
    forced_deploy_tag: str,
    guardrails: obj({}),
  },
  listApps: { ...page, applications: list({ name: str, active: bool, last_updated: str }) },
  listAppVersions: { application: str, ...page, versions: list(version) },
  getAppVersion: {
    application: str,
    ...version,
    force_cache: bool,
    caching_percent: num,
    verify_image: bool,
    restart_policy: str,
    termination_grace_period_seconds: num,
    env: list({ key: str, hidden: bool }),
    auto_stop_after_minutes: num,
    auto_stop: str,
    warning: str,
  },
  listLocations: {
    filtered_for: str,
    ...page,
    locations: list({ city: str, region: str, country: str, continent: str, latitude: num, longitude: num }),
    messages: strs,
  },
  listPingBeacons: { total: num, beacons: list({ host: str, udp_port: num, tcp_port: num, city: str, country: str, continent: str }) },
  deploy: {
    request_id: str,
    status: str,
    tags: strs,
    auto_stop_after_minutes: num,
    auto_stop: str,
    warning: str,
    resources: obj({ cpu_units: num, memory_mib: num }),
    next_step: str,
  },
  deployment,
  waitForDeployment: { ...deployment, waited_seconds: num },
  listDeployments: { ...page, deployments: list({ request_id: str, ready: bool, fqdn: str, started: str, tags: strs }) },
  metrics: {
    request_id: str,
    cpu: series,
    cpu_throttle_rate: series,
    memory: series,
    network_receive: series,
    network_transmit: series,
    totals: obj({ received: num, transmitted: num, disk_read: num, disk_written: num }),
    note: str,
  },
  listRegistryTags: {
    image_name: str,
    note: str,
    ...page,
    tags: list({ tag: str, pushed: str, size_mb: num, digest: str }),
  },
  listRelaySessions: {
    ...page,
    sessions: list({ session_id: str, status: str, ready: bool, linked: bool, players: num, relay: str, error: str }),
  },
  validateServerConfig: {
    verdict: str,
    engine: str,
    errors: list({ severity: str, code: str, message: str, fix: str, line: num }),
    warnings: list({ severity: str, code: str, message: str, fix: str, line: num }),
  },
} as const;

export const OUTPUT = Object.fromEntries(
  Object.entries(shapes).map(([k, v]) => [k, out(v as z.ZodRawShape)])
) as { [K in keyof typeof shapes]: z.ZodObject<(typeof shapes)[K], z.core.$loose> };
