# Edgegap MCP Server

Connect AI coding agents to Edgegap through our MCP server. Your agent can take a headless server build all the way to players connecting: write or check the Dockerfile, push the image to your private Edgegap registry, deploy an authoritative dedicated server close to players, and read logs when something breaks.

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=Edgegap&config=eyJ1cmwiOiJodHRwczovL21jcC5lZGdlZ2FwLmRldi9tY3AiLCJoZWFkZXJzIjp7IkF1dGhvcml6YXRpb24iOiIifX0%3D)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Edgegap_MCP-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=Edgegap&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.edgegap.dev%2Fmcp%22%2C%22headers%22%3A%7B%22Authorization%22%3A%22%22%7D%7D)

## 👉 Supported Features

> [!TIP]
> **Using Unity, Unreal Engine, or Godot?** Our [Unity](https://docs.edgegap.com/unity), [Unreal Engine](https://docs.edgegap.com/unreal-engine), and [Godot](https://docs.edgegap.com/godot) guides and plugins remain the fastest path for those engines. The MCP server works alongside them, and on its own for any engine.

Use our MCP server when:

* **Containerizing your game server** - your agent writes a Dockerfile for your build (or reviews the one you have) against best practices, pushes the image to our private container registry, and removes unused old image tags to reclaim registry capacity.
* **Deploying a dedicated server** - create and update app versions, review available locations, deploy close to your players, and get server IP with ports to test client connection.
* **Building a CI/CD pipeline** - test your deployments and teardown from a build system.
* **Troubleshooting a game server issue** - inspect app versions and deployment status, read container logs and CPU/memory utilization, or reproduce a failed deployment.
* **Running client-host and peer-to-peer games** - create relay sessions providing NAT punchthrough and avoid connection blocking. Review [Orchestration Models](https://docs.edgegap.com/learn/orchestration/deployments#orchestration) and [Dedicated Servers or Relays?](#dedicated-servers-or-relays) before deciding.

> [!WARNING]
> Out of scope / not supported by MCP: building Linux server executable; creating, starting or stopping a matchmaker (upload the generated configuration in the dashboard); server browser; lobbies; managed clusters; private fleets; or billing.

> [!NOTE]
> If you need help, [please reach out to us over Discord](https://discord.gg/MmJf8fWjnt). For live games support see our [ticketing system](https://edgegap.atlassian.net/servicedesk/customer/portal/3).

<a id="dedicated-servers-or-relays"></a>

## ⚖️ Dedicated Servers or Relays?

Edgegap can host your multiplayer game in two ways. **We recommend dedicated servers**, and so does our MCP server: your agent will default to a dedicated server and only use a relay when you've chosen a host-client setup.

|                         | Dedicated server (recommended)                   | Relay                                                     |
| ----------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| What Edgegap runs       | Your headless server build, close to players     | A traffic forwarder only, no game code                    |
| Who runs the game       | The server                                       | One player's game (the host)                              |
| Cheating                | Much harder, the server has authority            | The host can change anything                              |
| Fairness                | Every player connects directly to the server     | The host has no latency, everyone else goes through two hops |
| When the host leaves    | The match continues                              | The match ends, unless your game supports host migration  |
| Performance limited by  | The server's allocated CPU and memory            | The host's PC and home internet upload                    |
| You need                | A server build in a container image              | Netcode built as a listen server (host-client)            |

> [!NOTE]
> **No server image yet?** That's not a reason to choose relays. Your agent can write the Dockerfile for your build with `edgegap_generate_dockerfile`. Learn more about relays in [Distributed Relay](https://docs.edgegap.com/learn/distributed-relay).

## 🚀 Installation

MCP server installation is very simple:

1. Install the MCP server for [Popular Agents](#popular-agents) or with [Custom Integration](#custom-integration).
2. Generate and attach an API token for your agent to use with our MCP server.

Generate (and view) your secret tokens for Edgegap API in [Dashboard - User Settings / Tokens](https://app.edgegap.com/user-settings?tab=tokens).

Add your secret token with each API request as an HTTP header (include the word `token`):

`Authorization: token xxxxxxxx-e458-4592-b607-c2c28afd8b62`

> [!CAUTION]
> **Do not integrate Edgegap API endpoints in game client, as your API token provides unlimited access to your account. See [Integration](https://docs.edgegap.com/docs/api/integration) for secure client-facing API endpoints and functions.**

> [!TIP]
> In case your secret tokens are compromised or leaked, delete and re-create them from dashboard.

The token is organization-wide and cannot be scoped to one application. Read [DESIGN.md](DESIGN.md#where-your-token-goes) before giving it to an unattended agent.

### Popular Agents

Install Edgegap MCP server in your preferred agentic IDE with the **Cursor** or **VS Code** buttons at the top of this page, then add your token to the `Authorization` header.

#### Claude Code

```bash
claude mcp add --transport http edgegap https://mcp.edgegap.dev/mcp \
  -H "Authorization: token xxxxxxxx-e458-4592-b607-c2c28afd8b62" --scope user
```

#### ChatGPT Codex

Codex reads the token from an environment variable and sends it as `Authorization: Bearer <token>`, which the hosted endpoint accepts. In `~/.codex/config.toml`:

```toml
[mcp_servers.edgegap]
url = "https://mcp.edgegap.dev/mcp"
bearer_token_env_var = "EDGEGAP_API_TOKEN"
```

Then set `EDGEGAP_API_TOKEN` to your token in the environment Codex starts from.

#### Claude Desktop and claude.ai

Custom connectors in claude.ai and Claude Desktop cannot send an `Authorization` header, so the hosted endpoint never receives your token from them: the connector shows as connected, but every tool call fails. Use the [Local Server](#local-server) instead.

In Claude Desktop, open **Settings → Developer → Edit Config** and add the local server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "edgegap": {
      "command": "npx",
      "args": ["-y", "@edgegap/mcp"]
    }
  }
}
```

Leave the token out and you're asked for it on first use. claude.ai in the browser can't run a local server, so it can't use Edgegap MCP until the hosted endpoint supports OAuth.

#### Cursor

The **Cursor** button at the top of this page installs it; to do it by hand, add this to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "edgegap": {
      "url": "https://mcp.edgegap.dev/mcp",
      "headers": { "Authorization": "token xxxxxxxx-e458-4592-b607-c2c28afd8b62" }
    }
  }
}
```

#### VS Code (Copilot agent mode)

The **VS Code** button at the top of this page installs it; to do it by hand, add this to `.vscode/mcp.json` (VS Code uses `servers`, not `mcpServers`):

```json
{
  "servers": {
    "edgegap": {
      "type": "http",
      "url": "https://mcp.edgegap.dev/mcp",
      "headers": { "Authorization": "token xxxxxxxx-e458-4592-b607-c2c28afd8b62" }
    }
  }
}
```

#### Windsurf

In `~/.codeium/windsurf/mcp_config.json`, run the [Local Server](#local-server), which works in every client that starts MCP servers as commands:

```json
{
  "mcpServers": {
    "edgegap": {
      "command": "npx",
      "args": ["-y", "@edgegap/mcp"],
      "env": { "EDGEGAP_API_TOKEN": "xxxxxxxx-e458-4592-b607-c2c28afd8b62" }
    }
  }
}
```

#### mcp.json

Most agentic IDEs also support integration by pasting JSON configuration:

```json
{
    "mcpServers": {
        "Edgegap": {
            "type": "http",
            "url": "https://mcp.edgegap.dev/mcp",
            "headers": {
                "Authorization": "token xxxxxxxx-e458-4592-b607-c2c28afd8b62"
            }
        }
    }
}
```

### Custom Integration

Install remote Edgegap MCP server in your agent's virtualized environment (never in your project!):

**Node, using the `mcp-remote` npx package**

```json
{
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://mcp.edgegap.dev/mcp", "--transport", "http-only"]
}
```

**Python, using the `mcp-proxy` uvx package**

```json
{
  "command": "uvx",
  "args": ["mcp-proxy", "--transport", "streamablehttp", "https://mcp.edgegap.dev/mcp"]
}
```

### One-Click Install (Claude Desktop)

Download [edgegap-mcp.mcpb](https://github.com/edgegap/llm-mcp-server/releases/latest/download/edgegap-mcp.mcpb) and open it: Claude Desktop installs the local server as an extension and asks for your API token, which it keeps in the operating system's secure storage. The extension's settings also hold read-only mode, the application allowlist, the max duration ceiling and the deployment cap (the variables below). Each [release](https://github.com/edgegap/llm-mcp-server/releases) attaches the bundle, built from that release's code. Any other app that installs MCPB bundles works the same way.

### Local Server

To keep your API token on your own machine, run the server locally instead. Leave the token out and your agent asks you for it on first use, holding it in memory only for that session:

```json
{
  "mcpServers": {
    "Edgegap": {
      "command": "npx",
      "args": ["-y", "@edgegap/mcp"],
      "env": { "EDGEGAP_API_TOKEN": "xxxxxxxx-e458-4592-b607-c2c28afd8b62" }
    }
  }
}
```

Needs Node 18+. Pin a version in production (`@edgegap/mcp@0.15.1`) rather than floating on latest. Registered in the official MCP registry as `dev.edgegap/mcp`.

The local server can also limit what an agent can do. These variables have no effect on the hosted endpoint at `mcp.edgegap.dev`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `EDGEGAP_API_TOKEN` | *(prompted)* | API token. Optional: omit it and you're asked at first use. The `token ` prefix is added for you. Never pass it as a command-line argument. |
| `EDGEGAP_READ_ONLY` | `0` | Set to `1` and the tools that change something (marked ● in [Tools](#-tools)) are never registered, so the agent cannot be talked into calling them. |
| `EDGEGAP_APP_ALLOWLIST` | *(empty)* | Comma-separated application names. Limits what the agent can create and deploy into. Reading (listing apps and versions) is not limited, and neither is touching deployments once running. See [DESIGN.md](DESIGN.md#scope-of-the-allowlist). |
| `EDGEGAP_MAX_DURATION_MINUTES` | `60` | Ceiling on `max_duration` the agent may set on a version. `edgegap_deploy` also refuses a version whose `max_duration` is above it, or unlimited, unless the agent passes `allow_long_running: true` after asking you. |
| `EDGEGAP_MAX_AGENT_DEPLOYMENTS` | `5` | `edgegap_deploy` refuses while this many deployments tagged `edgegap-mcp` are running. `0` turns the cap off. |
| `EDGEGAP_MAX_DEPLOYS_PER_RUN` | `20` | Deploys one server process may send, failed ones included. Restart the server to reset it. `0` turns it off. |
| `EDGEGAP_STOP_OWN_ONLY` | `0` | Set to `1` and `edgegap_stop_deployment` only stops deployments tagged `edgegap-mcp`, so an agent cannot stop servers it did not start. |
| `EDGEGAP_ENABLE_SKILLS_UPDATE` | `0` | Set to `1` to let `edgegap_update_skills` run `npx skills@1.7.4 update` or `claude plugin update` with `apply: true`. Without it, it lists those commands for you to run. Hand-copied skills are rewritten from the bundle either way. The updaters get only path, home, temp, locale, proxy and npm settings, never `EDGEGAP_*` variables or anything named like a token, secret, password or key. |
| `EDGEGAP_TIMEOUT_MS` | `30000` | Per-request HTTP timeout. |
| `EDGEGAP_SKILLS_CHECK` | `on` | Set to `off` and the skill tools never read the latest skills version from GitHub. |

#### Windows

The local server runs on Windows with Node.js 18 or newer, and CI runs the build and the stdio tests on Windows.

- Many Windows MCP clients cannot start `npx` directly, because it is a `.cmd` script. Start it through `cmd /c`: `"command": "cmd", "args": ["/c", "npx", "-y", "@edgegap/mcp"]`. In Claude Code: `claude mcp add Edgegap --env EDGEGAP_API_TOKEN=<token> -- cmd /c npx -y @edgegap/mcp`.
- In PowerShell, type `npx.cmd` instead of `npx` to run it by hand: a new Windows install blocks the `npx` PowerShell script ("running scripts is disabled on this system").
- The first start downloads the package and can take a while; later starts are fast.
- `edgegap_update_skills` finds skills installed in `%USERPROFILE%`, the same way as on macOS and Linux.

## 📚 Skills

The server includes the [Edgegap agent skills](https://github.com/edgegap/llm-agent-skills): tested, step-by-step workflows for getting a multiplayer game online, with templates (Dockerfiles, matchmaker configs, Unity C# and Unreal C++ drop-ins) and known pitfalls. Any agent connected to Edgegap MCP gets them, with no separate install and no token needed, and is told to load the matching skill before working on a game project.

| Skill | For |
| --- | --- |
| `edgegap` | Start here for any engine other than Unity or Unreal Engine, or platform questions. Routes to the rest. |
| `edgegap-unity` | Unity end to end: server build, matchmaker, client, end-to-end test. |
| `edgegap-ngo` | Unity with Netcode for GameObjects end to end: server start and self-stop, Find Match panel, Boss Room adapter, matchmaker. |
| `edgegap-fishnet` | Unity with FishNet end to end: headless server, Bayou/WebGL, matchmaker, end-to-end test. |
| `edgegap-purrnet` | Unity with PurrNet end to end: dedicated server, connect panel, matchmaker, end-to-end test. |
| `edgegap-fusion` | Unity with Photon Fusion 2 end to end: IL2CPP Linux server, server bound to 0.0.0.0, Edgegap deployment, BR200 kit. |
| `edgegap-fusion-simplefps` | Photon's Simple FPS sample on Edgegap dedicated servers. |
| `edgegap-godot` | Godot 4 with a Godot dedicated server: headless export, ENet or WebSocket, matchmaker. |
| `edgegap-colyseus` | Colyseus servers on Edgegap, direct or through the matchmaker. |
| `edgegap-nakama` | Nakama as the backend, starting Edgegap servers for its matches. |
| `edgegap-playfab` | PlayFab Matchmaking with Edgegap servers. |
| `edgegap-threejs` | Three.js and other browser games with their own Node.js server. |
| `edgegap-matchmaking` | Matchmaking design for any engine: who owns it, profiles, parties, region selection, backfill, third-party matchmakers. |
| `edgegap-manus` | Browser games built with Manus: backend matchmaking, Steam sign-in, signed join tokens, Node WebSocket server. |
| `edgegap-unreal` | Unreal Engine end to end: source engine, Linux server, matchmaker, end-to-end test. |
| `edgegap-eos-voice` | Voice chat for an Unreal game on Edgegap with EOS Voice: server-side room tokens, match and team rooms. |
| `edgegap-server-design` | Authoritative server design and the deployment lifecycle. |
| `edgegap-containerize` | The container contract, Dockerfiles, registries, app versions. |
| `edgegap-local-testing` | Parity tests on your machine, then one smoke-test deployment. |
| `edgegap-troubleshoot` | Pull errors, crash loops, out-of-memory, clients that can't connect. |
| `edgegap-deployments-api` | Backend code that deploys servers: webhooks, cleanup, Nakama, PlayFab, UGS, EOS. |
| `edgegap-launch` | Launch checklist, rollouts, caching, cost control. |

They're served three ways, so every MCP client can reach them:

- **Tools:** `edgegap_list_skills` and `edgegap_get_skill`, which loads a skill's `SKILL.md`, or one of its reference documents or templates with `file`.
- **Prompts:** `deploy-game-server` ("Deploy my game server to Edgegap") is the place to start: it finds the engine and netcode, loads the matching skill and walks the golden path, cleanup included. There is also one prompt per skill, named after it. In Claude Code they show up as slash commands, e.g. `/mcp__edgegap__deploy-game-server`.
- **Resources:** each skill's `SKILL.md` is listed, at `edgegap-skill://<skill>/SKILL.md`; every other file is read through the `edgegap-skill://{skill}/{+path}` template, e.g. `edgegap-skill://edgegap-unity/references/deploy.md`.

Each release bundles the skills at the commit pinned in `scripts/skills-pin.txt`; `edgegap_context` reports which pack is loaded. `edgegap_list_skills` also reads the latest pack version from GitHub (one version number, cached for an hour; `EDGEGAP_SKILLS_CHECK=off` turns it off) and says when a newer one is out, and `edgegap_get_skill` adds the same note under a skill's header.

**Keeping installed skills current.** If you also installed the skills in your agent (the Claude Code plugin `edgegap@edgegap`, `npx skills add edgegap/llm-agent-skills`, or folders copied into `~/.claude/skills`), `edgegap_update_skills` compares each one with the latest on GitHub. On the local server it finds those installs itself; with `apply: true` it runs `npx skills update` (Edgegap skills only) or `claude plugin update`, and rewrites hand-copied skills from the files bundled in this release, keeping files you added and leaving symlinks and git checkouts alone. It never downloads skill text. The hosted server cannot see your disk: pass the versions you have loaded in `installed_versions` and it says which are behind and how to update them.

## 🧰 Tools

Your agent picks the right tool from your request. You don't need to name them, but knowing what's available helps you ask. Tools marked ● change something in your account, accept `dry_run`, and are hidden when `EDGEGAP_READ_ONLY=1`.

| Tool | What it does |
| --- | --- |
| `edgegap_context` | Shows which API this server talks to, its version, local or hosted, and the guardrails in force. No API call; never shows the token. |

### Before Your First Deployment

| Tool | What it does |
| --- | --- |
| `edgegap_generate_dockerfile` | Writes a Dockerfile for your server build: your build folder, server binary or start script, ports, and launch arguments, with the right headless flags (Unity `-batchmode -nographics`, Godot `--headless`), a non-root user for Unreal, and matching ports. Lists anything it had to assume so your agent can confirm it. Works for Unity, Unreal Engine, Godot, and any other engine. |
| `edgegap_validate_server_config` | Checks an existing Dockerfile, ports, resources, and image tag before you build. Catches ARM or Windows images (Edgegap runs `linux/amd64`), Unreal servers running as root, missing Unity `-batchmode -nographics`, servers bound to `localhost`, ports that don't match your netcode transport, and the `latest` tag. |
| `edgegap_get_registry_credentials` ● | Returns push credentials for your private Edgegap container registry, with the exact `docker login`, build, and push commands. Edgegap only gives these to the Unity/Unreal plugins' quick-start token; with a regular API token, it tells your agent to ask you for the login from the dashboard's **Container Registry** page instead. |
| `edgegap_list_registry_tags` | Confirms your image push landed before you register it. Takes the image name only, e.g. `my-game-server`: the project comes from your token. |
| `edgegap_delete_registry_tag` ● | Deletes one tag, and the image it points to, to clean up old builds. One exact tag per call; `latest`, wildcards and lists are refused. |

### Dedicated Servers (Recommended)

| Tool | What it does |
| --- | --- |
| `edgegap_list_apps` | Lists your applications. |
| `edgegap_create_app` ● | Creates an application. |
| `edgegap_update_app` ● | Turns an application on or off for new deployments. |
| `edgegap_list_app_versions` | Lists versions with their image, resources, ports (with TLS Upgrade), and whether a registry login is set. |
| `edgegap_get_app_version` | Reads one version in full: image, resources, ports, max duration, image caching, restart policy, and env var names (never values). |
| `edgegap_create_app_version` ● | Registers a container image as a deployable version. Supports TLS Upgrade on WS and HTTP ports, which browser (WebGL) clients need for `wss://`. |
| `edgegap_update_app_version` ● | Changes an existing version: a new image tag, on/off, CPU and memory (both together), max duration, registry login, image caching (`force_cache`), shutdown grace period, ports, env vars, and the Endpoint Storage its logs go to. Only the fields passed change, but `ports` and `env` replace the whole list. Running deployments keep the old settings. |
| `edgegap_delete_app_version` ● | Deletes one version, to clean up test versions. Refused while a deployment of it runs. The registry image is kept. |
| `edgegap_delete_app` ● | Deletes an application and its versions. Refused while any of its deployments runs, and while it has more versions than `max_versions` (default 0). |
| `edgegap_list_locations` | Lists the cities Edgegap deploys to, or, for one version, only those with capacity right now. |
| `edgegap_list_ping_beacons` | Lists the ping beacons game clients measure their latency to each region against. |
| `edgegap_deploy` ● | Deploys an authoritative dedicated server close to your players. Always tagged `edgegap-mcp`, and reports when Edgegap will stop it. Optional: CPU and memory for this deployment only, webhooks Edgegap calls when the server is ready, fails or ends, `require_cached_locations` for faster starts, and `private_host_ids` to place it on your private fleet first. |
| `edgegap_list_fleet_hosts` | Lists the hosts of one of your private fleets, with status and location, to deploy onto them. |
| `edgegap_wait_for_deployment` | Waits until the server is ready and returns the connection address. |
| `edgegap_get_deployment` | Reads a deployment's status. |
| `edgegap_list_deployments` | Lists running deployments, filtered by application, version, status, tags and more, and sorted by age. Finds servers left running; `only_agent_deployments: true` lists every one an agent started. See [Filter Deployments](https://docs.edgegap.com/learn/orchestration/deployments#filter-deployments). |
| `edgegap_get_deployment_logs` | Reads container logs and crash details while the deployment runs. After it stops, logs are only kept if Endpoint Storage was set up. |
| `edgegap_get_deployment_metrics` | Summarises CPU, CPU throttling, memory and network use (latest, average, peak), to size a version or check a crash. |
| `edgegap_stop_deployment` ● | Stops one deployment, by its exact request ID. No bulk stop. |
| `edgegap_tag_deployment` ● | Adds or removes tags on a running deployment, e.g. to mark a match. The `edgegap-mcp` tag stays. |
| `edgegap_report_deployment` ● | Reports a deployment to Edgegap with a reason, for a studio's moderation backend. It keeps running. |

### Logs and Files (Endpoint Storage)

Container logs disappear with the deployment unless they are exported to your own S3-compatible bucket.

| Tool | What it does |
| --- | --- |
| `edgegap_list_endpoint_storage` | Lists your Endpoint Storage buckets and their pull profiles. Secret keys are never returned. |
| `edgegap_create_endpoint_storage` ● | Registers a bucket (AWS S3, Cloudflare R2, DigitalOcean Spaces…) for log export. Set `endpoint_storage` on a version to turn export on. The secret key is never echoed back. |
| `edgegap_create_pull_profile` ● | Copies a file or folder from the bucket into the container at boot (maps, configs, large assets). |
| `edgegap_link_pull_profile` ● | Links a pull profile to a version, or unlinks it. |
| `edgegap_delete_pull_profile` ● | Deletes one pull profile. The bucket and its files stay. |
| `edgegap_delete_endpoint_storage` ● | Deletes one Endpoint Storage; refused while it has pull profiles unless `max_pull_profiles` allows them. The bucket and its logs stay. |

### Relays (Host-Client Games Only)

A relay is not a game server: it forwards traffic while one player's game hosts the match. See [Dedicated Servers or Relays?](#dedicated-servers-or-relays).

| Tool | What it does |
| --- | --- |
| `edgegap_create_relay_session` ● | Creates a relay session for your players and returns the relay address and each player's authorization token. |
| `edgegap_get_relay_session` | Reads a relay session. |
| `edgegap_list_relay_sessions` | Lists open relay sessions, to find ones left running. No authorization tokens. |
| `edgegap_authorize_relay_user` ● | Adds a player who joins later. |
| `edgegap_revoke_relay_user` ● | Removes one player from a relay session. |
| `edgegap_delete_relay_session` ● | Closes a relay session. |

> [!WARNING]
> Deployments and relay sessions are billed while they run. Ask your agent to stop test deployments and delete test relay sessions when it's done.

### Example Prompts

* *"Write a Dockerfile for my Unity server build, then push it and deploy a server near me."*
* *"Check my Dockerfile for Edgegap and fix any problems."*
* *"My deployment failed. Read the logs and tell me why."*
* *"How much CPU and memory did my last match use? Size my version for it."*
* *"My game uses host-client networking. Set up an Edgegap relay for two players."*

## 🛡️ Guardrails

Your API token can do anything in your organization, so the server adds its own limits around what an agent does with it. They apply in both the local server and the hosted endpoint.

| Guardrail | What it does |
| --- | --- |
| Dry run | Every tool that changes something takes `dry_run: true`: it returns the exact method, host, path and body, with the token, registry tokens and env values masked, and sends nothing. Local checks still run. |
| No token in containers | A deploy or version is refused, with nothing sent, if your API token appears in an env var name or value, a tag, or a webhook URL. Env values are never echoed back. |
| Agent tag | Every deployment gets the `edgegap-mcp` tag, even when the agent passes its own tags. `edgegap_list_deployments` with `only_agent_deployments: true` finds them all. |
| Auto-stop | Every deploy reports when Edgegap will stop it: the version's `max_duration`, capped at `EDGEGAP_MAX_DURATION_MINUTES` (default 60) for versions the agent creates. Edgegap has no per-deployment time limit, so deploying a version whose `max_duration` is above that ceiling or unlimited (a version made elsewhere defaults to 1440 minutes) is refused unless the agent passes `allow_long_running: true`, which it is told to do only after asking you. |
| Deploys per run | The local server sends at most `EDGEGAP_MAX_DEPLOYS_PER_RUN` (default 20) deploys per process, failed ones included, since a refused deploy can still create a deployment. When the API refuses a deploy but created one anyway, the error names it so the agent can stop it. |
| No moving image tags | `edgegap_create_app_version` refuses `latest` (any case), an empty tag, or a tag Docker would reject, with nothing sent: Edgegap caches images by tag, so a re-pushed tag can deploy a stale build. Deploying an existing version on `latest` is refused too, and so is asking for registry push commands for `latest`. |
| Image reference check | A `docker_image` that also holds a registry host, tag or digest (e.g. `registry.edgegap.com/proj/server:v2`) is refused, and the error gives the right `docker_repository` / `docker_image` / `docker_tag` split. `edgegap_validate_server_config` flags the same things. |
| Deployment cap | `edgegap_deploy` is refused while `EDGEGAP_MAX_AGENT_DEPLOYMENTS` (default 5) deployments tagged `edgegap-mcp` are already running, so a looping agent cannot pile up billing servers. The refusal says how to list and stop them. |
| Hidden secret env vars | Env vars whose names look like secrets (`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `CREDENTIAL`, `AUTH`…) are sent with `is_hidden`, so the dashboard does not show their values in plain text. |
| Strict stop | `edgegap_stop_deployment` stops one deployment by its exact request ID. Empty IDs, wildcards and lists are refused. There is no bulk stop. With `EDGEGAP_STOP_OWN_ONLY=1`, it only stops deployments tagged `edgegap-mcp`. |
| Careful deletes | `edgegap_delete_app_version` and `edgegap_delete_app` take one exact name, and are refused while a deployment of it is running. An application with versions is only deleted when `max_versions` covers them. |
| Webhook and bucket URLs | Deploy webhooks and Endpoint Storage endpoints must be `https` URLs without credentials, and are refused if they contain your API token. |
| Host on every result | Every result starts with the API host, e.g. `[api.edgegap.com]`, or `[custom · host]` when `EDGEGAP_BASE_URL` points elsewhere. A base URL naming `api.edgegap.com` must be exactly `https://api.edgegap.com`, or the server refuses to start. |
| Redaction | The token is stripped from every error before it reaches the agent. |

The server identifies itself with `User-Agent: edgegap-mcp/<version> (<MCP client name>)` on every API call.

**Usage analytics.** The local server and the self-hosted Docker image send nothing beyond the API calls themselves. The hosted endpoint at `mcp.edgegap.dev` uses [PostHog MCP Analytics](https://posthog.com/docs/mcp-analytics) (`@posthog/mcp`) and sends usage events to Edgegap's PostHog: which MCP client connected, which tool, prompt or skill resource was used, the names (not values) of the arguments passed, whether a call succeeded, its error code, the stage it failed at and the Edgegap API status, how long it took, whether it was a dry run, a few facts about the call (how a wait for a deployment ended, a validation result, which skill was loaded), which golden-path step was reached, plus the server version and Cloudflare's country code. On a failed call it also sends the error message, after removing your token, the values of the arguments you passed, and anything shaped like a credential, an IP address or an ID, cut to 300 characters. Deployment IDs are only sent as a keyed hash. Only named metadata properties are let through. It never sends your token, tool argument values (IP addresses, env vars, app or image names) or results, and GeoIP is off. It adds no parameters to the tools. Events from one token are grouped under a keyed, non-reversible hash of it. The full list is in [docs/analytics.md](docs/analytics.md). To opt out, send the header `X-Edgegap-Telemetry: off` (or `DNT: 1`), or use the local server.

## 🚨 Troubleshooting

Review common error codes and learn how to unlock your integration.

### 401 Unauthorized

Your MCP integration is most likely not including the Authorization header correctly.

### Tool Call Failed

Your client is missing an Edgegap token. This happens with claude.ai and Claude Desktop custom connectors, which can't send an `Authorization` header. See [Claude Desktop and claude.ai](#claude-desktop-and-claudeai) for the alternative.

> [!WARNING]
> This is a known limitation which will be resolved in the near term, stay tuned for updates!

### 403 Forbidden

Your MCP integration is likely using the template token or a deleted token. Please validate that the token value used by your integration matches exactly the token displayed in dashboard.

### 424 Image Could Not Be Pulled

Edgegap could not pull your container image. Check the repository, image name, and tag, and that the tag was pushed (ask your agent to list registry tags). For images in the Edgegap registry, the image name must include your project, e.g. `my-project/my-game-server`.

### Registry Credentials Unavailable

Edgegap only gives registry credentials to the quick-start token the Unity and Unreal plugins use, so with a regular API token your agent can't retrieve them and asks you instead. Copy the Project, Username and Token from the [dashboard](https://app.edgegap.com) under **Container Registry**, or push to another registry Edgegap can pull from (Docker Hub, GitHub, AWS ECR, GCP, GitLab). See [External Registries](https://docs.edgegap.com/docs/tools-and-integrations/docker/external-registries).

### "status": "empty" or "not_configured"

Not an error. A list with nothing in it (no applications yet, no deployments running, an image never pushed) or a feature this organization has not set up (relays, a registry this token cannot read) comes back as a normal result with `status` and a `next_step`. Your agent should do the next step instead of retrying.

### No Token Yet

The skills (`edgegap_list_skills`, `edgegap_get_skill`), `edgegap_context`, `edgegap_generate_dockerfile` and `edgegap_validate_server_config` work without a token, so an agent can prepare the server build first. Create an account at [app.edgegap.com](https://app.edgegap.com) and a token under [User Settings → Tokens](https://app.edgegap.com/user-settings?tab=tokens). `edgegap_context` with `check_token: true` says whether the session's token is present and accepted, and shows its last four characters so you can find it on that page.

### Starts Locally but Not on Edgegap

Ask your agent to validate your server configuration, or to generate a new Dockerfile. The most common causes are an image built on Apple Silicon without `docker build --platform linux/amd64`, a server listening on a different port than the version exposes, or a UDP transport configured as TCP.

### Other API Errors

Please consult our [API Reference](https://docs.edgegap.com/docs/api) for possible error responses for individual API endpoints.

> [!NOTE]
> If you need help, [please reach out to us over Discord](https://discord.gg/MmJf8fWjnt). For live games support see our [ticketing system](https://edgegap.atlassian.net/servicedesk/customer/portal/3).

## 🛠️ Self-Hosting

The hosted endpoint at `mcp.edgegap.dev` runs as a Cloudflare Worker (see [worker/INSTALL.md](worker/INSTALL.md)). To run the same stateless HTTP server on your own infrastructure, use the Docker image:

```bash
docker build -t edgegap-mcp .
docker run --rm -p 8080:8080 edgegap-mcp
```

Clients connect to `http://<host>:8080/mcp` with their own `Authorization` header, the same way they connect to the hosted endpoint. The image holds no credential, and `/health` answers without one. `PORT`, `HOST`, `EDGEGAP_READ_ONLY`, `EDGEGAP_APP_ALLOWLIST`, `EDGEGAP_MAX_DURATION_MINUTES`, `EDGEGAP_MAX_AGENT_DEPLOYMENTS` and `EDGEGAP_STOP_OWN_ONLY` apply; pass each with `-e NAME=value`. Never pass an API token to the container: each client sends its own on every request. Read [worker/DECISION.md](worker/DECISION.md) before exposing it beyond a private network.

Prebuilt images for `linux/amd64` and `linux/arm64` are published to `ghcr.io/edgegap/llm-mcp-server` (and, for existing setups, the old name `ghcr.io/edgegap/edgegap-mcp`), tagged `main` and `sha-<commit>` on every push to `main`, plus the version on `v*` tags:

```bash
docker run --rm -p 8080:8080 ghcr.io/edgegap/llm-mcp-server:main
```

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the checks a change has to pass, [CHANGELOG.md](CHANGELOG.md) for what each version changed, and [SECURITY.md](SECURITY.md) to report a vulnerability.

```bash
npm ci
npm run build
npm test                  # mock-API tests; none reach Edgegap
npm run typecheck:worker
```

To update the bundled skills to the latest commit of [llm-agent-skills](https://github.com/edgegap/llm-agent-skills), then release as usual:

```bash
npm run sync-skills -- --ref main
npm run check-skills      # exit 1 if src/skills.generated.ts differs from the pin
```

| Test | Covers |
| --- | --- |
| `test/unit.test.mjs` | Unit tests for the tag, image, secret-name, URL and redaction rules |
| `test/package.mjs` | Packaging: one `bin`, runtime dependencies, versions in step |
| `test/skills.mjs` | Skills over MCP: tools, prompts, resources, path safety, bundle matches the pin |
| `test/smoke.mjs` | Handshake, tool registration, read-only mode |
| `test/guards.mjs` | Local validation and allowlist enforcement |
| `test/elicit.mjs` | Token prompt: accept, refuse acknowledgement, decline, no support |
| `test/newtools.mjs` | Validator, Dockerfile generator, registry, deployments, relay and matchmaker tools against a local mock API |
| `test/http.mjs` | Self-hosted HTTP server: discovery without a token, per-request tokens, foreign credentials |
| `test/spec.mjs` | Every endpoint and request-body field the server sends is in `spec/` (write tools checked by dry run) |
| `test/snapshot.mjs` | Tool names, descriptions, schemas and the instructions match `test/tools.snapshot.json`; `npm run snapshot:update` after a deliberate change |
| `test/live-check.mjs` | Not in `npm test`. Runs against the real API with a token from a non-production organization |

Design decisions, the security model, and what's deliberately out of scope are in [DESIGN.md](DESIGN.md).
