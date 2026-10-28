# Changelog

Published versions of `@edgegap/mcp`, which also run on the hosted endpoint at `mcp.edgegap.dev`. Dates are npm publish dates. Versions merged but never published (0.5.8, 0.6.0, 0.8.0) shipped as part of the next release. Older entries are summarised from the commit history.

## 0.14.1

- `edgegap_build_matchmaker_config` leaves `expansions` out of the profile when there are no expansion stages, instead of emitting `"expansions": {}`. The key is optional, and the empty object read as a slot to fill in (review feedback on the NGO Boss Room sample). Covered by `test/unit.test.mjs`.
- Skills pack 0.21.1: the same empty `expansions` object is gone from every matchmaker template without an expansion stage.

## 0.14.0

Gameye parity (gameye-mcp 0.4.0, 2026-10-25) for everything that needs no Edgegap platform change, and CPU and memory on versions. Every new endpoint and body field is in the public API spec ([edgegap/openapi-specification](https://github.com/edgegap/openapi-specification) 966ccc3, identical to `spec/`), checked by `test/spec.mjs`. New tools are tested against a mock API only.

**Behaviour changes**

- `edgegap_deploy` refuses a version whose `max_duration` is unlimited or above `EDGEGAP_MAX_DURATION_MINUTES` (default 60), unless the agent passes the new `allow_long_running: true`; the description tells it to ask the developer first. Versions made outside the agent default to 1440 minutes, so deploying them now needs that flag.
- `edgegap_update_skills` with `apply: true` runs the skills CLI or `claude plugin update` only when the server was started with `EDGEGAP_ENABLE_SKILLS_UPDATE=1`; otherwise it lists the commands. Hand copies are still rewritten from the bundle.

**Security**

- The updaters `edgegap_update_skills` starts no longer inherit the server's whole environment, which included `EDGEGAP_API_TOKEN`. They get an allowlist (path, home, temp, locale, proxy, CA and npm settings), minus `EDGEGAP_*` and anything named like a token, secret, password, key or credential.
- The skills CLI is pinned: `npx -y skills@1.7.4 update …` instead of whatever is newest on npm.

**Limits**

- `EDGEGAP_MAX_DEPLOYS_PER_RUN` (default 20, local server only): deploys one process may send, failed ones included.
- `EDGEGAP_STOP_OWN_ONLY=1` (local, self-hosted and Worker): `edgegap_stop_deployment` refuses deployments without the `edgegap-mcp` tag.
- When the API refuses a deploy but still creates a deployment (seen live: a 422 "Not enough space on locations" left an ERROR deployment, 2026-10-28), the error names it so the agent can stop it.
- `edgegap_context` reports the new limits.

**New on `edgegap_deploy`**: `webhook_on_ready`, `webhook_on_error`, `webhook_on_terminated` (https only, no credentials, refused if they hold the token), `require_cached_locations`, and `private_host_ids`, which sends the same body to `POST /v2/private-fleets/deployments`.

**New tools** (10): `edgegap_tag_deployment` (the `edgegap-mcp` tag cannot be removed), `edgegap_report_deployment`, `edgegap_delete_app_version` and `edgegap_delete_app` (one exact name, refused while deployments run; an app with versions needs `max_versions`), `edgegap_list_fleet_hosts`, `edgegap_list_endpoint_storage`, `edgegap_create_endpoint_storage` (secret key masked in dry runs, never echoed), `edgegap_create_pull_profile`, `edgegap_link_pull_profile`. `edgegap_create_app_version` and `edgegap_update_app_version` take `endpoint_storage`. DESIGN.md's Scope and allowlist sections are updated.

**Skills pack 0.21.0** (llm-agent-skills 02f2b96, PR #32): agents check the installed skills once per conversation with `edgegap_update_skills`, and get guidance for every tool above.

**Repository**

- CI: actions pinned by commit SHA, a Windows job (build and the stdio tests), and an `npm audit --omit=dev --audit-level=high` job. Dependabot proposes npm and Actions updates weekly (the MCP SDK is left out: `agents` pins it).
- `npm run build` no longer calls `chmod` (`scripts/chmod-bin.mjs`), so it runs under cmd.exe.
- `.github/workflows/publish-npm.yml`: npm trusted publishing with provenance and an SBOM, run by hand for a tag. Unused until npmjs.com lists it as a trusted publisher; releases still go through `release.sh`.
- README: Windows notes, the new variables, tools and guardrails, Docker settings.

**CPU and memory on versions**

- `edgegap_update_app_version` takes `cpu_units` and `memory_mb` (sent as `req_cpu`/`req_memory`, which the public spec's `PATCH /v1/app/{app}/version/{version}` accepts). Both or neither, and memory at most twice the CPU units, as on `edgegap_deploy`; otherwise refused with nothing sent. The description no longer says resources cannot be changed on a version.
- `edgegap_deploy`'s per-deployment override is unchanged: `resources: {cpu_units, memory_mib}` per `DeploymentV2.resources`. Checked live 2026-10-28: a 512/1024 override on a 256/512 version deployed READY, and a 1024-vCPU override got 422 "Not enough space on locations", so the API reads the field rather than ignoring it.
- The 422 hint ("could not allocate a server") names the tool parameters `cpu_units`/`memory_mb` instead of the API's `req_cpu`/`req_memory`.
- Tests: `test/newtools.mjs` (PATCH body, both-or-neither and ratio refusals, description), `test/spec.mjs` (the new body fields are in the public spec).

## 0.13.3

- `edgegap_build_matchmaker_config`: an expansion that only repeats the initial `min_team_size` is left out, with a caution. Partial matches need no expansion: `min_team_size` below `max_team_size` allows them, and a short `ticket_expiration` (30s) keeps the wait short, while every expansion costs the matchmaker performance. The `expansions` parameter description says so. Covered in `test/unit.test.mjs`.
- Skills pack 0.20.0 (llm-agent-skills 5661d8b, PR #31): the `casual` templates drop the `15` s expansion that only repeated `min_team_size`, the guidance says partial matches come from min < max plus the 30 s expiration, and `edgegap-purrnet` 0.2.0 listens on 7777 instead of 5000.

## 0.13.2

- Instructions: after the golden path, suggest Edgegap's GitHub Action [edgegap/deploy-action](https://github.com/edgegap/deploy-action) for every later build (create the version from an existing one, smoke-test, promote), instead of repeating the steps by hand or writing Deploy API code for CI. Covered in `test/skills.mjs`.
- Skills pack 0.19.0 (llm-agent-skills 162d8ae): `edgegap-launch` 0.3.0 documents the action; the router, `edgegap-deployments-api`, `edgegap-containerize` and the Manus deploy guide send CI deploys there.

## 0.13.1

Hosted analytics fixes, found in the first day of 0.12.0 data. No tool behavior changes.

- Refusals (a token in an env var, the `latest` tag, the encrypted-secret placeholder, a wildcard stop) are recorded as `error_code: GUARDRAIL_REFUSED`. They were recorded as `VALIDATION_FAILED`, because the check looked for "Refused" at the start of the result, which begins with the `[api.edgegap.com]` host label.
- `client_name` and `client_version` are set on every event. The hosted server is stateless, so the SDK only knew the MCP client on the `initialize` request and most tool calls had no client name. Later requests now name the client from their `User-Agent` (`claude-code/2.1.310 (cli)` → `claude-code` 2.1.310); the new `client_name_source` says which: `client_info` or `user_agent`.
- Tests: `test/unit.test.mjs` (refusals after the host label), `test/reports.mjs` and `test/worker-telemetry.mjs` require `GUARDRAIL_REFUSED` exactly, and check the User-Agent fallback.

## 0.13.0

The Edgegap API never returns stored secrets: reading a version gives the literal string "This value is set and encrypted" for `private_username`, `private_token` and every secret env value (found 2026-10-26). An agent that copied a version's settings sent the placeholder back, it replaced the real login, and image pulls failed with "Unable to login".

- `edgegap_create_app_version`, `edgegap_update_app_version` and `edgegap_deploy` refuse a registry login or env value equal to that placeholder (any case, surrounding spaces ignored), with nothing sent. The error says where the real value comes from (the dashboard's Container Registry page, or the developer) and, for updates, to leave the registry fields or `env` out to keep the current ones.
- `edgegap_list_app_versions`' description no longer says to "copy settings from a working version": only non-secret settings. The create and update descriptions mention the placeholder too.
- Skills pack 0.18.0 (llm-agent-skills 85321a2): agent rules, the API reference and the Colyseus and Manus deploy references say to copy only non-secret settings.
- Tests: `test/newtools.mjs` (refusals on all three tools, dry run included, and a value merely containing the text still sent) and `test/unit.test.mjs` (`isEncryptedPlaceholder`).

## 0.12.0

From a review of the first 12 days of hosted traffic: empty organizations should get a next step instead of an error, and analytics should say why a call failed instead of leaving it to guesswork.

**Empty and "not set up" states are results, not errors.** Each comes back with `status` and a `next_step`:
- `edgegap_list_apps`, `edgegap_list_app_versions`, `edgegap_list_deployments`, `edgegap_list_relay_sessions`: `status: "empty"` with what to do next (create an application, register a version, nothing left to stop...).
- `edgegap_list_relay_sessions` for an organization without relays (403): `status: "not_configured"`, no sessions, nothing billing.
- `edgegap_list_registry_tags`: an image never pushed is `status: "not_found"` with the push steps and the Docker Hub/GHCR path (was an error); one with no tags is `"empty"`; a token that cannot read the registry (403) is `"not_configured"`.
- `edgegap_get_deployment_logs` asks the status endpoint why there are no logs: the deployment does not exist in this organization (still an error, `DEPLOYMENT_NOT_FOUND`), has not started yet (`"not_ready"`, wait first), or has stopped and its logs went with it (`"expired"`, with the `error_detail` Edgegap kept).
- `edgegap_get_registry_credentials`' manual steps carry a `next_step` too: ask for the dashboard login or use another registry, and do not call it again. Its description and `edgegap_list_registry_tags`' say that Docker Hub, GHCR and other registries work with `edgegap_create_app_version`.

**Every step says what comes next.** `next_step` on list results, `edgegap_get_deployment` (connect, wait, or read the logs), `edgegap_create_app_version` (the exact deploy), `edgegap_stop_deployment` (confirm nothing is left). `edgegap_wait_for_deployment`:
- ready: a `cost_reminder` with the exact `edgegap_stop_deployment` call, and the address in `next_step`;
- failed: says not to redeploy the same version unchanged, and when it could not read logs, names the `edgegap_get_deployment_logs` call to try;
- timed out: the current status, and "call again, do not deploy a second server";
- sends MCP progress notifications while it polls, when the client asks for them.

**Errors the agent can fix.** API validation detail (`details`) is passed through with secrets masked, so a duplicate version name or a bad port reads as such. A quota or plan limit says which limit and to raise it on the Billing page instead of suggesting a new token.

**Fewer refusals before the API is called.** `limit` on the list tools, `max_characters` on `edgegap_get_deployment_logs` and `timeout_seconds` on `edgegap_wait_for_deployment` are clamped into range instead of refused (their ranges moved from the schema to the descriptions; any value accepted before is accepted now). `edgegap_build_matchmaker_config` without a token builds the config and says the version was not checked, instead of failing.

**Onboarding without a token.**
- `edgegap_context` reports `token_status` (present, accepted, rejected, absent, or a client-issued credential, with what to do), the token's last four characters to find it on the tokens page, and `works_without_token`. New optional `check_token: true` makes one read-only call to confirm Edgegap accepts the token; without it the tool still makes no API call.
- Token messages, local and hosted, give the sign-up link and list the tools that work without a token.
- `edgegap_get_skill` suggests the skill that was probably meant ("unity" → `edgegap-unity`).
- New prompt `deploy-game-server` ("Deploy my game server to Edgegap"): the obvious place to start. It finds the engine and netcode, loads the matching skill and walks the golden path, cleanup included.
- Unity `.meta` files are no longer listed in skill file indexes (one session read `EdgegapSettings.cs.meta` 14 times). They stay in the bundle and readable by exact path: the PurrNet skill asks agents to copy one.

**Hosted analytics** (`docs/analytics.md` has the full list and the real-user definition):
- Every `$mcp_tool_call` carries `tool_name`, `success`, a stable `error_code`, a sanitized `error_message` (token, argument values and credential-shaped strings masked, 300 characters), `failed_stage` (`pre_flight`/`upstream`/`post_process`), `upstream_status`, `upstream_calls`, `latency_ms`, `org_id_hash`, `is_internal`, `client_name`/`client_version`, `transport` and `server_version`, plus tool facts: `skill_name`, `wait_for_deployment`'s `outcome`/`final_status`/`poll_count`/`timeout_ms_configured`, the validator's `validation_result`/`issue_count`, a salted `request_id_hash` on deploy, wait and stop, matchmaker config shape, empty-state `result_state`.
- New events: `mcp_session_started` on initialize, and `mcp_milestone_*` for each golden-path step (registry credentials, image pushed, app found or created, version created, deployment ready, deployment stopped). `$mcp_prompt_get` adds `prompt_name`.
- `is_internal` comes from the new `TELEMETRY_INTERNAL_IDS` Worker variable; `npm run telemetry:id` prints a token's id. `is_probe` flags tokenless scanner traffic and made-up tool names.
- The README's analytics paragraph says what changed: a sanitized error message is now sent on failed calls.
- Skills pack 0.17.0 (llm-agent-skills `ec626ec`, 22 skills): agent rules for empty states, the registry, token problems, waiting and cleanup, matching this release. Includes 0.16.0's new `edgegap-matchmaking` skill (matchmaking design, parties, regions, backfill, third-party matchmakers), now routed in the server instructions.
- README: install snippets for Cursor, VS Code and Windsurf, the six skills missing from the table, and troubleshooting for empty states and starting without a token.

## 0.11.0

- `edgegap_update_app_version` takes `ports` and `env`. Edgegap's spec (2026.10.23) now says updating them **replaces all current values**, so the description, the parameters and the result all say so. `env` gets the same token refusal and secret-name hiding as create; `ports` gets the same `tls_upgrade` check.
- `edgegap_deploy`'s `cpu_units`/`memory_mb` override is documented by Edgegap now (v2 `DeploymentV2.resources`), so the "may be ignored" warning is gone. Passing only one of the two is refused instead of silently dropped, memory over twice the CPU is refused locally, and the result reports the `resources` that were sent.
- `spec/` refreshed to the latest Edgegap specs (v1 2026.10.23, v2 2026.08.05).
- Lighter connection:
  - `edgegap_list_skills` and `edgegap_get_skill` no longer repeat the engine-to-skill routing; the server instructions carry it once.
  - Resources list each skill's `SKILL.md` only (21 instead of 257). Every other file is read through the new `edgegap-skill://{skill}/{+path}` template, on the local and hosted servers alike.
- Output schemas on 14 tools: context, apps and versions, locations and beacons, deploy, deployments, metrics, registry tags, relay sessions, and the config validator. They're loose (optional fields, extra fields allowed), so they document the result rather than reject it. Results also leave out `null` fields.
- Bad arguments get the API host label like every other result, one plain line per problem ("version: missing (required)", "application: must be string (got number)"), and the tool's required and optional parameters. Errors the SDK raises itself now go through the token scrub too.
- The repository is `edgegap/llm-mcp-server`: `package.json`, `server.json` and the README use the new name. The Docker image is published as `ghcr.io/edgegap/llm-mcp-server`, and still as `ghcr.io/edgegap/edgegap-mcp` for existing hosts.
- The MCP registry entry has an icon (the repository's `icon.png`).
- Dependencies: `zod` ^4.6.7, plus `body-parser` 2.4.0 and `fast-uri` 3.1.9 in the lockfile, for GHSA advisories (zod memory exhaustion, body-parser DoS, fast-uri URI spoofing). They affected the Docker image, the hosted Worker and the `.mcpb` bundle, which install from the lockfile. `npx` installs already resolved the fixed versions. `npm audit --omit=dev` is clean. Dev-only `wrangler` 4.152.0 still carries a Cloudflare-pinned `undici` advisory.

## 0.10.0 (2026-10-22)

From a review of the hosted server's PostHog errors: several "errors" were expected answers, and some real ones did not say what to do.

- `edgegap_get_registry_credentials` with a regular API token returns the manual steps as a normal result (`status: "manual_steps_required"`, `credentials_returned: false`), not an error. Every regular-token developer was counted as a failed call, and some agents retried.
- A 403 now gets an explanation: for relay tools, that the organization cannot use relays (the token is fine, a new one will not help); for any other tool, that the feature or resource is not available to this organization. Before, agents saw only "You are not authorized to access this resource".
- `edgegap_wait_for_deployment` puts the tail of the container logs in its failure message. A failed deployment is cleaned up quickly, so a separate `edgegap_get_deployment_logs` call often found nothing.
- `edgegap_wait_for_deployment` running out of time is no longer an error: it returns the deployment with `ready: false` and says to wait again or stop it.
- `edgegap_stop_deployment` is idempotent as declared: stopping a deployment that is already terminated returns `already_stopped`, and one Edgegap no longer knows returns `not_running` (it says the request_id may be wrong instead of claiming it stopped anything).
- Hosted analytics: failed calls carry `error_cause`, a fixed label (`token_absent`, `token_foreign`, `api_<status>`, `validation`, `unknown_tool`, `deployment_failed`, `request_timeout`, `network`, `unknown_skill`, `guardrail_refused`, `other`) read from the error text, which is still never sent. Known MCP scanners (`sentinel-probe`, `verifymcp-probe`, `mcp-checkup-prober`) are flagged `probe: true`.

## 0.9.1 (2026-10-22)

- Skills pack 0.15.2 (llm-agent-skills `f3fd976`, 21 skills). Every matchmaker template and skill example now uses a 30 s `ticket_expiration` with expansions at or under 20 s, matching the `edgegap_build_matchmaker_config` default since 0.8.0, so the skills no longer tell agents to use 5 minutes.

## 0.9.0 (2026-10-22)

- New `edgegap_update_skills`: checks whether the Edgegap skills installed in the developer's agent are current, skill by skill, against GitHub main. The local server finds skills CLI installs (user-wide and project), the Claude Code plugin `edgegap@edgegap` and skills copied by hand into `~/.claude/skills`, `~/.agents/skills` and similar folders. With `apply: true` it runs `npx skills update` for the Edgegap skills only or `claude plugin update`, and rewrites hand-copied skills from this release's bundle, keeping files the developer added and refusing symlinks and git checkouts. Refused in read-only mode. On the hosted server it compares the versions an agent passes in `installed_versions`. It never downloads skill text.
- Skills version check: `edgegap_list_skills` reports `latest_pack` from GitHub and whether the served pack is the latest; `edgegap_get_skill` adds a note under the header when it is not. One request for a version number, cached for an hour, 3 s timeout; `EDGEGAP_SKILLS_CHECK=off` turns it off. `edgegap_list_skills` is now marked `openWorldHint`.
- One-click install: `manifest.json` builds an MCPB bundle (`npm run bundle`) of the local server with its runtime dependencies, for Claude Desktop and other MCPB clients. Its settings set the token (kept in the OS secure storage), read-only mode, the allowlist, the max duration ceiling and the deployment cap. `.github/workflows/mcpb.yml` attaches `edgegap-mcp.mcpb` to every GitHub release. An unexpanded `${user_config.*}` value in the environment counts as unset.
- Tests: `test/updateskills.mjs` (fake home folder and a local stand-in for GitHub), and `test/package.mjs` keeps `manifest.json`'s version and tool list in step with the package.

## 0.8.0 (2026-10-22)

- `edgegap_build_matchmaker_config` defaults `ticket_expiration` to `"30s"` (was `"5m"`). On matchmaker 3.3.2 a lone or partial ticket may only be matched when it nears expiry, so a developer testing alone waited about 5 minutes and gave up. The "is short" caution now starts below 20 s instead of 60 s, and a new caution flags any expansion whose `after_seconds` is at or past the expiration (it never applies). Pass `ticket_expiration` to keep longer production queues.

## 0.7.2 (2026-10-22)

- Skills pack 0.15.1 (llm-agent-skills `6bd8353`, 21 skills). Every skill now tags server images and names app versions with the same UTC timestamp, `YYYYMMDD-HHMM` (e.g. `20261022-1430`), instead of `v1`, `v2` or `latest`, so anyone can see when a server was last updated: agent rules, matchmaker templates, build steps, the BR200 and Simple FPS `package.sh` defaults and the Manus GitHub workflow.
- Includes pack 0.15.0: new skill `edgegap-threejs` for Three.js and other browser games with their own Node.js server, verified with `netcode-sample-threejs-minigames`. The server instructions, `edgegap_get_skill` and `edgegap_list_skills` name it.
- `sync-skills` accepts `.html` and `.css` files (served as `text/html` and `text/css`) and points to the renamed repository, github.com/edgegap/llm-agent-skills.

## 0.7.1 (2026-10-21)

- Skills pack 0.14.0 (edgegap-agent-skills `67df139`): new skill `edgegap-playfab` for games that keep PlayFab for players, login and Matchmaking. A rule on `match_found` runs Azure Functions that deploy an Edgegap server near the matched players and hand out the address through read-only player data, verified end to end with `sample-playfab-matchmaker-fishnet`. `edgegap` routes PlayFab to it, and `edgegap-deployments-api`, `edgegap-unity` and `edgegap-fishnet` point to it.
- The server instructions, `edgegap_get_skill` and `edgegap_list_skills` name `edgegap-playfab`.
- `sync-skills` accepts `.js` and `.funcignore` files (the skill ships Node Azure Functions).

## 0.7.0

**New tools:**
- `edgegap_list_locations` and `edgegap_list_ping_beacons`: where servers can run (only the locations with capacity, when you give a version) and the beacons clients ping to measure latency.
- `edgegap_get_app_version` and `edgegap_update_app_version`: read a version in full, and change its tag, active state, max duration, registry login, image caching (`force_cache`), verify_image or grace period without creating a new one.
- `edgegap_update_app`: turn an application on or off.
- `edgegap_get_deployment_metrics`: CPU, throttling, memory and network, as latest, average and peak.
- `edgegap_delete_registry_tag`: delete one exact tag. Wildcards, `latest` and bulk deletes are refused.
- `edgegap_list_relay_sessions` and `edgegap_revoke_relay_user`.

**Changes:**
- Every result is scrubbed of the API token, including successful ones. Results also carry `structuredContent`.
- `edgegap_deploy` now says its `cpu_units`/`memory_mb` override is not in the published v2 API and may be ignored.
- The Docker image is built for `linux/arm64` as well as `linux/amd64`.
- New tests: spec parity (`test/spec.mjs`), a tool-list snapshot (`test/snapshot.mjs`) and unit tests. CI also scans every tracked file for secrets and local paths.

## 0.6.3 (2026-10-21)
- Skills pack 0.13.1, with 19 skills: adds Photon's Simple FPS sample, Godot, Colyseus and Nakama, all routed in the server instructions.

## 0.6.2 (2026-10-20)
- `edgegap_build_matchmaker_config` next steps poll `GET /tickets/{id}`; groups and memberships are offered only as the party alternative.

## 0.6.1 (2026-10-20)
- Guardrails:
  - Refuses `latest`, empty and malformed image tags.
  - Refuses a `docker_image` that holds a registry or tag.
  - `EDGEGAP_MAX_AGENT_DEPLOYMENTS` caps running agent deployments (default 5).
  - Env vars named like secrets are hidden in the dashboard.
- The hosted endpoint only accepts UUID Edgegap tokens; other bearers are reported as `auth_problem: foreign`.
- Skills pack 0.9.0, adding `edgegap-fusion`.

## 0.5.7 (2026-10-20)
- Skills pack 0.8.0: adds `edgegap-ngo` and `edgegap-eos-voice`, routed in the instructions.

## 0.5.6 (2026-10-19)
- The hosted endpoint records why a call had no token (`auth_problem`).

## 0.5.5 (2026-10-15)
- Serves `edgegap-manus`. Fixes cached tool schemas blocking new skills. Upgrades dependencies past open advisories.

## 0.5.4 / 0.5.3 (2026-10-15)
- Serves `edgegap-purrnet` and `edgegap-fishnet`.

## 0.5.2 (2026-10-14)
- PostHog MCP Analytics on the hosted Worker (opt-out header; the local server sends nothing).

## 0.5.1 (2026-10-14)
- The skills line comes first in the server instructions.

## 0.5.0 (2026-10-14)
- Serves the Edgegap agent skills over MCP: `edgegap_list_skills`, `edgegap_get_skill`, prompts and `edgegap-skill://` resources.

## 0.4.0 (2026-10-13)
- Guardrails:
  - `dry_run` on every write tool.
  - Refuses the API token in env vars, tags and webhooks.
  - Forced `edgegap-mcp` deploy tag.
  - Auto-stop reporting.
  - Strict single-ID stop.
  - API host label on every result.
- Adds `edgegap_context` and a `User-Agent`.

## 0.3.3 / 0.3.2 / 0.3.1 (2026-10-08 to 2026-10-09)
- Fixes from the WebGL + Mirror + matchmaker end-to-end test.
- Registry tools fixed against the real API.
- `npx @edgegap/mcp` starts again.

## 0.3.0 / 0.2.2 / 0.2.0 (2026-09-30 to 2026-10-01)
- Dockerfile generator and validator, relays, and a matchmaker config builder.
- Dedicated servers recommended over relays.

## 0.1.x (2026-09-14 to 2026-09-16)
- First releases: apps, versions, deploy, wait, logs, stop.
