import type { Advice, AdviceStatus, ConnectionOption, EvaluationInput, IncomingOption, Prediction } from '../shared/contracts.js';
import { hasNoService, relevantAlerts, type Leg } from './alerts.js';

export const RULE_VERSION = 'connection-margin-v1';
export const STALE_AFTER_SECONDS = 90;
export const MAX_PROCESSING_LAG_SECONDS = 30;
const platforms: Record<string, string> = { 'Green-B': '70196', 'Green-C': '70197', 'Green-D': '70198', 'Green-E': '70199' };
const corridor = new Set(['70067', '70069', '70071', '70073', '70075', '70196', '70197', '70198', '70199', '70159', '70157', '70155']);
const instant = (value: string | null) => value === null ? NaN : Date.parse(value);
const canceled = (p: Prediction) => p.scheduleRelationship === 'CANCELLED' || p.scheduleRelationship === 'SKIPPED';
const noData = (p: Prediction) => p.scheduleRelationship === 'NO_DATA';
const ordered = (values: Prediction[]) => [...values].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
const usable = (p: Prediction) => p.direction === 0 && !canceled(p) && !noData(p);

export function listIncoming(predictions: Prediction[], evaluatedAt: string): IncomingOption[] {
  const now = instant(evaluatedAt);
  if (!Number.isFinite(now)) throw new Error('Invalid evaluation time');
  const options = new Map<string, IncomingOption>();
  for (const departure of ordered(predictions.filter(p => p.routeId === 'Red' && p.stopId === '70067' && usable(p)))) {
    const leaves = instant(departure.departureTime);
    const arrival = ordered(predictions.filter(p => p.routeId === 'Red' && p.stopId === '70075'
      && p.tripId === departure.tripId && p.sequence > departure.sequence && usable(p)))
      .find(p => instant(p.arrivalTime) > leaves);
    if (leaves > now && arrival && !options.has(departure.tripId)) {
      options.set(departure.tripId, { tripId: departure.tripId, departureTime: departure.departureTime!, arrivalTime: arrival.arrivalTime! });
    }
  }
  return [...options.values()].sort((a, b) => instant(a.departureTime) - instant(b.departureTime) || a.tripId.localeCompare(b.tripId));
}

function leg(route: string, trip: string, predictions: Prediction[], from: Prediction | null, to: Prediction | null, boarded = false): Leg {
  return { route, trip, boarded, predictions: ordered(predictions.filter(p => p.routeId === route && p.tripId === trip && p.direction === 0 && corridor.has(p.stopId)
    && p.sequence >= (from?.sequence ?? -Infinity) && p.sequence <= (to?.sequence ?? Infinity))) };
}

export function captureEvidence(input: EvaluationInput, advice: Advice): EvaluationInput {
  const evidence = leg('Red', input.settings.incomingTripId, input.transit.predictions, advice.incomingDeparture, advice.incoming, input.settings.boarded).predictions;
  for (const candidate of [advice.selected, ...advice.alternatives]) {
    if (candidate) evidence.push(...leg(candidate.routeId, candidate.tripId, input.transit.predictions,
      candidate.predictions.find(p => p.stopId === platforms[candidate.routeId]) ?? null,
      candidate.predictions.find(p => p.stopId === '70155') ?? null).predictions);
  }
  const ids = new Set(evidence.map(p => p.id));
  return structuredClone({ ...input, transit: { ...input.transit,
    predictions: input.transit.predictions.filter(p => ids.has(p.id)), alerts: advice.alerts } });
}

function freshness(input: EvaluationInput, now: number): string | null {
  const source = input.transit.predictionHealth;
  if (!source) return 'Waiting for a complete live prediction snapshot.';
  const observed = instant(source.observedAt), projected = instant(source.projectedAt), captured = instant(source.capturedAt);
  if (![observed, projected, captured].every(Number.isFinite) || observed > now || projected > now || captured > now) {
    return 'Source timestamps cannot be validated. Connection advice is paused.';
  }
  if (now - observed > STALE_AFTER_SECONDS * 1000) return 'No successful prediction refresh for over 90 seconds. Connection advice is paused.';
  if (projected - observed > MAX_PROCESSING_LAG_SECONDS * 1000) return 'Prediction processing is over 30 seconds behind. Connection advice is paused.';
  return null;
}

function quality(predictions: Prediction[]): string {
  const codes = [...new Set(predictions.flatMap(p => [p.arrivalUncertainty, p.departureUncertainty]).filter(v => v !== null))];
  return codes.length ? ` Agency operating state code${codes.length === 1 ? '' : 's'}: ${codes.join(', ')}; these are not connection probabilities.` : '';
}

function option(input: EvaluationInput, now: number, incoming: Prediction | null, route: string, trip: string): ConnectionOption {
  const predictions = input.transit.predictions;
  const group = ordered(predictions.filter(p => p.routeId === route && p.tripId === trip && p.direction === 0));
  const departure = group.find(p => p.stopId === platforms[route]) ?? null;
  const arrival = group.find(p => p.stopId === '70155' && (!departure || p.sequence > departure.sequence)) ?? null;
  const evidence = [departure, arrival].filter((p): p is Prediction => p !== null);
  const minimum = input.transfers.minima[platforms[route]];
  const allowance = minimum + input.settings.extraTransferSeconds;
  const leaves = instant(departure?.departureTime ?? null), arrives = instant(arrival?.arrivalTime ?? null);
  const reaches = instant(incoming?.arrivalTime ?? null);
  const result: ConnectionOption = { tripId: trip, routeId: route, departureTime: departure?.departureTime ?? null,
    arrivalTime: arrival?.arrivalTime ?? null, transferSeconds: Number.isFinite(allowance) ? allowance : 0,
    marginSeconds: null, status: 'unknown', explanation: 'Waiting for matching Park Street departure and Copley arrival predictions.', predictions: evidence };
  if (evidence.some(canceled)) {
    result.status = 'unavailable'; result.explanation = 'This trip is canceled or skips a required stop.';
  } else if (Number.isFinite(leaves) && leaves <= now) {
    result.status = 'unavailable'; result.explanation = 'The predicted Park Street departure has already passed.';
  } else if (hasNoService(relevantAlerts(input.transit.alerts, [leg(route, trip, predictions, departure, arrival)], now))) {
    result.status = 'unavailable'; result.explanation = 'An active no-service alert applies to this part of the trip.';
  } else if (departure && arrival && evidence.every(p => !noData(p)) && Number.isFinite(leaves) && Number.isFinite(arrives)
    && arrives > leaves && Number.isFinite(reaches) && Number.isFinite(minimum) && minimum >= 0) {
    const margin = Math.floor((leaves - reaches) / 1000 - allowance);
    result.marginSeconds = margin;
    result.status = margin >= 120 ? 'enough_time' : margin >= 0 ? 'tight' : 'insufficient_time';
    result.explanation = margin >= 0 ? `${margin} seconds remain beyond the ${allowance}-second transfer allowance.`
      : `The connection is ${-margin} seconds short of the ${allowance}-second transfer allowance.`;
  }
  result.explanation += quality(evidence);
  return result;
}

export function evaluate(input: EvaluationInput): Advice {
  const now = instant(input.evaluatedAt);
  if (!Number.isFinite(now)) throw new Error('Invalid evaluation time');
  if (!Number.isInteger(input.settings.extraTransferSeconds) || input.settings.extraTransferSeconds < 0 || input.settings.extraTransferSeconds > 1800) {
    throw new Error('Extra transfer time must be an integer from 0 to 1800 seconds');
  }
  const predictions = input.transit.predictions;
  const incomingGroup = ordered(predictions.filter(p => p.routeId === 'Red' && p.tripId === input.settings.incomingTripId && p.direction === 0));
  const departure = incomingGroup.find(p => p.stopId === '70067') ?? null;
  const incoming = incomingGroup.find(p => p.stopId === '70075' && (!departure || p.sequence > departure.sequence)) ?? null;
  const incomingLeg = leg('Red', input.settings.incomingTripId, predictions, departure, incoming, input.settings.boarded);
  const groups = new Map<string, { trip: string; route: string }>();
  for (const p of predictions) {
    if (platforms[p.routeId] && p.direction === 0 && (p.stopId === platforms[p.routeId] || p.stopId === '70155')) {
      groups.set(`${p.routeId}:${p.tripId}`, { trip: p.tripId, route: p.routeId });
    }
  }
  const options = [...groups.values()].map(({ route, trip }) => option(input, now, incoming, route, trip));
  const rank = (a: ConnectionOption, b: ConnectionOption) => (instant(a.arrivalTime) || Infinity) - (instant(b.arrivalTime) || Infinity)
    || a.tripId.localeCompare(b.tripId) || a.routeId.localeCompare(b.routeId);
  options.sort(rank);
  const feasible = (p: ConnectionOption) => p.status === 'enough_time' || p.status === 'tight';
  const selected = input.settings.preferredOutgoingTripId
    ? options.find(p => p.tripId === input.settings.preferredOutgoingTripId) ?? null
    : options.find(feasible) ?? options[0] ?? null;
  const alternatives = options.filter(p => p !== selected && p.predictions.length === 2 && Number.isFinite(instant(p.departureTime))
    && Number.isFinite(instant(p.arrivalTime)) && instant(p.departureTime) > now)
    .sort((a, b) => Number(feasible(b)) - Number(feasible(a)) || rank(a, b)).slice(0, 2);
  const outgoingLegs = [selected, ...alternatives].filter((p): p is ConnectionOption => !!p)
    .map(p => leg(p.routeId, p.tripId, predictions, p.predictions.find(v => v.stopId === platforms[p.routeId]) ?? null,
      p.predictions.find(v => v.stopId === '70155') ?? null));
  let status: AdviceStatus = selected?.status ?? 'unknown';
  let incomingFailure = false;
  let explanation = selected?.explanation ?? (input.settings.preferredOutgoingTripId
    ? 'The preferred Green Line trip is missing. Choose a verified alternative or wait for a refresh.'
    : 'No matching Green Line connection is currently available.');
  if ([departure, incoming].some(p => p && canceled(p))) {
    incomingFailure = true;
    status = 'unavailable'; explanation = 'The selected Red Line trip is canceled or skips a required stop.';
  } else if (!incoming || noData(incoming) || !Number.isFinite(instant(incoming.arrivalTime))
    || (!input.settings.boarded && (!departure || noData(departure) || !Number.isFinite(instant(departure.departureTime))))) {
    incomingFailure = true;
    status = 'unknown'; explanation = !departure && !input.settings.boarded
      ? 'The chosen Harvard departure is missing. Confirm that you boarded, or choose a different trip.'
      : 'Waiting for a valid Park Street arrival on the chosen Red Line trip.';
  } else if (instant(incoming.arrivalTime) <= now || (departure && instant(incoming.arrivalTime) <= instant(departure.departureTime))) {
    incomingFailure = true; status = 'unknown'; explanation = 'The Park Street arrival estimate has elapsed or conflicts with the Harvard departure. Waiting for an updated trip estimate.';
  } else if (!input.settings.boarded && instant(departure!.departureTime) <= now) {
    incomingFailure = true;
    status = 'unknown'; explanation = 'The Harvard departure has passed. Confirm that you boarded to keep monitoring this trip.';
  } else if (hasNoService(relevantAlerts(input.transit.alerts, [incomingLeg], now))) {
    incomingFailure = true;
    status = 'unavailable'; explanation = 'An active no-service alert applies to the selected Red Line trip.';
  }
  const stale = freshness(input, now);
  if (stale) { status = 'stale'; explanation = stale; }
  if (stale || incomingFailure) {
    for (const candidate of [selected, ...alternatives]) {
      if (candidate && feasible(candidate)) { candidate.status = status; candidate.explanation = explanation; }
    }
  }
  const headlines: Record<AdviceStatus, string> = {
    enough_time: 'Time for your connection', tight: 'A tight connection', insufficient_time: 'Try a later connection',
    unavailable: 'This connection is unavailable', unknown: 'More information is needed', stale: 'Live advice is paused'
  };
  return { status, headline: headlines[status], explanation, incoming, incomingDeparture: departure, selected, alternatives,
    alerts: relevantAlerts(input.transit.alerts, [incomingLeg, ...outgoingLegs], now), evaluatedAt: input.evaluatedAt,
    ruleVersion: RULE_VERSION, transferVersion: input.transfers.version, source: input.transit.predictionHealth };
}
