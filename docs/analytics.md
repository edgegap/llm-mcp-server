# Analytics

What the hosted endpoint (`mcp.edgegap.dev`) sends to Edgegap's PostHog, how to tell real users from probes and from our own team, and the insights to build on it.

The local server (`npx @edgegap/mcp`), the `.mcpb` bundle and the Docker image send nothing. The code is `worker/telemetry.ts` (events, allowlist, identity) and `src/callreport.ts` (what one tool call did). Analytics is off unless the Worker has `POSTHOG_API_KEY`; a client opts out with `X-Edgegap-Telemetry: off` or `DNT: 1`.

## Real users

A **real user** is a session whose requests carry a valid Edgegap token (`has_token: true`, so `org_id_hash` is set), at least one call of which reached the Edgegap API without a 401 (`upstream_status` not 401), and whose `is_internal` is `false`. Whatever the client name: `codex-mcp-client` is the real Codex CLI, and Claude Desktop sends a different name than Claude Code.

As a PostHog filter on `$mcp_tool_call`: `org_id_hash` is set, `is_internal` = false, `error_code` ≠ `AUTH_REJECTED`. Drop `is_probe` = true everywhere.

Two limits to keep in mind:

- **`org_id_hash` is a token hash, not an organization id.** Edgegap's API has no endpoint that names the organization a token belongs to, so `org_id_hash` is `org_` + HMAC-SHA256(token, `TELEMETRY_SALT`), the same value as `distinct_id`. Tokens are organization-wide, so one token is one organization, but an organization with two tokens shows as two ids.
- **`is_internal` needs the ids listed.** Set the Worker variable `TELEMETRY_INTERNAL_IDS` to a comma-separated list of the `org_` ids of Edgegap's own and test tokens. Get one with `npm run telemetry:id` (paste the `TELEMETRY_SALT`, Enter, the token, Enter; both are read from stdin and nothing is sent). Every new internal token has to be added.

## Events

| Event | When | Notes |
| --- | --- | --- |
| `$mcp_initialize` | Each `initialize` | From `@posthog/mcp`. |
| `mcp_session_started` | Each `initialize` request | `client_name`, `client_version` from `clientInfo`, plus the common properties. The hosted server is stateless (one MCP server per HTTP request, no storage), so there is no `mcp_session_ended`: nothing marks the end of a session. |
| `$mcp_tools_list`, `$mcp_resources_list` | Discovery | From `@posthog/mcp`. |
| `$mcp_tool_call` | Each tool call | The SDK's event, with the per-call properties below merged in. |
| `$mcp_resource_read` | Each resource read | `resource_uri` and `skill_name` for `edgegap-skill://` URIs; any other URI is reported as `other`. |
| `$mcp_prompt_get` | Each `prompts/get` | `prompt` and `prompt_name` (same value). The TypeScript SDK does not track prompts, so the Worker reads the JSON-RPC body. |
| `mcp_milestone_*` | A tool call reached a golden-path step | See [Milestones](#milestones). |

There are no OAuth events (`mcp_auth_started`/`completed`/`failed`): the hosted server has no OAuth flow. See [claude.ai](#claudeai-and-the-anthropicclaudeai-pattern).

## Properties

### On every event

| Property | Values |
| --- | --- |
| `has_token` | `true` when the Authorization header held an Edgegap token (a UUID). |
| `auth_problem` | `absent` (no header) or `foreign` (a credential the MCP client issued itself, such as the claude.ai connector's own bearer). Unset when there is a token. |
| `org_id_hash` | `org_<32 hex>`, or `null` without a token. |
| `is_internal` | `true` when `org_id_hash` is in `TELEMETRY_INTERNAL_IDS`. |
| `transport` | `streamable_http` (the only transport that sends analytics). |
| `server_version` | e.g. `0.12.0`. Also `$mcp_server_version`. |
| `client_name`, `client_version` | From MCP `clientInfo`, when the SDK knows it. Also `$mcp_client_name`, `$mcp_client_version`. |
| `read_only`, `country` | Read-only mode; Cloudflare's country code (GeoIP is off). |
| `probe` | `true` for known scanner clients (`sentinel-probe`, `verifymcp-probe`, `mcp-checkup-prober`). Kept for dashboards from 0.10.0. |
| `is_probe` | `true` when there is no token and the client is a known scanner, or the tool name is made up (`__verifymcp_*`, an unknown tool). Events are kept, not dropped. |

### On every `$mcp_tool_call`

| Property | Values |
| --- | --- |
| `tool_name` | Also `$mcp_tool_name`. |
| `success` | `false` when the result was an error. Empty and "not set up" states (`status: "empty"`, `"not_configured"`...) are successes. |
| `error_code` | Stable code, `null` on success. See [Error codes](#error-codes). |
| `error_message` | The tool's error text, at most 300 characters, with the token, the call's argument values (replaced by `<argument name>`), UUIDs, JWTs, IPs, `token=`/`password:` values and long opaque strings masked. `null` on success. |
| `failed_stage` | `pre_flight` (refused before any API call: no token, bad arguments, a guardrail), `upstream` (the Edgegap API rejected it, or the deployment itself failed), `post_process` (the API answered fine, the tool failed after). `null` on success. |
| `upstream_status` | HTTP status of the last Edgegap API response in the call, `null` if the API was never called. |
| `upstream_calls` | How many Edgegap API requests the call made. |
| `latency_ms` | Also `$mcp_duration_ms`. |
| `dry_run` | `true` on a dry run. |
| `error_cause` | 0.10.0's coarse label (`token_absent`, `api_404`, `validation`...), kept for existing dashboards. Prefer `error_code`. |

### Tool-specific

| Tool | Properties |
| --- | --- |
| `edgegap_get_skill` | `skill_name`, `skill_file`, `resource_uri` (also `skill`, from 0.5) |
| `edgegap_wait_for_deployment` | `outcome` (`ready`, `error`, `timeout`), `final_status`, `timeout_ms_configured`, `poll_count`, `request_id_hash` |
| `edgegap_validate_server_config` | `validation_result` (`pass`, `fail`), `issue_count`, `error_count`, `warning_count`, `engine`, `checked_dockerfile` |
| `edgegap_deploy`, `edgegap_stop_deployment` | `request_id_hash` (`req_` + 16 hex, a salted hash, so a deploy can be paired with its stop); deploy: `resources_override`; stop: `stop_result` (`stopped`, `already_stopped`, `not_running`) |
| `edgegap_build_matchmaker_config` | `matchmaker_template` (`single_profile`), `team_count`, `has_latency_rule`, `expansion_count`, `problem_count`, `version_verified` |
| `edgegap_get_registry_credentials` | `registry_status` (`credentials_returned`, `manual_steps_required`) |
| `edgegap_create_app_version` | `registry_login_set` |
| List tools | `item_count`; `result_state` (`empty`, `not_configured`, `not_found`, `not_ready`, `expired`) when the result was an empty state; `only_agent_deployments` on `edgegap_list_deployments` |
| `edgegap_context` | `token_state` (`present (not checked)`, `accepted`, `rejected`, `absent`, `foreign`, `not_provided`) |

### Error codes

| Code | Meaning |
| --- | --- |
| `AUTH_ABSENT` | No token on the request. |
| `AUTH_FOREIGN` | The Authorization header held a credential the MCP client minted for itself, not an Edgegap token. Never relayed. |
| `AUTH_DECLINED` | Local server only: the developer declined the token prompt. |
| `AUTH_REJECTED` | Edgegap answered 401. |
| `FORBIDDEN`, `NO_RELAY_ACCESS` | 403: the feature or resource is not available to this organization. |
| `QUOTA_REACHED` | A plan or quota limit, read from the API's message. |
| `APP_NOT_FOUND`, `DEPLOYMENT_NOT_FOUND`, `LOGS_NOT_FOUND`, `RELAY_NOT_FOUND`, `NOT_FOUND` | 404 (or the 400 the deployment endpoints use for an unknown request_id), by what the tool was looking for. `NOT_FOUND` also covers an unknown tool name. |
| `SKILL_NOT_FOUND` | Unknown skill or skill file. |
| `CONFLICT` | 409: the name exists. |
| `NO_CAPACITY` | 422: no server could be placed. |
| `IMAGE_PULL_FAILED` | 424. |
| `RATE_LIMITED` | 429. |
| `UPSTREAM_REJECTED` | Any other 4xx. |
| `UPSTREAM_ERROR` | 5xx. |
| `TIMEOUT`, `NETWORK` | No response from the API. |
| `DEPLOYMENT_FAILED` | `edgegap_wait_for_deployment` saw the deployment fail. |
| `VALIDATION_FAILED` | Bad arguments, or a tool's own input check (including matchmaker config problems). |
| `GUARDRAIL_REFUSED` | A guardrail refused the call (token in an env var, `latest` tag, deployment cap, wildcard stop). |
| `INTERNAL` | Anything else. |

Codes are only ever added, never renamed.

## Milestones

One event per golden-path step a call reached, with `milestone`, `tool_name`, `org_id_hash`, `is_internal`, `client_name`, `transport`, `server_version`. They fire every time, not only the first time (the Worker keeps no state); funnels take the first occurrence per person.

| Event | Fired by |
| --- | --- |
| `mcp_milestone_registry_credentials_ok` | `edgegap_get_registry_credentials` returned credentials (quick-start tokens only; regular tokens get `registry_status: manual_steps_required` on the tool call instead) |
| `mcp_milestone_image_pushed` | `edgegap_list_registry_tags` returned at least one tag |
| `mcp_milestone_app_created` | `edgegap_create_app` succeeded, or `edgegap_list_apps` found at least one application |
| `mcp_milestone_app_version_created` | `edgegap_create_app_version` succeeded |
| `mcp_milestone_deployment_ready` | `edgegap_wait_for_deployment` returned `ready` |
| `mcp_milestone_deployment_stopped` | `edgegap_stop_deployment` stopped a deployment |

Images in Docker Hub or GHCR never fire `image_pushed`: build the funnel with that step optional, or from `app_version_created` on.

## Never sent

The API token, in any form. Tool argument values (`$mcp_parameters`), results (`$mcp_response`), the SDK's raw error text (`$mcp_error_message`, `$exception`), deployment request_ids in clear, skill document content, and any property not on the allowlist in `worker/telemetry.ts`. `test/worker-telemetry.mjs` runs the real Worker against a fake PostHog and fails if the token, a foreign bearer, an IP, an env value or an app name appears anywhere in the payloads; `test/reports.mjs` checks the same for the per-call reports.

## Suggested insights

1. **Golden-path funnel by `client_name`**: `mcp_session_started` → `mcp_milestone_app_created` → `mcp_milestone_app_version_created` → `mcp_milestone_deployment_ready` → `mcp_milestone_deployment_stopped`, real users only, broken down by `client_name`.
2. **Errors by `error_code` for real users**: `$mcp_tool_call`, `success` = false, real-user filter, broken down by `tool_name` and `error_code`; a second breakdown by `failed_stage` separates our refusals from API rejections.
3. **`edgegap_wait_for_deployment` latency by `outcome`**: P50/P95 of `latency_ms` split by `outcome`. Only shorten the default timeout if `timeout` is common; check `poll_count` and `final_status` on timeouts first.
4. **Orphaned deployments**: per `org_id_hash`, `request_id_hash` values seen on `edgegap_deploy` successes with no matching `edgegap_stop_deployment`. Deployments that stop themselves or hit `max_duration` show as orphans too, so treat it as an upper bound.
5. **Auth drop-off by client**: `mcp_session_started` and `$mcp_tool_call` grouped by `client_name` and `auth_problem`; the share of sessions that never get a call with `has_token` = true.
6. **Empty states**: `result_state` on successful list calls, to see how many developers arrive with no application, no image or no relay access.
7. **Validator usefulness**: `edgegap_validate_server_config` by `validation_result` and `issue_count`.
8. **Skill re-fetches**: `edgegap_get_skill` count per `$session_id` and `skill_name`, to see whether agents reload the same `SKILL.md` within a session.

## claude.ai and the `Anthropic/ClaudeAI` pattern

claude.ai custom connectors connect by URL and cannot send a custom header. With no OAuth on this server they send either nothing (`auth_problem: absent`) or their own bearer (`auth_problem: foreign`), and every tool that needs a token fails with `AUTH_ABSENT` or `AUTH_FOREIGN`. Discovery (`initialize`, `tools/list`, `resources/list`) still works, which matches the pattern of many IPs each making one `resources/list` and no tool calls. `mcp_session_started` broken down by `client_name` and `auth_problem` shows its size. Fixing it needs an OAuth authorization server in front of the hosted endpoint (`worker/DECISION.md`), which is an architecture change outside this release.
