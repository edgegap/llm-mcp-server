// Unit tests for the pure rules the tools rely on, against the built dist/.
// The other test files drive the server end to end over MCP; these pin the
// edge cases of each rule directly. Run with: node --test test/unit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badTag, badImage, looksSecret, isEncryptedPlaceholder } from '../dist/image.js';
import { parseBaseUrl, stripTokenPrefix, redact, loadConfig, ConfigError } from '../dist/config.js';
import { maskSecrets } from '../dist/client.js';
import { argumentError } from '../dist/tools.js';
import { sanitizeErrorMessage, codeForStatus, finishReport } from '../dist/callreport.js';
import { isListable } from '../dist/skills.js';
import { z } from 'zod';

test('argumentError reads both SDK wordings and lists the parameters', () => {
  const inputs = new Map([['edgegap_deploy', { application: z.string(), version: z.string(), dry_run: z.boolean().optional() }]]);
  const v1 = 'Input validation error: Invalid arguments for tool edgegap_deploy: Invalid input: expected string, received number at application\nInvalid input: expected string, received undefined at version';
  const v2 = 'MCP error -32602: Input validation error: Invalid arguments for tool edgegap_deploy: application: Invalid input: expected string, received number, version: Invalid input: expected string, received undefined';
  for (const msg of [v1, v2]) {
    const out = argumentError(msg, inputs);
    assert.match(out, /- application: must be string \(got number\)/);
    assert.match(out, /- version: missing \(required\)/);
    assert.match(out, /Required: application, version\. Optional: dry_run\./);
  }
  assert.equal(argumentError('Something else broke', inputs), undefined);
});

test('sanitizeErrorMessage masks the token, credentials, IPs and argument values, and caps the length', () => {
  const token = '0f8b3c1e-e458-4592-b607-c2c28afd8b62';
  const text =
    `[api.edgegap.com]\nEdgegap API 400: bad token ${token} or ${token.replace(/-/g, '')}; ` +
    'password: hunter2, token=abc123, ip 203.0.113.9, jwt eyJhbGciOiJ.eyJzdWIi.sig, key ' + 'A'.repeat(40) +
    ' app my-secret-game\n\nNOTE: hosted relay notice';
  const out = sanitizeErrorMessage(text, token, { application: 'my-secret-game', users: { ip_addresses: ['198.51.100.1'] } });
  for (const leak of [token, token.replace(/-/g, ''), 'hunter2', 'abc123', '203.0.113.9', 'eyJhbGciOiJ', 'A'.repeat(40), 'my-secret-game', 'NOTE:', '[api.edgegap.com]']) {
    assert.ok(!out.includes(leak), leak);
  }
  assert.match(out, /<application>/);
  assert.ok(sanitizeErrorMessage('x'.repeat(1000)).length <= 300);
  assert.equal(sanitizeErrorMessage(''), undefined);
});

test('codeForStatus maps statuses to stable codes, per resource', () => {
  assert.equal(codeForStatus(404, 'DEPLOYMENT_NOT_FOUND'), 'DEPLOYMENT_NOT_FOUND');
  assert.equal(codeForStatus(400, 'LOGS_NOT_FOUND'), 'LOGS_NOT_FOUND');
  assert.equal(codeForStatus(400), 'UPSTREAM_REJECTED');
  assert.equal(codeForStatus(401), 'AUTH_REJECTED');
  assert.equal(codeForStatus(403, undefined, 'NO_RELAY_ACCESS'), 'NO_RELAY_ACCESS');
  assert.equal(codeForStatus(403, undefined, undefined, 'Deployment quota reached for your plan'), 'QUOTA_REACHED');
  assert.equal(codeForStatus(503), 'UPSTREAM_ERROR');
});

test('finishReport infers the stage from the API calls a failure made', () => {
  const base = { tool: 't', text: 'x', latencyMs: 1 };
  assert.equal(finishReport({ ...base, isError: true, upstream: [] }).failed_stage, 'pre_flight');
  assert.equal(finishReport({ ...base, isError: true, upstream: [200, 404] }).failed_stage, 'upstream');
  assert.equal(finishReport({ ...base, isError: true, upstream: [200] }).failed_stage, 'post_process');
  assert.equal(finishReport({ ...base, isError: true, upstream: ['timeout'] }).error_code, 'TIMEOUT');
  const ok = finishReport({ ...base, isError: false, upstream: [200], meta: { milestones: ['image_pushed', 'image_pushed'] } });
  assert.deepEqual([ok.success, ok.upstream_status, ok.milestones], [true, 200, ['image_pushed']]);
  assert.deepEqual(finishReport({ ...base, isError: true, upstream: [], meta: { milestones: ['image_pushed'] } }).milestones, []);
});

test('Unity .meta files are bundled but never listed', () => {
  assert.equal(isListable('assets/unity/EdgegapSettings.cs.meta'), false);
  assert.equal(isListable('assets/unity/EdgegapSettings.cs'), true);
});

test('badTag accepts build tags', () => {
  for (const t of ['build-42', 'v1.2.3', '2026.10.21-16.00.00', 'a', '_x', 'A'.repeat(128)]) {
    assert.equal(badTag(t), undefined, t);
  }
});

test('badTag refuses moving, empty and malformed tags', () => {
  for (const t of ['latest', 'LATEST', ' latest ', '', '   ', '.x', '-x', 'a b', 'a:b', 'a/b', 'A'.repeat(129), ' v1']) {
    assert.ok(badTag(t), JSON.stringify(t));
  }
});

test('badImage accepts image paths', () => {
  for (const i of ['me/srv', 'my-org-abc123/my-game-server', 'srv', 'team/nested/server']) {
    assert.equal(badImage('registry.edgegap.com', i), undefined, i);
  }
});

test('badImage refuses a host, tag or digest inside docker_image, with the split', () => {
  const msg = badImage('docker.io', 'registry.edgegap.com/proj/srv:v2');
  assert.match(msg, /docker_repository "registry\.edgegap\.com", docker_image "proj\/srv", docker_tag "v2"/);
  assert.match(badImage('docker.io', 'me/srv:v1'), /docker_repository "docker\.io", docker_image "me\/srv", docker_tag "v1"/);
  assert.ok(badImage('', 'localhost:5000/srv'));
  assert.match(badImage('docker.io', 'me/srv@sha256:abc'), /docker_tag "<build-id>"/);
  assert.ok(badImage('docker.io', ''));
});

test('looksSecret flags secret-like env names only', () => {
  for (const n of ['API_KEY', 'apikey', 'STEAM_API_KEY', 'JWT_SECRET', 'db_password', 'GITHUB_TOKEN', 'AWS_ACCESS_KEY_ID', 'PRIVATE_KEY', 'AUTH_HEADER', 'CREDENTIALS']) {
    assert.equal(looksSecret(n), true, n);
  }
  for (const n of ['GAME_MODE', 'MATCH_ID', 'PORT', 'MAX_PLAYERS', 'REGION']) {
    assert.equal(looksSecret(n), false, n);
  }
});

test('isEncryptedPlaceholder matches only the API placeholder for a stored secret', () => {
  for (const v of ['This value is set and encrypted', ' this value is set and encrypted\n']) assert.equal(isEncryptedPlaceholder(v), true, v);
  for (const v of ['robot$my-org', '', undefined, null, 'This value is set and encrypted!', 'note: This value is set and encrypted']) {
    assert.equal(isEncryptedPlaceholder(v), false, String(v));
  }
});

test('parseBaseUrl keeps the production URL strict', () => {
  assert.equal(parseBaseUrl(undefined), 'https://api.edgegap.com');
  assert.equal(parseBaseUrl('https://api.edgegap.com/'), 'https://api.edgegap.com');
  assert.equal(parseBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  for (const bad of ['http://api.edgegap.com', 'https://api.edgegap.com:8443', 'https://u:p@example.com', 'ftp://x', 'not a url']) {
    assert.throws(() => parseBaseUrl(bad), ConfigError, bad);
  }
});

test('stripTokenPrefix removes any number of "token"/"Bearer" prefixes', () => {
  const t = '0f8b3c1e-e458-4592-b607-c2c28afd8b62';
  for (const v of [t, `token ${t}`, `token token ${t}`, `Bearer ${t}`, `Bearer token ${t}`, `  TOKEN   ${t}  `]) {
    assert.equal(stripTokenPrefix(v), t, v);
  }
});

test('redact removes every occurrence and leaves text without a token alone', () => {
  assert.equal(redact('a TOK b TOK', 'TOK'), 'a <redacted-token> b <redacted-token>');
  assert.equal(redact('nothing here', 'TOK'), 'nothing here');
  assert.equal(redact('x', undefined), 'x');
});

test('maskSecrets masks secret keys, env values and the API token, deeply', () => {
  const out = maskSecrets(
    { private_token: 'p', envs: [{ key: 'MODE', value: 'v' }], nested: { note: 'has TOKEN123 inside' }, keep: 'k' },
    'TOKEN123'
  );
  assert.deepEqual(out, { private_token: '***', envs: [{ key: 'MODE', value: '***' }], nested: { note: 'has *** inside' }, keep: 'k' });
});

test('loadConfig defaults and parses the guardrail settings', () => {
  const d = loadConfig({});
  assert.equal(d.maxDurationCeiling, 60);
  assert.equal(d.maxAgentDeployments, 5);
  assert.equal(d.readOnly, false);
  const c = loadConfig({ EDGEGAP_MAX_AGENT_DEPLOYMENTS: '0', EDGEGAP_READ_ONLY: 'true', EDGEGAP_APP_ALLOWLIST: ' a, b ,,' });
  assert.equal(c.maxAgentDeployments, 0);
  assert.equal(c.readOnly, true);
  assert.deepEqual(c.appAllowlist, ['a', 'b']);
});
