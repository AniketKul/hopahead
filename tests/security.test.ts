import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, readSession, validateSettings, checkOrigin } from '../src/server/security.js';
const secret = 'test-secret-that-is-at-least-thirty-two-characters';
test('session signatures reject tampering and expiry', () => {
  const token = signSession('4f9e646d-c828-442a-86c6-430b6e270414', 2000, secret);
  assert.equal(readSession(`hop_session=${token}`, secret, 1000), '4f9e646d-c828-442a-86c6-430b6e270414');
  assert.equal(readSession(`hop_session=${token.replace('4f9', '5f9')}`, secret, 1000), null);
  assert.equal(readSession(`hop_session=${token}`, secret, 2001), null);
  assert.equal(readSession('hop_session=%invalid', secret, 1000), null);
});
test('settings validate every trust-boundary field', () => {
  const valid = { incomingTripId: 'Red-123', preferredOutgoingTripId: null, extraTransferSeconds: 120, boarded: false };
  assert.deepEqual(validateSettings(valid), valid);
  for (const value of [null, {}, { ...valid, extraTransferSeconds: -1 }, { ...valid, extraTransferSeconds: 0.1 }, { ...valid, extraTransferSeconds: 1801 }, { ...valid, boarded: 'true' }, { ...valid, incomingTripId: '<script>' }]) {
    assert.throws(() => validateSettings(value));
  }
});
test('mutations reject foreign and missing origins', () => {
  assert.doesNotThrow(() => checkOrigin('http://localhost:3000', 'http://localhost:3000'));
  assert.throws(() => checkOrigin('https://evil.example', 'http://localhost:3000'));
  assert.throws(() => checkOrigin(undefined, 'http://localhost:3000'));
});
