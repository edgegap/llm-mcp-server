# Security Policy

This server handles Edgegap API tokens, which are organization-wide. Please report anything that could expose a token, act outside a guardrail, or reach an organization other than the caller's.

## Reporting a vulnerability

Report it privately through GitHub: on this repository's **Security** tab, choose **Report a vulnerability**. Please don't open a public issue for a security problem.

Include what you ran, which surface it affects (the npm package, the Docker image, or the hosted endpoint at `mcp.edgegap.com`), and the version. `edgegap_context` reports the version.

## Supported versions

Only the latest published version gets fixes. The hosted endpoint always runs the latest version.

## Scope

**In scope:**
- The token leaking into a tool result, log or request it wasn't meant for.
- A guardrail being bypassed: read-only mode, the app allowlist, the token-in-container refusal, strict stop, the deployment cap, or image tag checks.
- The hosted endpoint relaying a request with someone else's token, or storing a token.

**Out of scope:** the Edgegap platform and API themselves. Report those to Edgegap directly.

How the token is handled is described in [DESIGN.md](DESIGN.md).
