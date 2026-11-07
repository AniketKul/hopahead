import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureEvidence, evaluate } from '../src/domain/advice.js';
import { scenarios } from '../src/fixtures/scenarios.js';

const expected: Record<string, string[]> = {
  delay: ['enough_time', 'tight', 'tight', 'insufficient_time'],
  cancellation: ['enough_time', 'unavailable', 'unavailable', 'enough_time'],
  disappearance: ['enough_time', 'unknown', 'enough_time', 'unknown', 'enough_time'],
  stale: ['enough_time', 'enough_time', 'stale', 'stale', 'enough_time'],
  recovery: ['enough_time', 'unavailable', 'unknown', 'unknown', 'enough_time']
};

test('named simulated scenarios exhibit their advertised state transitions', () => {
  assert.deepEqual(scenarios.map(s => s.id).sort(), Object.keys(expected).sort());
  for (const scenario of scenarios) {
    assert.deepEqual(scenario.frames.map(frame => evaluate(frame.input).status), expected[scenario.id], scenario.id);
    assert.ok(scenario.description.length > 10);
    for (const { input } of scenario.frames) {
      assert.match(input.settings.incomingTripId, /^demo-/);
      assert.match(input.transit.predictionHealth!.topic, /^simulation\./);
      assert.equal(input.transfers.version, 'demo-transfer-v1:152-184');
    }
  }
});
test('scrubbing backward reproduces exact advice and does not mutate captured frames', () => {
  assert.ok(scenarios.length > 0);
  const original = structuredClone(scenarios);
  for (const scenario of scenarios) {
    const forward = scenario.frames.map(frame => evaluate(frame.input));
    const backward = [...scenario.frames].reverse().map(frame => evaluate(frame.input)).reverse();
    assert.deepEqual(backward, forward);
  }
  assert.deepEqual(scenarios, original);
});

test('compact evidence reproduces every scenario without unrelated citywide records', () => {
  for (const scenario of scenarios) for (const frame of scenario.frames) {
    const input = structuredClone(frame.input);
    input.transit.predictions.push(...Array.from({ length: 1000 }, (_, i) => ({ ...input.transit.predictions[0], id: `unrelated-${i}`, tripId: `unrelated-${i}`, routeId: '1', stopId: '1' })));
    const advice = evaluate(input);
    const evidence = captureEvidence(input, advice);
    assert.ok(evidence.transit.predictions.length <= 8);
    assert.deepEqual(evaluate(evidence), advice, `${scenario.id}: ${frame.label}`);
    assert.deepEqual(evidence.transfers, input.transfers);
    assert.equal(evidence.evaluatedAt, input.evaluatedAt);
    assert.ok(input.transit.predictions.length >= 1000);
  }
});
