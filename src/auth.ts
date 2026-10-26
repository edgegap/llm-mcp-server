/**
 * Token acquisition.
 *
 * The developer is asked for their token at first use rather than having to
 * paste it into a client config file before anything works.
 *
 * WHERE THE TOKEN LIVES, EXHAUSTIVELY:
 *
 *   - one variable in this process's memory, for the life of this process
 *
 * That is the complete list. It is never written to disk, never sent to any
 * Edgegap-operated service, never logged, never included in a tool result, and
 * never persisted across restarts. The process runs on the developer's own
 * machine, spawned by their editor, and dies with it. Closing the editor is a
 * complete revocation of this server's access.
 *
 * This is the reason the server is distributed as a local stdio process rather
 * than hosted. A hosted version would put customer credentials in transit
 * through Edgegap infrastructure on every call, which is a different security
 * claim no matter how carefully the hosting is written.
 *
 * IMPORTANT — read before extending this file.
 *
 * The MCP specification says servers should not use elicitation to collect
 * sensitive data, and an API token is sensitive. This implementation exists
 * because the setup friction of a config-file token is the single largest drop
 * in the onboarding funnel, but it is a deliberate trade, not a default to copy.
 * The mitigations below are what make the trade defensible, and removing any of
 * them breaks it:
 *
 *   - the environment variable is always preferred when present
 *   - the token is held in memory only, for one process lifetime
 *   - the elicitation states the token's blast radius in plain language
 *   - the developer must tick an acknowledgement before the token is accepted
 *   - the token is stripped from every error string before it reaches the model
 *
 * The real fix is scoped, revocable, deploy-only credentials issued by Edgegap.
 * Until those exist, this file is a workaround and should be labelled as one.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Config, stripTokenPrefix } from './config.js';

/** Why there is no token: none given, a credential that is not an Edgegap
 *  token, or the developer said no when asked. Read by analytics. */
export type TokenProblem = 'absent' | 'foreign' | 'declined';

export class TokenUnavailableError extends Error {
  constructor(message: string, public readonly reason: TokenProblem = 'absent') {
    super(message);
  }
}

/**
 * What EdgegapClient needs from a credential source. Two implementations:
 * TokenProvider (local, interactive) and StaticTokenProvider (hosted, token
 * supplied per request and discarded with the request).
 */
export interface TokenSource {
  readonly current: string | undefined;
  get(): Promise<string>;
  invalidate(): void;
  consumeFirstUseNotice(): string | undefined;
}

/** Shown to the developer at the moment they are asked to hand over a token. */
export const PRIVILEGE_WARNING =
  'This token grants full access to your entire Edgegap organization: every ' +
  'application, every version, every running deployment, and your billing-' +
  'relevant usage. Edgegap does not currently issue scoped or deploy-only ' +
  'tokens, so it cannot be narrowed.\n\n' +
  'Whatever agent you are running will be able to use it for anything the API ' +
  'allows. Only continue if you are supervising this session. For unattended ' +
  'or autonomous agents, use a token from a separate non-production ' +
  'organization, and set EDGEGAP_READ_ONLY=1 and EDGEGAP_APP_ALLOWLIST to ' +
  'limit what the agent can reach.';

/**
 * Warns if a token was passed as a command-line argument. Process arguments
 * are visible to every other process on the machine via `ps`, and get captured
 * by shell history and crash reporters. Config env vars do not have this
 * problem, and the interactive prompt has it least of all.
 */
export function warnIfTokenInArgv(argv: string[] = process.argv): boolean {
  const looksLikeToken = argv.some((a) => /^--?token[=\s]/i.test(a) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(a));
  if (looksLikeToken) {
    process.stderr.write(
      '[edgegap-mcp] WARNING: a token appears to have been passed on the command ' +
        'line. Command-line arguments are visible to other processes on this machine. ' +
        'Remove it and let the server prompt you, or use the EDGEGAP_API_TOKEN env var.\n'
    );
  }
  return looksLikeToken;
}

export class TokenProvider implements TokenSource {
  private cached?: string;
  private inFlight?: Promise<string>;
  private server?: Server;

  constructor(private readonly config: Config) {
    this.cached = config.envToken;
  }

  /** Wired up after the server is constructed, since elicitation needs it. */
  attach(server: Server): void {
    this.server = server;
  }

  /** The token currently in hand, for redaction purposes. May be undefined. */
  get current(): string | undefined {
    return this.cached;
  }

  /** Drops the cached token so the next call re-prompts. Called on a 401. */
  invalidate(): void {
    if (this.config.envToken) return; // env-supplied tokens are not re-prompted
    this.cached = undefined;
  }

  /**
   * Clears the token from memory. Wired to process exit signals so a token
   * supplied interactively does not outlive the session even briefly in a core
   * dump or a lingering handle.
   */
  scrub(): void {
    this.cached = undefined;
  }

  /** Registers scrub() against the signals an editor uses to stop the server. */
  installExitHandlers(): void {
    const clear = () => this.scrub();
    process.once('exit', clear);
    process.once('SIGINT', () => {
      clear();
      process.exit(0);
    });
    process.once('SIGTERM', () => {
      clear();
      process.exit(0);
    });
  }

  /** True the first time a token is obtained, so callers can attach a notice. */
  private firstAcquisition = true;
  consumeFirstUseNotice(): string | undefined {
    if (!this.firstAcquisition) return undefined;
    this.firstAcquisition = false;
    return (
      'Token held in memory for this session only — nothing was written to ' +
      'disk and nothing was sent to Edgegap beyond the API call itself. It ' +
      'stops being usable when this editor session ends. Reminder: the token ' +
      'is org-wide and cannot be scoped, so revoke it at ' +
      'https://app.edgegap.com/user-settings?tab=tokens if it is ever exposed.'
    );
  }

  async get(): Promise<string> {
    if (this.cached) return this.cached;
    if (this.inFlight) return this.inFlight; // collapse concurrent tool calls

    this.inFlight = this.elicit().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async elicit(): Promise<string> {
    if (!this.server) {
      throw new TokenUnavailableError(
        'No Edgegap API token available and the server is not ready to ask for one.'
      );
    }

    const capabilities = this.server.getClientCapabilities();
    if (!capabilities?.elicitation) {
      throw new TokenUnavailableError(
        'No Edgegap API token available.\n\n' +
          'This MCP client does not support interactive prompts, so the token has ' +
          'to be supplied up front. Add it to your MCP client config:\n\n' +
          '  "env": { "EDGEGAP_API_TOKEN": "your-token" }\n\n' +
          'Generate a token at https://app.edgegap.com/user-settings?tab=tokens ' +
          '(no Edgegap account yet? Sign up free at https://app.edgegap.com).\n\n' +
          'Until then, edgegap_context, edgegap_list_skills, edgegap_get_skill, edgegap_generate_dockerfile ' +
          'and edgegap_validate_server_config work without a token.\n\n' +
          PRIVILEGE_WARNING
      );
    }

    const result = await this.server.elicitInput({
      message:
        'Edgegap needs an API token to continue.\n\n' +
        'Generate one at https://app.edgegap.com/user-settings?tab=tokens\n\n' +
        PRIVILEGE_WARNING,
      requestedSchema: {
        type: 'object',
        properties: {
          api_token: {
            type: 'string',
            title: 'Edgegap API token',
            description:
              'Paste the token value. It is held in one variable in memory for ' +
              'this session, is not saved to disk, is not shown to the model, ' +
              'and never reaches any Edgegap-operated server.',
          },
          acknowledged: {
            type: 'boolean',
            title: 'I understand this token gives the agent full access to my Edgegap organization',
            description:
              'Required. Edgegap cannot currently issue a narrower token, so this ' +
              'is the only scope available.',
            default: false,
          },
        },
        required: ['api_token', 'acknowledged'],
      },
    });

    if (result.action !== 'accept' || !result.content) {
      throw new TokenUnavailableError(
        'The developer declined to provide an Edgegap API token. Do not retry ' +
          'automatically. Stop and tell them which operation needed it, so they ' +
          'can decide whether to continue.',
        'declined'
      );
    }

    const acknowledged = result.content.acknowledged === true;
    if (!acknowledged) {
      throw new TokenUnavailableError(
        'The token privilege acknowledgement was not accepted, so no token was ' +
          'stored. Nothing has been sent to Edgegap. If the org-wide scope is the ' +
          'concern, the safer setup is a token from a separate non-production ' +
          'organization with EDGEGAP_READ_ONLY=1.',
        'declined'
      );
    }

    const raw = String(result.content.api_token ?? '').trim();
    const token = stripTokenPrefix(raw);
    if (!token) {
      throw new TokenUnavailableError('An empty token was submitted. Nothing was stored.', 'declined');
    }

    this.cached = token;
    return token;
  }
}

export class StaticTokenProvider implements TokenSource {
  private used = false;

  /**
   * @param token          credential for this request, if the caller found a usable one
   * @param unavailableMessage  what to tell the agent when it calls a tool and
   *   there is no token. The transport knows WHY the token is missing — absent
   *   header, or a header carrying some other client's credential — and that
   *   distinction is the whole difference between a developer who can fix their
   *   setup and one staring at a generic 401. Defaults to the generic text.
   */
  constructor(
    private token: string | undefined,
    private readonly unavailableMessage?: string,
    private readonly problem: 'absent' | 'foreign' = 'absent'
  ) {}

  get current(): string | undefined {
    return this.token;
  }

  async get(): Promise<string> {
    if (!this.token) {
      throw new TokenUnavailableError(
        this.unavailableMessage ??
          'No Edgegap API token on this request. Send it as an Authorization ' +
            'header on the MCP connection.',
        this.problem
      );
    }
    return this.token;
  }

  invalidate(): void {
    // Nothing to forget between requests — there is no cache. The next request
    // carries its own token, so a rejected one simply fails and the developer
    // fixes their client config.
    this.token = undefined;
  }

  consumeFirstUseNotice(): string | undefined {
    if (this.used) return undefined;
    this.used = true;
    return (
      'This is the hosted relay: your token is read from the request header, ' +
      'used for this call, and discarded. It is not stored. It does, however, ' +
      'pass through Edgegap infrastructure — the local server (npx @edgegap/mcp) ' +
      'avoids that entirely. Your token is org-wide and cannot be scoped.'
    );
  }
}
