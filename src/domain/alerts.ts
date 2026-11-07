import type { AlertEntity, Prediction, TransitAlert } from '../shared/contracts.js';

const parent: Record<string, string> = {
  '70067': 'place-harsq', '70069': 'place-cntsq', '70071': 'place-knncl', '70073': 'place-chmnl',
  '70075': 'place-pktrm', '70196': 'place-pktrm', '70197': 'place-pktrm',
  '70198': 'place-pktrm', '70199': 'place-pktrm', '70159': 'place-boyls',
  '70157': 'place-armnl', '70155': 'place-coecl'
};

export interface Leg { route: string; trip: string; predictions: Prediction[]; boarded?: boolean; }
type Window = [number, number];

function time(primary: string | null, secondary: string | null, fallback: number): number {
  for (const value of [primary, secondary]) {
    const parsed = value === null ? NaN : Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function windows(entity: AlertEntity, leg: Leg, evaluatedAt: number): Window[] {
  if (entity.route && entity.route !== leg.route) return [];
  if (entity.trip && entity.trip !== leg.trip) return [];
  if (entity.direction_id !== undefined && entity.direction_id !== 0) return [];
  if (entity.route_type !== undefined && entity.route_type !== (leg.route === 'Red' ? 1 : 0)) return [];
  const relevant = entity.stop ? leg.predictions.filter(p => p.stopId === entity.stop || parent[p.stopId] === entity.stop) : leg.predictions;
  if (!relevant.length) return [];
  const applies = (activity: string) => !entity.activities?.length || entity.activities.includes('ALL') || entity.activities.includes(activity);
  const result: Window[] = [];
  for (const p of relevant) {
    if (applies('BOARD') && ((leg.route === 'Red' && p.stopId === '70067' && !leg.boarded) || /^7019[6-9]$/.test(p.stopId))) {
      const boarding = time(p.departureTime, p.arrivalTime, evaluatedAt);
      result.push([boarding, boarding]);
    }
    if (applies('EXIT') && (p.stopId === '70075' || p.stopId === '70155')) {
      const exit = time(p.arrivalTime, p.departureTime, evaluatedAt);
      result.push([exit, exit]);
    }
    if (applies('RIDE') && entity.stop) {
      const arrival = time(p.arrivalTime, p.departureTime, evaluatedAt);
      const departure = time(p.departureTime, p.arrivalTime, evaluatedAt);
      result.push([Math.min(arrival, departure), Math.max(arrival, departure)]);
    }
  }
  if (applies('RIDE') && !entity.stop) {
    const ordered = [...relevant].sort((a, b) => a.sequence - b.sequence);
    const start = time(ordered[0].departureTime, ordered[0].arrivalTime, evaluatedAt);
    const end = time(ordered.at(-1)!.arrivalTime, ordered.at(-1)!.departureTime, evaluatedAt);
    result.push([Math.min(start, end), Math.max(start, end)]);
  }
  return result;
}

export function relevantAlerts(alerts: TransitAlert[], legs: Leg[], evaluatedAt: number): TransitAlert[] {
  return alerts.filter(alert => alert.informedEntities.some(entity => legs.some(leg =>
    windows(entity, leg, evaluatedAt).some(([visitStart, visitEnd]) => alert.activePeriods.some(period => {
      const start = period.start === null ? -Infinity : Date.parse(period.start);
      const end = period.end === null ? Infinity : Date.parse(period.end);
      return start <= visitEnd && visitStart < end;
    })))))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function hasNoService(alerts: TransitAlert[]): boolean {
  return alerts.some(alert => alert.effect === 'NO_SERVICE');
}
