# Cloudflare: the trade you are making

**Status: implemented, tested, deployable.** See INSTALL.md for steps. This
document is why you should prefer the local server where you can, not an
argument that the hosted one does not work — it does.

Short version: **no, not for the tools that need a token.** The reason to host
an MCP server is to remove developer setup. Header-based auth does not remove
it — the developer still pastes a token into a config file — so you pay the
cost of routing customer credentials through Edgegap infrastructure and get no
simplicity back.

## What hosting was supposed to buy

A URL instead of an install. No Node, no npm, no JSON config edit.

## Why it does not, here

Without OAuth, a hosted server has to get the token from somewhere. Two options:

1. **Store it server-side.** Edgegap becomes custodian of every customer's
   org-wide Edgegap credential, in one internet-reachable place. Those tokens
   cannot be scoped, so a breach is a breach of every connected customer's
   entire account. Not acceptable.

2. **Take it per request from an `Authorization` header.** Nothing is stored,
   but the token now transits Edgegap infrastructure on every call, and the
   developer is back to pasting a secret into a config file. The setup friction
   you were removing is still there, and you have added credential transit for
   nothing.

Note that "we do not store it" and "we never see it" are different claims. Only
the local process makes the second one.

The hosted Worker also sends usage analytics to PostHog through PostHog's MCP
SDK (`@posthog/mcp`, wired in `worker/telemetry.ts`). Its defaults record tool
argument values and responses; ours drop every property not on an allowlist of
metadata, so never the token, argument values, responses or error text. The token is used
once more there, as the input to a keyed hash (`TELEMETRY_SALT`) that groups an
organization's events; the hash cannot be reversed to the token and is the
only thing that leaves. The local server and the Docker image have no
analytics at all.

## Where each one fits

| | Local (`npx -y @edgegap/mcp`) | Hosted Worker |
| --- | --- | --- |
| Token location | Developer's machine only | Transits Edgegap infra per request |
| Token storage | Memory, session lifetime | None — discarded with the request |
| Setup | One config line, or prompted with no config at all | Paste token into client config |
| Web / mobile MCP clients | No | Yes |
| Shared demo URL | No | Yes |

Default to local. Reach for hosted when you need the last two rows.

## What the local server does instead

`npx -y @edgegap/mcp` in the client config. No clone, no build, no manual
install step. If the client supports interactive prompts, the developer is
asked for the token at first use and never touches a config file at all —
which is simpler than the hosted version, not harder.

The token lives in one variable in a process on the developer's own machine,
spawned by their editor, for the life of that editor session. Nothing on disk,
nothing on Edgegap servers, nothing in logs.

## Why there is no 401 on the transport

The Worker used to reject any request to `/mcp` without an `Authorization`
header. That was wrong in three ways and has been removed.

A transport 401 means "go authenticate over there". It is only actionable when
the challenge carries RFC 9728 `resource_metadata` pointing at an authorization
server. There is none yet, so clients read the challenge, found nothing to
discover, and displayed **"sign-in: not required"** — accurate, and confusing
next to a connector that failed on every call.

It also gated discovery. `initialize` and `tools/list` touch no credential and
expose nothing secret — the tool definitions are in this repo, publicly — yet
neither worked anonymously, so no client could see what the server does before
committing a token.

Worst, the check only tested whether the header was *present*. Clients that
connect by URL alone and have no custom-header field send their own bearer
token. That satisfied the check, got relayed to `api.edgegap.com`, and came
back as Edgegap's generic 401 — a dead end for the developer, and an
org-wide credential relayed on spec.

Now: every request reaches the handler, discovery is anonymous, a foreign-
looking bearer is recognised and never relayed, and a tool called without a
usable token fails through `TokenUnavailableError` as readable text in the
agent's transcript. The "sign-in: not required" badge stays, and is now true.

## When to revisit

Edgegap now runs its own OAuth authorization server, and the Worker has an
OAuth mode (`OAUTH_MODE`, src/oauth.ts) in which it is a resource server only:
the developer authorises in a browser, the client holds a scoped, revocable
grant, and the Worker verifies each short-lived access token and forwards it
to the API, which checks it again. No master key exists, and nothing
is stored here. `@cloudflare/workers-oauth-provider` is not used: it makes the
Worker the authorization server, which Edgegap already runs.

It runs on the `staging` and `beta` environments first. Once
`mcp.edgegap.dev` switches to it, the `Authorization`-header token path in
`worker.ts` can be deleted outright and the hosted server becomes strictly
better than the local one.

## OAuth mode: one token, two audiences

In OAuth mode the Worker forwards the client's access token to the Edgegap
API. That is a co-audience design, not token passthrough.

**What the token is.** Edgegap's authorization server issues one access token
(an RFC 9068 JWT) whose `aud` names two resources, both operated by Edgegap:
the Worker's MCP URL, which the client asked for with `resource` (RFC 8707),
and the Edgegap API. One issuer, two named audiences.

**What each audience checks.**

- The Worker accepts a token only when `aud` contains its own MCP URL, after
  checking the signature against the issuer's JWKS, `typ`, `iss`, `exp` and
  `nbf`. It sends the token to one place, the Edgegap API it is configured
  with (`EDGEGAP_API_URL`, the API the issuer names in `aud`), as
  `Authorization: Bearer`, and nowhere else. It never stores or logs it.
- The Edgegap API verifies the token itself on every call: its own audience,
  that the token and its connection are still live, the user's current role
  in the organization, and the permission the route requires. It trusts
  nothing the Worker says about the caller.

**Why this is not token passthrough.** MCP forbids a server from passing
through a token it received, because the downstream service would then act
on a token that was never issued for it, on the relaying server's say-so, and
could no longer tell who the request is for. None of that applies here:

- The API is a named audience of the token, not a downstream that trusts the
  Worker. RFC 9700 (section 2.3) allows a token for a small set of resource
  servers when each checks that it is named, and both do.
- The Worker adds no privilege. It holds no credential of its own, and every
  call it makes carries exactly the user's token, which the API authorizes
  on its own terms.
- Accountability is kept: the API resolves the token to the user, the
  organization and the client application that holds the connection, so its
  records name who acted and through which app.
- Exchanging the token (RFC 8693) for an API-only one would give the API the
  same subject, client and scopes one round trip later, and nothing the API
  does not already check.

**What keeps it that way.** The reasoning holds while these do:

- each environment's `EDGEGAP_API_URL` is the API its issuer names in `aud`,
  and the Worker sends the token nowhere else;
- the API checks its audience and the token's live state on every call, and
  never treats Worker traffic as trusted;
- the Worker has no credential of its own;
- the API's permission check is the authorization boundary. The Worker's own
  limits (read-only mode, the application allowlist, deployment caps, hidden
  tools) shape what an agent attempts, on top of it.

## Verified facts, so nobody re-derives them

- `agents@0.23.0` exports `createMcpHandler` from `agents/mcp/server`
- pairs with `@modelcontextprotocol/server@2.0.0` (SDK v2, not v1)
- `McpAgent` is deprecated and feature-frozen — ignore tutorials using it
- `server.elicitInput()` throws on the stateless handler: the 2026-07-28
  protocol revision removed the server-to-client request channel. The hosted
  port would need the token prompt rewritten as `inputRequired.elicit(...)`,
  which the handler returns rather than awaits
