/**
 * Builds and checks a basic Edgegap matchmaker configuration.
 *
 * Edgegap has no public API for creating a matchmaker: it is created in the
 * dashboard by uploading a JSON configuration. What an agent can usefully do is
 * produce that JSON correctly the first time, pointed at an application version
 * that actually exists, so the developer's only step is the upload.
 *
 * Format reference: https://docs.edgegap.com/learn/matchmaking/matchmaker-in-depth
 */

/** Config schema version the docs currently publish. Overridable per call. */
export const MATCHMAKER_CONFIG_VERSION = '3.3.2';

export const DASHBOARD_URL = 'https://app.edgegap.com';

export interface MatchmakerInput {
  profile_name: string;
  application: string;
  version: string;
  team_count: number;
  min_team_size: number;
  max_team_size: number;
  max_latency_ms?: number;
  latency_difference_ms?: number;
  ticket_expiration?: string;
  ticket_removal?: string;
  inspect?: boolean;
  expansions?: Array<{ after_seconds: number; min_team_size?: number; max_latency_ms?: number }>;
  config_version?: string;
  allowed_cors_origins?: string[];
}

const DURATION = /^\d+(ms|s|m|h)$/;

function seconds(d: string): number {
  const m = d.match(/^(\d+)(ms|s|m|h)$/);
  if (!m) return NaN;
  const n = Number(m[1]);
  return m[2] === 'ms' ? n / 1000 : m[2] === 's' ? n : m[2] === 'm' ? n * 60 : n * 3600;
}

export function buildMatchmakerConfig(input: MatchmakerInput) {
  const problems: string[] = [];
  const cautions: string[] = [];

  if (input.min_team_size > input.max_team_size) {
    problems.push(`min_team_size (${input.min_team_size}) is greater than max_team_size (${input.max_team_size}).`);
  }
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(input.profile_name)) {
    problems.push(`profile_name "${input.profile_name}" should be letters, digits, "-" or "_". Game clients send it on every ticket.`);
  }

  // 30s by default: a lone or partial ticket may only be matched when it nears
  // expiry, so with minutes a developer testing alone gives up before a server comes.
  const expiration = input.ticket_expiration ?? '30s';
  const removal = input.ticket_removal ?? '1m';
  for (const [field, value] of [['ticket_expiration', expiration], ['ticket_removal', removal]] as const) {
    if (!DURATION.test(value)) problems.push(`${field} "${value}" is not a duration like "30s", "5m" or "1h".`);
  }
  if (seconds(expiration) < 20) {
    cautions.push(`ticket_expiration ${expiration} is short. Tickets must outlive the queue wait plus server start-up, or players are dropped before the match is ready.`);
  }

  const rules: Record<string, unknown> = {
    match_size: {
      type: 'player_count',
      attributes: {
        team_count: input.team_count,
        min_team_size: input.min_team_size,
        max_team_size: input.max_team_size,
      },
    },
  };
  const useLatency = input.max_latency_ms !== undefined || input.latency_difference_ms !== undefined;
  if (useLatency) {
    rules.beacons = {
      type: 'latencies',
      attributes: {
        difference: input.latency_difference_ms ?? 100,
        max_latency: input.max_latency_ms ?? 200,
      },
    };
  }

  const expansions: Record<string, Record<string, Record<string, number>>> = {};
  let lastAfter = 0;
  for (const e of [...(input.expansions ?? [])].sort((a, b) => a.after_seconds - b.after_seconds)) {
    const step: Record<string, Record<string, number>> = {};
    // A stage that only repeats the initial min_team_size changes nothing: partial
    // matches already come from min < max and form by ticket expiry, and every
    // expansion costs the matchmaker performance. Drop it rather than emit it.
    if (e.min_team_size === input.min_team_size && e.max_latency_ms === undefined) {
      cautions.push(`expansion at ${e.after_seconds}s only repeats min_team_size ${e.min_team_size}, so it was left out. Partial matches need no expansion: min_team_size below max_team_size allows them, and a short ticket_expiration (30s) keeps the wait short.`);
      continue;
    }
    if (e.min_team_size !== undefined) {
      if (e.min_team_size > input.max_team_size) {
        problems.push(`expansion at ${e.after_seconds}s sets min_team_size ${e.min_team_size} above max_team_size ${input.max_team_size}.`);
      }
      step.match_size = { min_team_size: e.min_team_size };
    }
    if (e.max_latency_ms !== undefined) {
      if (!useLatency) {
        problems.push(`expansion at ${e.after_seconds}s relaxes max_latency_ms, but no latency rule is configured. Set max_latency_ms on the profile too.`);
      }
      step.beacons = { max_latency: e.max_latency_ms };
    }
    if (Object.keys(step).length === 0) continue;
    if (e.after_seconds >= seconds(expiration)) {
      cautions.push(`expansion at ${e.after_seconds}s never applies: tickets expire after ${expiration}. Use an after_seconds below it (e.g. 15 or 20).`);
    }
    if (e.after_seconds === lastAfter) problems.push(`two expansions share after_seconds ${e.after_seconds}.`);
    lastAfter = e.after_seconds;
    expansions[String(e.after_seconds)] = step;
  }
  if (input.team_count * input.min_team_size === 1) {
    cautions.push('A match of one player starts a server per ticket. Fine for testing, costly in production.');
  }

  // Browser (WebGL) clients call the matchmaker directly, so their page's
  // origin must be allowed. An origin is scheme + host (+ port), nothing more:
  // a path or trailing slash never matches a browser's Origin header.
  const origins = input.allowed_cors_origins ?? [];
  for (const o of origins) {
    if (!/^https?:\/\/[^/\s?#]+$/.test(o)) {
      problems.push(`allowed_cors_origins entry "${o}" is not an origin. Use scheme and host only, e.g. "https://mygame.example.com" or "http://localhost:8080", with no path or trailing slash.`);
    }
  }

  const config = {
    version: input.config_version ?? MATCHMAKER_CONFIG_VERSION,
    inspect: input.inspect ?? true,
    max_deployment_retry_count: 3,
    ...(origins.length ? { allowed_cors_origins: origins } : {}),
    profiles: {
      [input.profile_name]: {
        ticket_expiration_period: expiration,
        ticket_removal_period: removal,
        group_inactivity_removal_period: '5m',
        application: { name: input.application, version: input.version },
        // The key is optional; an empty object only reads as a slot to fill in.
        rules: { initial: rules, ...(Object.keys(expansions).length ? { expansions } : {}) },
      },
    },
  };

  return { config, problems, cautions };
}
