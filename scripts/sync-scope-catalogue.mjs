// Writes spec/scope-catalogue.json from the Edgegap API's catalogue export:
// every OAuth scope with its versions and the permissions each version grants,
// and every API route that requires a permission. test/scope-contract.test.mjs
// checks the hosted Worker's tool-to-scope table against it.
//
//   npm run sync-scope-catalogue -- <path to the API's catalogue export>
//
// Keeps only what the contract test reads: scopes as they are, and each
// route's method, path and permission. Routes are matched by method and path
// alone, so two routes with the same method and path must require the same
// permission; the script stops if they don't.
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = new URL('../spec/scope-catalogue.json', import.meta.url);

const source = process.argv[2];
if (!source) {
  console.error('Usage: npm run sync-scope-catalogue -- <path to the catalogue export>');
  process.exit(1);
}

const exported = JSON.parse(readFileSync(source, 'utf8'));
const problems = [];

const scopes = {};
for (const [name, scope] of Object.entries(exported.scopes ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
  const versions = {};
  for (const [version, permissions] of Object.entries(scope.versions ?? {})) {
    if (!Array.isArray(permissions) || !permissions.every((p) => typeof p === 'string')) {
      problems.push(`scope ${name} version ${version}: permissions must be a list of names`);
      continue;
    }
    versions[version] = [...permissions].sort();
  }
  if (!Number.isInteger(scope.current_version) || !versions[String(scope.current_version)]) {
    problems.push(`scope ${name}: current_version ${scope.current_version} has no permission list`);
  }
  scopes[name] = { current_version: scope.current_version, versions };
}
if (Object.keys(scopes).length === 0) problems.push('no scopes');

const routes = new Map();
for (const route of exported.routes ?? []) {
  const { method, path, permission } = route;
  if (![method, path, permission].every((v) => typeof v === 'string' && v)) {
    problems.push(`route ${JSON.stringify(route)}: needs method, path and permission`);
    continue;
  }
  const key = `${method} ${path}`;
  const known = routes.get(key);
  if (known && known.permission !== permission) {
    problems.push(`${key}: requires both ${known.permission} and ${permission}`);
    continue;
  }
  routes.set(key, { method, path, permission });
}
if (routes.size === 0) problems.push('no routes');

if (problems.length > 0) {
  console.error(`${source} can't be used:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

const sorted = [...routes.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
writeFileSync(OUT, JSON.stringify({ scopes, routes: sorted }, null, 2) + '\n');
console.log(`Wrote spec/scope-catalogue.json: ${Object.keys(scopes).length} scopes, ${sorted.length} routes.`);
