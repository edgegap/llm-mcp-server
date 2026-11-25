// Contract between the hosted Worker's tool-to-scope table (src/oauth.ts) and
// the Edgegap API's scope catalogue (spec/scope-catalogue.json): every API
// route a tool can call requires a permission that the tool's scopes grant,
// at the scopes' current versions in the catalogue, so a signed-in tool call
// never reaches the API with a token the API refuses.
//
// The routes each tool calls come from the code, not from a table:
// - each EdgegapClient method is called on a dry-run client, which records
//   the method and path it would send;
// - src/tools.ts is scanned for the client methods each tool's handler calls,
//   directly or through the helper functions it calls.
//
// spec/scope-catalogue.json is generated from the API's catalogue export:
//   npm run sync-scope-catalogue -- <path to the catalogue export>
// Refresh it whenever the API's scopes or route permissions change.
//
// Run with: node --test test/scope-contract.test.mjs (after npm run build)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EdgegapClient } from '../dist/client.js';
import {
  JwksCache,
  MEMBER_DEFAULT_SCOPES,
  OAuthTokenSource,
  gate,
  loadOAuthSettings,
  protectedResourceMetadata,
  securitySchemes,
  toolNeed,
  toolScopes,
} from '../dist/oauth.js';

const catalogue = JSON.parse(readFileSync(new URL('../spec/scope-catalogue.json', import.meta.url), 'utf8'));
const SNAPSHOT_TOOLS = JSON.parse(readFileSync(new URL('./tools.snapshot.json', import.meta.url), 'utf8')).normal.tools.map((t) => t.name);
const TOOLS_SRC = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8');

// No-account tools that call the API only outside OAuth mode. Each needs the
// reason, and its routes must have no permission in the catalogue: an OAuth
// token could not call them anyway.
const TOKEN_MODE_ONLY = {
  edgegap_get_registry_credentials: 'in OAuth mode it answers the dashboard steps without calling the API',
};

// ------------------------------------------------------------ catalogue ----

/** "GET /v1/app/{}" for a catalogue route ("<app_name>") or a recorded one (PARAM). */
const PARAM = '__param__';
const routeKey = (method, path) => `${method} ${path.replace(/<[^>]+>/g, '{}').replaceAll(PARAM, '{}')}`;

const routePermission = new Map(catalogue.routes.map((r) => [routeKey(r.method, r.path), r.permission]));

/** The permissions `scope` grants at its current version, or undefined for a scope the catalogue lacks. */
function scopePermissions(scope) {
  const entry = catalogue.scopes[scope];
  return entry ? entry.versions[String(entry.current_version)] : undefined;
}

/** What a token holding `scopes` holds: the authorization server issues each `*:write` with its `*:read`. */
const withReads = (scopes) => [...new Set(scopes.flatMap((s) => (s.endsWith(':write') ? [s, s.replace(/:write$/, ':read')] : [s])))].sort();

// ------------------------------------------------------ client: routes ----

// EdgegapClient members that send no request of their own.
const NOT_API = new Set(['constructor', 'dryRun', 'userAgent', 'request', 'send']);
// Arguments for the methods whose first argument isn't a name in the path.
const SPECIAL_ARGS = {
  linkPullProfile: [['PUT', PARAM, PARAM, PARAM, PARAM], ['DELETE', PARAM, PARAM, PARAM, PARAM]],
};

/** Each client method's routes, recorded by calling it on a dry-run client with placeholder names. */
async function clientRoutes() {
  const config = { baseUrlV1: 'https://api.example.test', baseUrlV2: 'https://api.example.test/v2', credential: 'oauth' };
  const auth = new OAuthTokenSource(undefined);
  const routes = new Map();
  for (const name of Object.getOwnPropertyNames(EdgegapClient.prototype)) {
    if (NOT_API.has(name) || typeof EdgegapClient.prototype[name] !== 'function') continue;
    const { client, requests } = new EdgegapClient(config, auth).dryRun();
    const fn = client[name];
    for (const args of SPECIAL_ARGS[name] ?? [Array(Math.max(fn.length, 1)).fill(PARAM)]) await fn.apply(client, args);
    routes.set(name, [...new Set(requests.map((r) => routeKey(r.method, r.path.split('?')[0])))]);
  }
  return routes;
}

// ---------------------------------------------------- tools: client calls ----

/**
 * `src` with comments and the text of string, template and regex literals
 * blanked to spaces (offsets kept; a template's ${...} stays code), so
 * brackets can be matched and names found without reading text as code.
 */
function codeOnly(src) {
  const out = src.split('');
  const blank = (i) => {
    if (out[i] !== '\n') out[i] = ' ';
  };
  const REGEX_AFTER = new Set([...'(,=:[!&|?{};+-*%<>~^', '', 'return', 'typeof', 'case', 'in', 'of', 'else', 'void', 'delete', 'throw', 'new', 'await', 'yield']);
  const templates = []; // brace depth at each open ${
  let depth = 0;
  let prev = '';
  let i = 0;
  const inTemplate = () => {
    // From just after a backtick or a template's closing }, to the closing backtick or the next ${.
    while (i < src.length) {
      if (src[i] === '\\') {
        blank(i++);
        blank(i++);
      } else if (src[i] === '`') {
        blank(i++);
        return;
      } else if (src[i] === '$' && src[i + 1] === '{') {
        blank(i);
        i += 2;
        templates.push(depth++);
        return;
      } else blank(i++);
    }
  };
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') blank(i++);
    } else if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      while (i < stop) blank(i++);
    } else if (ch === "'" || ch === '"') {
      blank(i++);
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\') blank(i++);
        blank(i++);
      }
      blank(i++);
      prev = 'x';
    } else if (ch === '`') {
      blank(i++);
      inTemplate();
      prev = 'x';
    } else if (ch === '/' && REGEX_AFTER.has(prev)) {
      blank(i++);
      let inClass = false;
      while (i < src.length && (inClass || src[i] !== '/')) {
        if (src[i] === '\\') blank(i++);
        else if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        blank(i++);
      }
      blank(i++);
      while (/\w/.test(src[i] ?? '')) blank(i++);
      prev = 'x';
    } else if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      while (/[\w$]/.test(src[i] ?? '')) i++;
      prev = src.slice(start, i);
    } else {
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (templates.length > 0 && templates.at(-1) === depth) {
          templates.pop();
          i++;
          inTemplate();
          prev = 'x';
          continue;
        }
      }
      if (!/\s/.test(ch)) prev = ch;
      i++;
    }
  }
  return out.join('');
}

/** The index of the bracket closing the one at `open`, in code-only text. */
function closing(code, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let i = open; i < code.length; i++) {
    if (pairs[code[i]]) stack.push(pairs[code[i]]);
    else if (code[i] === ')' || code[i] === '}' || code[i] === ']') {
      assert.equal(code[i], stack.pop(), `unbalanced ${code[i]} at offset ${i} of src/tools.ts`);
      if (stack.length === 0) return i;
    }
  }
  assert.fail(`no closing bracket for offset ${open} of src/tools.ts`);
}

/** The body of the function whose parameter list opens at `paren`: the first block after it that isn't a return type. */
function functionBody(code, paren) {
  let i = closing(code, paren) + 1;
  for (;;) {
    const brace = code.indexOf('{', i);
    const before = code.slice(i, brace).trimEnd().at(-1);
    if (before === undefined || !':<|&,'.includes(before)) return [brace, closing(code, brace)];
    i = closing(code, brace) + 1;
  }
}

/**
 * Each tool's client methods, from src/tools.ts: the methods called inside
 * its tool(...) registration, plus those of every function it calls by name,
 * transitively. Also every client call site no tool reaches, which would
 * mean this scan missed a path.
 */
function toolClientMethods(clientMethods) {
  const code = codeOnly(TOOLS_SRC);
  const tools = new Map(); // tool -> [start, end]
  for (const m of TOOLS_SRC.matchAll(/\btool\(\s*'(edgegap_\w+)'/g)) {
    if (code[m.index] !== 't') continue;
    const paren = m.index + m[0].indexOf('(');
    tools.set(m[1], [paren, closing(code, paren)]);
  }
  const functions = new Map(); // name -> [[start, end], ...]
  for (const m of code.matchAll(/\bfunction\s+(\w+)\s*\(/g)) {
    const [start, end] = functionBody(code, m.index + m[0].length - 1);
    functions.set(m[1], [...(functions.get(m[1]) ?? []), [start, end]]);
  }

  const refs = (start, end) => {
    const text = code.slice(start, end);
    const methods = new Set([...text.matchAll(/\.\s*(\w+)\s*\(/g)].map((m) => m[1]).filter((n) => clientMethods.has(n)));
    const calls = new Set([...text.matchAll(/(?<![.\w$])(\w+)\s*\(/g)].map((m) => m[1]).filter((n) => functions.has(n)));
    return { methods, calls };
  };
  const reach = (start, end, seen = new Set()) => {
    const { methods, calls } = refs(start, end);
    for (const name of calls) {
      if (seen.has(name)) continue;
      seen.add(name);
      for (const [s, e] of functions.get(name)) for (const method of reach(s, e, seen).methods) methods.add(method);
    }
    return { methods, seen };
  };

  const result = new Map();
  const reachedRanges = [];
  for (const [tool, [start, end]] of tools) {
    const { methods, seen } = reach(start, end);
    result.set(tool, methods);
    reachedRanges.push([start, end], ...[...seen].flatMap((n) => functions.get(n)));
  }
  const unreached = [...code.matchAll(/\.\s*(\w+)\s*\(/g)]
    .filter((m) => clientMethods.has(m[1]) && !reachedRanges.some(([s, e]) => m.index > s && m.index < e))
    .map((m) => `${m[1]} (src/tools.ts line ${TOOLS_SRC.slice(0, m.index).split('\n').length})`);
  return { tools: result, unreached };
}

// ------------------------------------------------------------- the data ----

const CLIENT_ROUTES = await clientRoutes();
const { tools: TOOL_METHODS, unreached: UNREACHED_CALLS } = toolClientMethods(new Set(CLIENT_ROUTES.keys()));

/** Every route a tool's code can call. */
const toolRoutes = (tool) => [...new Set([...TOOL_METHODS.get(tool)].flatMap((m) => CLIENT_ROUTES.get(m)))].sort();
const describe = (route) => (routePermission.has(route) ? `${route} (${routePermission.get(route)})` : `${route} (no permission)`);

// --------------------------------------------------------------- checks ----

test('the scan sees every tool and every client method', () => {
  assert.deepEqual([...TOOL_METHODS.keys()].sort(), [...SNAPSHOT_TOOLS].sort(), 'tools registered in src/tools.ts vs test/tools.snapshot.json');
  for (const [method, routes] of CLIENT_ROUTES) {
    assert.ok(routes.length > 0, `EdgegapClient.${method} recorded no request: add it to NOT_API or SPECIAL_ARGS`);
    for (const route of routes) assert.match(route, /^(GET|POST|PUT|PATCH|DELETE) \/v[12]\//, `EdgegapClient.${method}: ${route}`);
  }
  const used = new Set([...TOOL_METHODS.values()].flatMap((m) => [...m]));
  assert.deepEqual([...CLIENT_ROUTES.keys()].filter((m) => !used.has(m)), [], 'client methods no tool calls');
  assert.deepEqual(UNREACHED_CALLS, [], 'client calls outside every tool and the functions tools call');
});

test('the catalogue is usable: each scope has its current version, each *:write has its *:read', () => {
  for (const [scope, entry] of Object.entries(catalogue.scopes)) {
    assert.ok(Array.isArray(scopePermissions(scope)), `${scope}: no permissions at current version ${entry.current_version}`);
    if (scope.endsWith(':write')) assert.ok(scopePermissions(scope.replace(/:write$/, ':read')), `${scope} has no matching :read scope`);
  }
});

test('every scope the Worker names is in the catalogue', async () => {
  const settings = loadOAuthSettings({
    OAUTH_MODE: '1',
    OAUTH_ISSUER: 'https://auth.example.test',
    OAUTH_JWKS_URL: 'https://auth.example.test/jwks.json',
    MCP_RESOURCE_URL: 'https://mcp.example.test/mcp',
  });
  const jwks = new JwksCache(settings.jwksUrl, { fetch: () => assert.fail('a signed-out request fetched the JWKS') });
  const named = new Map(); // scope -> where the Worker names it
  const note = (scopes, where) => {
    for (const s of scopes) named.set(s, [...(named.get(s) ?? []), where]);
  };

  note(MEMBER_DEFAULT_SCOPES, 'the member default');
  note(protectedResourceMetadata(settings).scopes_supported, 'the metadata scopes_supported');
  for (const tool of SNAPSHOT_TOOLS) {
    const scopes = toolScopes(tool);
    if (scopes === undefined) continue;
    note(withReads(scopes), `${tool}'s scopes`);
    for (const scheme of securitySchemes(tool)) if (scheme.type === 'oauth2') note(scheme.scopes, `${tool}'s securitySchemes`);
    if (toolNeed(tool)?.kind !== 'scopes') continue;
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: {} } };
    const decision = await gate({ method: 'POST', authorization: null, origin: null, body }, settings, jwks);
    assert.equal(decision.status, 401, tool);
    note(decision.challenge.match(/scope="([^"]*)"/)[1].split(' '), `${tool}'s 401`);
  }

  const places = (where) => where.slice(0, 3).join(', ') + (where.length > 3 ? ` and ${where.length - 3} more` : '');
  const unknown = [...named].filter(([scope]) => !scopePermissions(scope)).map(([scope, where]) => `${scope} (${places(where)})`);
  assert.deepEqual(unknown, [], 'scopes the catalogue does not have');
});

test('every route a signed-in tool calls requires a permission its scopes grant', () => {
  const problems = [];
  for (const tool of SNAPSHOT_TOOLS) {
    const scopes = toolScopes(tool);
    if (!scopes || scopes.length === 0) continue;
    const held = withReads(scopes);
    const granted = new Set(held.flatMap((s) => scopePermissions(s) ?? []));
    for (const route of toolRoutes(tool)) {
      const permission = routePermission.get(route);
      if (permission === undefined) {
        problems.push(`${tool} calls ${route}, which requires no permission, so no OAuth token can call it: hide the tool in OAuth mode`);
      } else if (!granted.has(permission)) {
        problems.push(`${tool} calls ${route}, which requires ${permission}; its scopes (${held.join(' ')}) don't grant it`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('no-account tools call no route that needs a sign-in', () => {
  const problems = [];
  for (const tool of SNAPSHOT_TOOLS) {
    if (toolScopes(tool)?.length !== 0) continue;
    const routes = toolRoutes(tool);
    if (Object.hasOwn(TOKEN_MODE_ONLY, tool)) {
      assert.ok(routes.length > 0, `${tool} calls no API route now: drop it from TOKEN_MODE_ONLY`);
      for (const route of routes.filter((r) => routePermission.has(r))) {
        problems.push(`${tool} calls ${describe(route)}, which OAuth tokens can now call: give the tool its scope`);
      }
    } else {
      for (const route of routes) problems.push(`${tool} needs no sign-in but calls ${describe(route)}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('each tool hidden in OAuth mode calls a route no OAuth token can call', () => {
  const hidden = SNAPSHOT_TOOLS.filter((t) => toolScopes(t) === undefined);
  assert.ok(hidden.length > 0);
  const problems = hidden
    .filter((tool) => toolRoutes(tool).every((r) => routePermission.has(r)))
    .map((tool) => `${tool}: every route it calls requires a permission now (${toolRoutes(tool).map(describe).join(', ')}): add it to TOOL_SCOPES`);
  assert.deepEqual(problems, []);
});
