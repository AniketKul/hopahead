import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureEvidence, evaluate, listIncoming } from '../src/domain/advice.js';
import type { EvaluationInput, Prediction, TransitAlert } from '../src/shared/contracts.js';

const now = '2026-11-06T14:00:00.000Z';
const at = (seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString();
function prediction(id: string, tripId: string, routeId: string, stopId: string, sequence: number, seconds: number): Prediction {
  return { id, tripId, routeId, stopId, sequence, direction: 0, arrivalTime: at(seconds), departureTime: at(seconds),
    scheduleRelationship: null, status: null, arrivalUncertainty: null, departureUncertainty: null, serviceDate: '2026-11-06' };
}
function input(margin = 120): EvaluationInput {
  return {
    evaluatedAt: now,
    settings: { incomingTripId: 'red-1', preferredOutgoingTripId: 'green-1', extraTransferSeconds: 0, boarded: false },
    transfers: { version: 'gtfs-test', source: 'fixture', importedAt: now, minima: { '70196': 152, '70197': 184, '70198': 152, '70199': 184 } },
    transit: {
      predictions: [prediction('harvard', 'red-1', 'Red', '70067', 1, 60), prediction('park-red', 'red-1', 'Red', '70075', 5, 600),
        prediction('park-green', 'green-1', 'Green-B', '70196', 10, 752 + margin), prediction('copley', 'green-1', 'Green-B', '70155', 13, 1100 + margin)],
      alerts: [], alertHealth: null,
      predictionHealth: { observedAt: now, lastModified: at(-10), capturedAt: now, projectedAt: now, generation: 1, revision: 1,
        topic: 'predictions', partition: 0, offset: '10' }
    }
  };
}

for (const [margin, status] of [[-1, 'insufficient_time'], [0, 'tight'], [119, 'tight'], [120, 'enough_time']] as const) {
  test(`transfer margin ${margin} gives ${status}`, () => {
    const advice = evaluate(input(margin));
    assert.equal(advice.status, status);
    assert.equal(advice.selected?.marginSeconds, margin);
    assert.equal(advice.selected?.transferSeconds, 152);
    assert.equal(advice.transferVersion, 'gtfs-test');
  });
}
test('extra allowance is added once to the published transfer minimum', () => {
  const sample = input(120); sample.settings.extraTransferSeconds = 60;
  const advice = evaluate(sample);
  assert.equal(advice.selected?.marginSeconds, 60);
  assert.equal(advice.selected?.transferSeconds, 212);
  assert.equal(advice.status, 'tight');
});
test('C branch uses its own platform allowance', () => {
  const sample = input(120);
  for (const p of sample.transit.predictions.filter(p => p.tripId === 'green-1')) p.routeId = 'Green-C';
  sample.transit.predictions[2].stopId = '70197';
  assert.equal(evaluate(sample).selected?.marginSeconds, 88);
});
for (const index of [0, 1, 2, 3]) {
  for (const relationship of ['CANCELLED', 'SKIPPED']) {
    test(`${relationship} at endpoint ${index} disqualifies the connection`, () => {
      const sample = input(); sample.transit.predictions[index].scheduleRelationship = relationship;
      assert.equal(evaluate(sample).status, 'unavailable');
    });
  }
}
test('NO_DATA is unknown, not a canceled departure', () => {
  const sample = input(); sample.transit.predictions[3].scheduleRelationship = 'NO_DATA';
  assert.equal(evaluate(sample).status, 'unknown');
});
test('a missing origin keeps the incoming trip pinned and requires boarded confirmation', () => {
  const sample = input(); sample.transit.predictions.shift();
  sample.transit.predictions.push(prediction('other', 'red-2', 'Red', '70067', 1, 80));
  assert.equal(evaluate(sample).status, 'unknown');
  sample.settings.boarded = true;
  const advice = evaluate(sample);
  assert.equal(advice.status, 'enough_time');
  assert.equal(advice.incoming?.tripId, 'red-1');
  assert.equal(advice.incomingDeparture, null);
});
test('missing incoming Park arrival remains unknown after boarding', () => {
  const sample = input(); sample.settings.boarded = true; sample.transit.predictions.splice(1, 1);
  assert.equal(evaluate(sample).status, 'unknown');
});
test('destination must be on the same outgoing trip, route, direction and after boarding', () => {
  for (const patch of [{ tripId: 'another-trip' }, { routeId: 'Green-C' }, { direction: 1 }, { sequence: 9 }]) {
    const sample = input(); Object.assign(sample.transit.predictions[3], patch);
    assert.equal(evaluate(sample).status, 'unknown');
  }
});
test('a route-specific Green boarding platform is required', () => {
  const sample = input(); sample.transit.predictions[2].stopId = '70197';
  assert.equal(evaluate(sample).status, 'unknown');
});
test('preferred departure disappearing does not silently select another trip', () => {
  const sample = input(); sample.settings.preferredOutgoingTripId = 'gone';
  const advice = evaluate(sample);
  assert.equal(advice.status, 'unknown');
  assert.equal(advice.selected, null);
  assert.equal(advice.alternatives[0]?.tripId, 'green-1');
  assert.equal(advice.alternatives[0]?.status, 'enough_time');
});
test('a canceled preferred train does not disqualify another verified train', () => {
  const sample = input(); sample.transit.predictions[2].scheduleRelationship = 'CANCELLED';
  sample.transit.predictions.push(prediction('d-p', 'green-d', 'Green-D', '70198', 10, 1000), prediction('d-c', 'green-d', 'Green-D', '70155', 13, 1500));
  const advice = evaluate(sample);
  assert.equal(advice.status, 'unavailable');
  assert.equal(advice.alternatives[0]?.status, 'enough_time');
});
test('impossible incoming times and an elapsed Park arrival cannot produce positive advice', () => {
  const impossible = input(); impossible.transit.predictions[1].arrivalTime = at(30);
  assert.equal(evaluate(impossible).status, 'unknown');
  const elapsed = input(); elapsed.settings.boarded = true; elapsed.evaluatedAt = at(650);
  Object.assign(elapsed.transit.predictionHealth!, { observedAt: at(650), capturedAt: at(650), projectedAt: at(650) });
  assert.equal(evaluate(elapsed).status, 'unknown');
});
test('alternatives rank feasible trains by destination arrival with stable ties', () => {
  const sample = input(); sample.settings.preferredOutgoingTripId = null;
  sample.transit.predictions.push(
    prediction('d-park', 'green-d', 'Green-D', '70198', 10, 950), prediction('d-copley', 'green-d', 'Green-D', '70155', 13, 1150),
    prediction('c-park', 'green-c', 'Green-C', '70197', 10, 980), prediction('c-copley', 'green-c', 'Green-C', '70155', 13, 1150));
  const advice = evaluate(sample);
  assert.equal(advice.selected?.tripId, 'green-c');
  assert.deepEqual(advice.alternatives.map(p => p.tripId), ['green-d', 'green-1']);
  assert.deepEqual(evaluate({ ...sample, transit: { ...sample.transit, predictions: [...sample.transit.predictions].reverse() } }), advice);
});
test('automatic choice skips infeasible trains even when they arrive sooner', () => {
  const sample = input(-1); sample.settings.preferredOutgoingTripId = null;
  sample.transit.predictions.push(prediction('d-p', 'green-d', 'Green-D', '70198', 10, 1000), prediction('d-c', 'green-d', 'Green-D', '70155', 13, 1500));
  assert.equal(evaluate(sample).selected?.tripId, 'green-d');
});
test('an expired departure is unavailable even when its old margin was positive', () => {
  const sample = input(); sample.evaluatedAt = at(900); sample.transit.predictionHealth!.observedAt = at(900);
  sample.transit.predictionHealth!.projectedAt = at(900);
  assert.equal(evaluate(sample).selected?.status, 'unavailable');
});
test('a future observation or invalid prediction time cannot produce positive advice', () => {
  const sample = input(); sample.transit.predictions[2].departureTime = 'not-a-time';
  assert.equal(evaluate(sample).status, 'unknown');
  const future = input(); future.transit.predictionHealth!.observedAt = at(30);
  assert.equal(evaluate(future).status, 'stale');
});
test('90-second contact boundary and processing lag override positive estimates', () => {
  const sample = input(); sample.evaluatedAt = at(90); sample.settings.boarded = true;
  assert.equal(evaluate(sample).status, 'enough_time');
  sample.evaluatedAt = at(91);
  assert.equal(evaluate(sample).status, 'stale');
  const lag = input(); lag.transit.predictionHealth!.projectedAt = at(45);
  assert.equal(evaluate(lag).status, 'stale');
  const missing = input(); missing.transit.predictionHealth = null;
  assert.equal(evaluate(missing).status, 'stale');
});
test('source freshness never claims exact age of a prediction measurement', () => {
  const sample = input(); sample.transit.predictions[2].departureUncertainty = 60;
  const advice = evaluate(sample);
  assert.equal(advice.selected?.predictions[0].departureUncertainty, 60);
  assert.match(advice.selected!.explanation, /operating state/i);
  assert.doesNotMatch(advice.explanation, /\d+%/);
});
test('after-midnight and fall DST estimates use instants and retain service date', () => {
  const sample = input(0);
  sample.evaluatedAt = '2026-11-01T05:40:00Z';
  Object.assign(sample.transit.predictionHealth!, { observedAt: sample.evaluatedAt, capturedAt: sample.evaluatedAt, projectedAt: sample.evaluatedAt });
  Object.assign(sample.transit.predictions[0], { departureTime: '2026-11-01T01:45:00-04:00', arrivalTime: '2026-11-01T01:45:00-04:00', serviceDate: '2026-10-31' });
  sample.transit.predictions[1].arrivalTime = '2026-11-01T01:59:00-04:00';
  sample.transit.predictions[2].departureTime = '2026-11-01T01:01:32-05:00';
  sample.transit.predictions[3].arrivalTime = '2026-11-01T01:10:00-05:00';
  const advice = evaluate(sample);
  assert.equal(advice.selected?.marginSeconds, 0);
  assert.equal(advice.incomingDeparture?.serviceDate, '2026-10-31');
});
test('evaluate is deterministic and leaves captured input unchanged', () => {
  const sample = input(); const before = structuredClone(sample);
  const first = evaluate(sample);
  assert.deepEqual(evaluate(sample), first);
  assert.deepEqual(sample, before);
});
test('incoming list requires future Harvard departure and same trip Park arrival', () => {
  const sample = input();
  assert.deepEqual(listIncoming(sample.transit.predictions, now), [{ tripId: 'red-1', departureTime: at(60), arrivalTime: at(600) }]);
  assert.deepEqual(listIncoming(sample.transit.predictions, at(60)), []);
  sample.transit.predictions[1].tripId = 'red-other';
  assert.deepEqual(listIncoming(sample.transit.predictions, now), []);
});

function alert(patch: Partial<TransitAlert> = {}): TransitAlert {
  return { id: 'warning', header: 'Delay on the Green Line', description: 'Allow extra time.', effect: 'DELAY',
    activePeriods: [{ start: at(-60), end: at(3600) }], informedEntities: [{ route: 'Green-B', direction_id: 0 }], ...patch };
}
test('only active alerts matching the used corridor, trip, direction and activity appear', () => {
  const sample = input();
  sample.transit.alerts = [alert(),
    alert({ id: 'past', activePeriods: [{ start: at(-120), end: at(-1) }] }),
    alert({ id: 'beyond', informedEntities: [{ route: 'Green-B', stop: 'place-kencl' }] }),
    alert({ id: 'other-trip', informedEntities: [{ trip: 'another-trip' }] }),
    alert({ id: 'other-direction', informedEntities: [{ route: 'Green-B', direction_id: 1 }] }),
    alert({ id: 'parking', informedEntities: [{ stop: 'place-pktrm', activities: ['PARK_CAR'] }] })];
  const advice = evaluate(sample);
  assert.deepEqual(advice.alerts.map(a => a.id), ['warning']);
  assert.equal(advice.status, 'enough_time');
});
test('an explicit relevant no-service alert disqualifies its departure, unrelated closure does not', () => {
  const sample = input();
  sample.transit.alerts = [alert({ effect: 'NO_SERVICE', informedEntities: [{ route: 'Green-B', stop: 'place-coecl' }] })];
  assert.equal(evaluate(sample).status, 'unavailable');
  sample.transit.alerts[0].informedEntities[0].stop = 'place-kencl';
  assert.equal(evaluate(sample).status, 'enough_time');
});
test('a future no-service alert is checked against boarding time and survives compact replay', () => {
  const sample = input();
  sample.transit.predictions[2].departureTime = at(1200);
  sample.transit.predictions[3].arrivalTime = at(1500);
  sample.transit.alerts = [alert({ effect: 'NO_SERVICE', activePeriods: [{ start: at(600), end: at(1800) }],
    informedEntities: [{ route: 'Green-B', stop: 'place-pktrm', activities: ['BOARD'] }] })];
  const advice = evaluate(sample);
  assert.equal(advice.status, 'unavailable');
  assert.deepEqual(advice.alerts.map(a => a.id), ['warning']);
  assert.deepEqual(evaluate(captureEvidence(sample, advice)), advice);
});
test('a no-service alert ending before future boarding does not invalidate that departure', () => {
  const sample = input();
  sample.transit.predictions[2].departureTime = at(1200);
  sample.transit.predictions[3].arrivalTime = at(1500);
  sample.transit.alerts = [alert({ effect: 'NO_SERVICE', activePeriods: [{ start: at(-60), end: at(300) }],
    informedEntities: [{ route: 'Green-B', stop: 'place-pktrm', activities: ['BOARD'] }] })];
  assert.equal(evaluate(sample).status, 'enough_time');
  assert.deepEqual(evaluate(sample).alerts, []);
});
test('route riding alerts cover the segment interval and exit alerts use destination arrival', () => {
  const sample = input();
  sample.transit.predictions[2].departureTime = at(1200);
  sample.transit.predictions[3].arrivalTime = at(1500);
  sample.transit.alerts = [
    alert({ id: 'during-ride', activePeriods: [{ start: at(1300), end: at(1400) }],
      informedEntities: [{ route: 'Green-B', activities: ['RIDE'] }] }),
    alert({ id: 'at-exit', activePeriods: [{ start: at(1450), end: at(1600) }],
      informedEntities: [{ route: 'Green-B', stop: 'place-coecl', activities: ['EXIT'] }] }),
    alert({ id: 'after-trip', activePeriods: [{ start: at(1600), end: at(1800) }],
      informedEntities: [{ route: 'Green-B', activities: ['RIDE'] }] })
  ];
  const advice = evaluate(sample);
  assert.deepEqual(advice.alerts.map(a => a.id), ['at-exit', 'during-ride']);
  assert.deepEqual(evaluate(captureEvidence(sample, advice)), advice);
});
test('alert end is exclusive at boarding and missing boarding times fall back to evaluation time', () => {
  const sample = input();
  sample.transit.alerts = [alert({ activePeriods: [{ start: at(600), end: at(872) }],
    informedEntities: [{ route: 'Green-B', stop: 'place-pktrm', activities: ['BOARD'] }] })];
  assert.deepEqual(evaluate(sample).alerts, []);
  sample.transit.predictions[2].departureTime = null;
  sample.transit.predictions[2].arrivalTime = null;
  sample.transit.alerts[0].activePeriods = [{ start: at(-60), end: at(60) }];
  assert.deepEqual(evaluate(sample).alerts.map(a => a.id), ['warning']);
});
test('compact replay retains intermediate stop alerts and excludes stops beyond the destination', () => {
  const sample = input();
  sample.transit.predictions.push(prediction('central', 'red-1', 'Red', '70069', 2, 240),
    prediction('boylston', 'green-1', 'Green-B', '70159', 11, 1000),
    prediction('kenmore', 'green-1', 'Green-B', '70153', 15, 1500));
  sample.transit.alerts = [
    alert({ id: 'central-warning', informedEntities: [{ route: 'Red', stop: 'place-cntsq', activities: ['RIDE'] }] }),
    alert({ id: 'boylston-warning', informedEntities: [{ route: 'Green-B', stop: 'place-boyls', activities: ['RIDE'] }] }),
    alert({ id: 'beyond-closure', effect: 'NO_SERVICE', informedEntities: [{ route: 'Green-B', stop: '70153' }] })
  ];
  const advice = evaluate(sample);
  assert.equal(advice.status, 'enough_time');
  assert.deepEqual(advice.alerts.map(a => a.id), ['boylston-warning', 'central-warning']);
  const evidence = captureEvidence(sample, advice);
  assert.ok(evidence.transit.predictions.some(p => p.id === 'central'));
  assert.ok(evidence.transit.predictions.some(p => p.id === 'boylston'));
  assert.ok(!evidence.transit.predictions.some(p => p.id === 'kenmore'));
  assert.deepEqual(evaluate(evidence), advice);
});
test('invalid extra time and evaluation clock are rejected at the domain boundary', () => {
  const sample = input(); sample.settings.extraTransferSeconds = -10;
  assert.throws(() => evaluate(sample), /transfer/i);
  const invalid = input(); invalid.evaluatedAt = 'yesterday';
  assert.throws(() => evaluate(invalid), /evaluation/i);
});
