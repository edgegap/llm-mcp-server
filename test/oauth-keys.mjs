// Test signing keys and access tokens for the OAuth tests (test/oauth.test.mjs,
// test/worker-oauth.mjs). Each key is generated when the test runs; tokens
// are RS256 JWTs shaped like the ones Edgegap's authorization server issues
// (RFC 9068: typ at+jwt, kid, iss, aud, org, sub, scope, exp).
import { webcrypto as crypto } from 'node:crypto';

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const encode = (value) => b64url(new TextEncoder().encode(JSON.stringify(value)));

/** A fresh RS256 key pair, with its public JWK as a JWKS entry under `kid`. */
export async function signingKey(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const { n, e } = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kty: 'RSA', alg: 'RS256', use: 'sig', kid, n, e } };
}

/**
 * Signs a token with `key`. `header` and `claims` override the defaults, and a
 * value of undefined removes that field.
 */
export async function accessToken(key, claims = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = strip({ alg: 'RS256', typ: 'at+jwt', kid: key.kid, ...header });
  const c = strip({ jti: crypto.randomUUID(), iat: now, exp: now + 600, ...claims });
  const signed = `${encode(h)}.${encode(c)}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(signed));
  return `${signed}.${b64url(new Uint8Array(signature))}`;
}

function strip(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
}
