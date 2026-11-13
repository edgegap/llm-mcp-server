# Contributing

Read [DESIGN.md](DESIGN.md) before you change what a tool does. It explains where the token goes, why the guardrails exist, and what is left out on purpose.

## Setup

```bash
npm ci
npm run build
npm test
npm run typecheck:worker
npm run test:worker
npm run scan
```

What each command does:
- `npm run build`: the tests run `dist/`, so build before testing.
- `npm test`: unit tests, then the MCP tests against a local mock API. Nothing reaches Edgegap.
- `npm run test:worker`: the hosted Worker under `wrangler dev`, including telemetry and OAuth mode.
- `npm run scan`: checks tracked files for secrets and local paths.

## What the checks expect

- **A test for every behavior change.** Most tool tests live in `test/newtools.mjs`, with mock routes shaped after `spec/edgegap-v1-openapi.json`. Pure rules go in `test/unit.test.mjs`.
- **Spec parity** (`test/spec.mjs`): every endpoint and body field the server sends must be in `spec/`. An unpublished one goes in its allowlist, with a comment explaining why.
- **Tool-list snapshot** (`test/snapshot.mjs`): any change to a tool's name, description, schema or annotations, or to the server instructions, fails until you run `npm run snapshot:update` and commit `test/tools.snapshot.json`. Agents build against these, so the change should be deliberate.
- **The version lives in six places.** Change it with `node <edgegap-mcp-update skill>/scripts/bump-version.mjs patch|minor`, or by hand in `package.json`, `package-lock.json`, `server.json` (twice), `src/version.ts` and the pinned install line in `README.md`. `test/package.mjs` checks they match.
- **Bundled skills.** Update them with `npm run sync-skills -- --ref main`, then update the snapshot, since the instructions name the skills.

## Pull requests

- Keep each PR to one change.
- Use a commit subject in the imperative, ending with the version, e.g. `Add edgegap_list_locations (0.7.0)`.
- Say what changes for agents and developers, and which test covers it.
- Add an entry to [CHANGELOG.md](CHANGELOG.md).

By contributing, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md) and license your work under [Apache-2.0](LICENSE).
