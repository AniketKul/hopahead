import { PG_INTEGER_MAX, RecordValidationError } from './snapshots.js';
import type { AlertEntity, Prediction, TransitAlert } from '../shared/contracts.js';

export const MAX_RESOURCES = 200000;
type Obj = Record<string, unknown>;
function object(value: unknown, field: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RecordValidationError(`invalid ${field}`);
  return value as Obj;
}
function text(value: unknown, field: string, max = 512): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new RecordValidationError(`invalid ${field}`);
  return value;
}
function optionalText(value: unknown, field: string, max = 512): string | null {
  return value === null || value === undefined || value === '' ? null : text(value, field, max);
}
function instant(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  const s = text(value, field, 64);
  if (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(s) || !Number.isFinite(Date.parse(s))) throw new RecordValidationError(`invalid ${field}`);
  return new Date(s).toISOString();
}
function number(value: unknown, field: string, nullable = false, max = Number.MAX_SAFE_INTEGER): number | null {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new RecordValidationError(`invalid ${field}`);
  return value as number;
}
function resources(document: unknown, type: string): Obj[] {
  const data = object(document, 'document').data;
  if (!Array.isArray(data) || data.length > MAX_RESOURCES) throw new RecordValidationError('invalid data resource count');
  const ids = new Set<string>();
  return data.map(value => {
    const row = object(value, 'resource');
    if (row.type !== type) throw new RecordValidationError(`unexpected resource type ${type}`);
    const id = text(row.id, 'id');
    if (ids.has(id)) throw new RecordValidationError('duplicate resource id');
    ids.add(id);
    return row;
  });
}
function relationship(row: Obj, name: string): string {
  const rel = object(object(row.relationships, 'relationships')[name], name);
  return text(object(rel.data, `${name}.data`).id, `${name}.id`);
}
export function normalizePredictions(document: unknown): Prediction[] {
  return resources(document, 'prediction').flatMap(row => {
    const a = object(row.attributes, 'attributes');
    if (a.revenue === 'NON_REVENUE' || a.revenue_status === 'NON_REVENUE') return [];
    const direction = number(a.direction_id, 'direction_id', true);
    if (direction !== null && direction !== 0 && direction !== 1) throw new RecordValidationError('invalid direction_id');
    return [{ id: text(row.id, 'id'), tripId: relationship(row, 'trip'), routeId: relationship(row, 'route'),
      stopId: relationship(row, 'stop'), sequence: number(a.stop_sequence, 'stop_sequence', false, PG_INTEGER_MAX)!, direction,
      arrivalTime: instant(a.arrival_time, 'arrival_time'), departureTime: instant(a.departure_time, 'departure_time'),
      scheduleRelationship: optionalText(a.schedule_relationship, 'schedule_relationship'), status: optionalText(a.status, 'status', 4096),
      arrivalUncertainty: number(a.arrival_uncertainty, 'arrival_uncertainty', true),
      departureUncertainty: number(a.departure_uncertainty, 'departure_uncertainty', true), serviceDate: null }];
  });
}
export function normalizeAlerts(document: unknown): TransitAlert[] {
  return resources(document, 'alert').map(row => {
    const a = object(row.attributes, 'attributes');
    if (!Array.isArray(a.active_period) || a.active_period.length > 1000 || !Array.isArray(a.informed_entity) || a.informed_entity.length > 10000) throw new RecordValidationError('invalid alert constraints');
    const informedEntities: AlertEntity[] = a.informed_entity.map(v => {
      const entity = object(v, 'informed_entity');
      const result: AlertEntity = {};
      for (const key of ['route', 'trip', 'stop'] as const) if (entity[key] != null) result[key] = text(entity[key], key);
      for (const key of ['direction_id', 'route_type'] as const) if (entity[key] != null) result[key] = number(entity[key], key)!;
      if (entity.activities != null) {
        if (!Array.isArray(entity.activities) || entity.activities.length > 32) throw new RecordValidationError('invalid activities');
        result.activities = entity.activities.map(v => text(v, 'activity'));
      }
      return result;
    });
    return { id: text(row.id, 'id'), header: optionalText(a.header, 'header', 16384) ?? 'Service alert',
      description: optionalText(a.description, 'description', 65536) ?? '', effect: optionalText(a.effect, 'effect') ?? 'UNKNOWN_EFFECT',
      activePeriods: a.active_period.map(v => { const p = object(v, 'active_period'); return { start: instant(p.start, 'start'), end: instant(p.end, 'end') }; }),
      informedEntities };
  });
}
