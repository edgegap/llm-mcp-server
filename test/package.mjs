// Packaging checks: the things that broke installs without breaking any tool.
//
// 0.3.0 shipped two `bin` commands, neither named `mcp`, so `npx -y
// @edgegap/mcp` (the config in the README and every client that copied it)
// failed with "could not determine executable to run". No tool test caught it
// because they all run dist/index.js directly.
import { readFileSync } from 'node:fs';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const server = JSON.parse(readFileSync('server.json', 'utf8'));

console.log('\npackage');

// npm's rule (get-bin-from-manifest): run the only command; otherwise the one
// named like the package minus its scope; otherwise fail.
const bins = typeof pkg.bin === 'string' ? [pkg.name.split('/').pop()] : Object.keys(pkg.bin ?? {});
const unscoped = pkg.name.split('/').pop();
check(
  `npx ${pkg.name} resolves to a command`,
  bins.length === 1 || bins.includes(unscoped),
  `bin has ${bins.length} commands (${bins.join(', ')}) and none is named "${unscoped}"`
);
check('the command runs the stdio server', pkg.bin?.['edgegap-mcp'] === 'dist/index.js', JSON.stringify(pkg.bin));

// Everything in dependencies is installed by every `npx @edgegap/mcp`. The
// Cloudflare Worker's packages pulled in Babel 8, whose engines (^22.18 ||
// >=24.11) printed a dozen EBADENGINE warnings on Node 22.15.
for (const workerOnly of ['agents', '@modelcontextprotocol/server', 'wrangler', '@posthog/mcp', 'posthog-node']) {
  check(`${workerOnly} is not a runtime dependency`, !(workerOnly in (pkg.dependencies ?? {})));
}
// The repository was renamed from edgegap/edgegap-mcp. GitHub redirects the
// old name, but npm and the MCP registry show whatever is published.
check('repository field set, so npm links to the source', /github\.com\/edgegap\/llm-mcp-server\.git$/.test(pkg.repository?.url ?? ''), pkg.repository?.url);
check('homepage and bugs use the current repository name', [pkg.homepage, pkg.bugs?.url].every((u) => /github\.com\/edgegap\/llm-mcp-server\b/.test(u ?? '')));
// The registry and directories show this icon; the same file is the one-click bundle's.
check('server.json has an https icon that is the repo icon.png', server.icons?.[0]?.src === 'https://raw.githubusercontent.com/edgegap/llm-mcp-server/main/icon.png' && server.icons[0].mimeType === 'image/png', JSON.stringify(server.icons));
check('server.json names the current repository', server.repository?.url === 'https://github.com/edgegap/llm-mcp-server', server.repository?.url);
check('mcpName matches the registry name', pkg.mcpName === server.name, `${pkg.mcpName} vs ${server.name}`);

// The version is hardcoded in five places; a release with them out of step
// tells clients one version and npm another.
const v = pkg.version;
check(`server.json version is ${v}`, server.version === v, server.version);
check(`server.json npm package version is ${v}`, server.packages?.[0]?.version === v, server.packages?.[0]?.version);
const declared = readFileSync('src/version.ts', 'utf8').match(/VERSION = '([^']+)'/)?.[1];
check(`src/version.ts is ${v}`, declared === v, declared ?? 'no VERSION found');
// Every entry point reports VERSION rather than its own copy of the number.
for (const file of ['src/index.ts', 'src/http.ts', 'worker/worker.ts']) {
  const src = readFileSync(file, 'utf8');
  check(`${file} reports VERSION, not a hardcoded number`, /name: 'edgegap', version: VERSION/.test(src) && !/version: '\d+\.\d+\.\d+'/.test(src));
}

// The one-click bundle (manifest.json) names the version and the tools too.
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
check(`manifest.json version is ${v}`, manifest.version === v, manifest.version);
const snapshot = JSON.parse(readFileSync('test/tools.snapshot.json', 'utf8'));
const listed = manifest.tools.map((t) => t.name).sort().join(',');
const registered = snapshot.normal.tools.map((t) => t.name).sort().join(',');
check('manifest.json lists exactly the registered tools', listed === registered, `${listed} vs ${registered}`);
check('manifest.json runs dist/index.js with the token from its settings', manifest.server?.entry_point === 'dist/index.js' && manifest.server.mcp_config.env.EDGEGAP_API_TOKEN === '${user_config.api_token}' && manifest.user_config.api_token.sensitive === true);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
