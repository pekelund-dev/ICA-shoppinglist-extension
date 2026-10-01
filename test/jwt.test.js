import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeJwtPayload, extractBearerToken, getTokenExpiry, isTokenExpired } from '../src/lib/jwt.js';

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const makeToken = (payload) => `${encode({ alg: 'none' })}.${encode(payload)}.sig`;

test('extracts bearer tokens from request headers', () => {
  const token = makeToken({ sub: 'user' });
  const scheme = 'Bearer';
  assert.equal(extractBearerToken([{ name: 'Accept', value: '*/*' }, { name: 'authorization', value: `${scheme} ${token}` }]), token);
  assert.equal(extractBearerToken([{ name: 'Authorization', value: 'Bearer opaque-access-token' }]), 'opaque-access-token');
  assert.equal(extractBearerToken([{ name: 'Authorization', value: 'Basic abc' }]), null);
  assert.equal(extractBearerToken([{ name: 'Authorization', value: 'Bearer' }]), null);
  assert.equal(extractBearerToken(undefined), null);
});

test('decodes payload and expiry', () => {
  const token = makeToken({ sub: 'åäö', exp: 2_000_000_000 });
  assert.equal(decodeJwtPayload(token).sub, 'åäö');
  assert.equal(getTokenExpiry(token), 2_000_000_000_000);
  assert.equal(decodeJwtPayload('a.b'), null);
});

test('detects expired tokens', () => {
  const token = makeToken({ exp: 1000 });
  assert.equal(isTokenExpired(token, 999_000), true);
  assert.equal(isTokenExpired(token, 900_000), false);
  assert.equal(isTokenExpired(makeToken({}), Date.now()), false);
});
