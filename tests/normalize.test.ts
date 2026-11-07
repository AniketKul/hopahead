import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePredictions, normalizeAlerts } from '../src/server/normalize.js';
const prediction = (id = 'p1', route = 'Red') => ({ type: 'prediction', id, attributes: {
  arrival_time: '2026-11-06T10:05:00-05:00', departure_time: null, stop_sequence: 12,
  direction_id: 0, schedule_relationship: 'CANCELLED', revenue: 'REVENUE', status: null,
  arrival_uncertainty: 3, departure_uncertainty: null,
}, relationships: { trip: { data: { id: 'trip-a' } }, route: { data: { id: route } }, stop: { data: { id: '70075' } } } });
test('normalization preserves resource identities, cancellation and uncertainty without inventing a service date', () => {
  const rows = normalizePredictions({ data: [prediction(), prediction('p2', 'Green-B')] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].arrivalTime, '2026-11-06T15:05:00.000Z');
  assert.equal(rows[0].scheduleRelationship, 'CANCELLED');
  assert.equal(rows[0].arrivalUncertainty, 3);
  assert.equal(rows[0].serviceDate, null);
  assert.equal(rows[1].routeId, 'Green-B');
});
test('invalid/duplicate resources reject the whole snapshot; non-revenue predictions are not boardable', () => {
  assert.throws(() => normalizePredictions({ data: [prediction(), prediction()] }), /duplicate/);
  const p = prediction(); p.attributes.arrival_time = 'not a time';
  assert.throws(() => normalizePredictions({ data: [p] }), /arrival_time/);
  const nonRevenue = prediction(); nonRevenue.attributes.revenue = 'NON_REVENUE';
  assert.deepEqual(normalizePredictions({ data: [nonRevenue] }), []);
});
test('alert normalization retains entity constraints and active periods', () => {
  const [alert] = normalizeAlerts({ data: [{ id: 'a', type: 'alert', attributes: {
    header: 'Station closed', description: '<b>untrusted</b>', effect: 'STATION_CLOSURE',
    active_period: [{ start: '2026-11-06T10:00:00Z', end: null }],
    informed_entity: [{ route: 'Green-B', stop: '70155', direction_id: 0, activities: ['BOARD'] }],
  } }] });
  assert.equal(alert.header, 'Station closed');
  assert.equal(alert.description, '<b>untrusted</b>');
  assert.deepEqual(alert.informedEntities[0], { route: 'Green-B', stop: '70155', direction_id: 0, activities: ['BOARD'] });
});

test('stop sequences larger than PostgreSQL integer range are quarantineable data errors', async () => {
  const { RecordValidationError } = await import('../src/server/snapshots.js');
  const p = prediction();
  p.attributes.stop_sequence = 2147483648;
  assert.throws(() => normalizePredictions({ data: [p] }), RecordValidationError);
  p.attributes.stop_sequence = 2147483647;
  assert.equal(normalizePredictions({ data: [p] })[0].sequence, 2147483647);
});
