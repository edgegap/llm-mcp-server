# Changelog

Published versions of `@edgegap/mcp`, which also run on the hosted endpoint at `mcp.edgegap.dev`. Dates are npm publish dates. Versions merged but never published (0.5.8, 0.6.0, 0.8.0) shipped as part of the next release. Older entries are summarised from the commit history.

## 0.11.0

- `edgegap_update_app_version` takes `ports` and `env`. Edgegap's spec (2026.10.23) now says updating them **replaces all current values**, so the description, the parameters and the result all say so. `env` gets the same token refusal and secret-name hiding as create; `ports` gets the same `tls_upgrade` check.
- `edgegap_deploy`'s `cpu_units`/`memory_mb` override is documented by Edgegap now (v2 `DeploymentV2.resources`), so the "may be ignored" warning is gone. Passing only one of the two is refused instead of silently dropped, memory over twice the CPU is refused locally, and the result reports the `resources` that were sent.
- `spec/` refreshed to the latest Edgegap specs (v1 2026.10.23, v2 2026.08.05).
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
