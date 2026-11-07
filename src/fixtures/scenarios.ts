import type { EvaluationInput, Prediction, ReplayFrame, ReplayScenario } from '../shared/contracts.js';

const start = Date.parse('2026-11-06T14:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
function prediction(id: string, tripId: string, routeId: string, stopId: string, sequence: number, seconds: number): Prediction {
  return { id: `demo-${id}`, tripId: `demo-${tripId}`, routeId, stopId, sequence, direction: 0,
    arrivalTime: at(seconds), departureTime: at(seconds), scheduleRelationship: null, status: null,
    arrivalUncertainty: null, departureUncertainty: null, serviceDate: '2026-11-06' };
}
function frame(label: string, seconds: number, change?: (input: EvaluationInput) => void): ReplayFrame {
  const input: EvaluationInput = {
    evaluatedAt: at(seconds),
    settings: { incomingTripId: 'demo-red-1', preferredOutgoingTripId: 'demo-green-b', extraTransferSeconds: 0, boarded: true },
    transfers: { version: 'demo-transfer-v1:152-184', source: 'https://cdn.mbta.com/MBTA_GTFS.zip', importedAt: at(-3600),
      minima: { '70196': 152, '70197': 184, '70198': 152, '70199': 184 } },
    transit: {
      predictions: [prediction('harvard', 'red-1', 'Red', '70067', 1, 60), prediction('park-red', 'red-1', 'Red', '70075', 5, 600),
        prediction('park-b', 'green-b', 'Green-B', '70196', 10, 872), prediction('copley-b', 'green-b', 'Green-B', '70155', 13, 1230),
        prediction('park-d', 'green-d', 'Green-D', '70198', 10, 1080), prediction('copley-d', 'green-d', 'Green-D', '70155', 13, 1380),
        prediction('park-e', 'green-e', 'Green-E', '70199', 10, 1200), prediction('copley-e', 'green-e', 'Green-E', '70155', 13, 1500)],
      alerts: [], alertHealth: null,
      predictionHealth: { observedAt: at(seconds), capturedAt: at(seconds), projectedAt: at(seconds), lastModified: at(seconds - 5),
        generation: 1, revision: seconds + 1, topic: 'simulation.predictions', partition: 0, offset: String(seconds + 1) }
    }
  };
  change?.(input);
  return { label, input };
}
const delay = (seconds: number) => (input: EvaluationInput) => { input.transit.predictions[1].arrivalTime = at(600 + seconds); };
const cancel = (input: EvaluationInput) => { input.transit.predictions[2].scheduleRelationship = 'CANCELLED'; };
const missingOrigin = (input: EvaluationInput) => { input.transit.predictions = input.transit.predictions.filter(p => p.stopId !== '70067'); };
const noRefresh = (input: EvaluationInput) => {
  Object.assign(input.transit.predictionHealth!, { observedAt: at(0), capturedAt: at(0), projectedAt: at(0), lastModified: at(-5), revision: 1, offset: '1' });
};

export const scenarios: ReplayScenario[] = [
  {
    id: 'delay', name: 'A connection starts slipping',
    description: 'Simulated Red Line delays reduce the transfer margin while later Green Line options stay visible.',
    frames: [frame('Two minutes beyond the allowance', 0), frame('One minute remains', 15, delay(60)),
      frame('Exactly the planned allowance', 30, delay(120)), frame('The preferred train is now too tight', 45, delay(210))]
  },
  {
    id: 'cancellation', name: 'A canceled train, a clear alternative',
    description: 'A simulated cancellation affects the preferred Green train. A verified D branch departure still reaches Copley.',
    frames: [frame('Preferred B train available', 0), frame('Cancellation arrives', 15, cancel),
      frame('A later D train still works', 30, cancel), frame('Rider selects the D alternative', 45, input => {
        cancel(input); input.settings.preferredOutgoingTripId = 'demo-green-d';
      })]
  },
  {
    id: 'disappearance', name: 'Your trip stays your trip',
    description: 'A missing origin prediction does not switch trains. Boarding confirmation keeps the original Red trip pinned.',
    frames: [frame('Chosen Red train approaching Harvard', 0, input => { input.settings.boarded = false; }),
      frame('Origin prediction disappears', 15, input => { missingOrigin(input); input.settings.boarded = false; }),
      frame('Rider confirms boarding', 30, missingOrigin), frame('Park arrival is temporarily missing', 45, input => {
        missingOrigin(input); input.transit.predictions = input.transit.predictions.filter(p => p.stopId !== '70075');
      }), frame('Park arrival returns for the same trip', 60, missingOrigin)]
  },
  {
    id: 'stale', name: 'When the feed goes quiet',
    description: 'Simulated source silence pauses positive advice after 90 seconds. A complete fresh observation restores it.',
    frames: [frame('Fresh source contact', 0), frame('No refresh for one minute', 60, noRefresh),
      frame('Freshness threshold crossed', 91, noRefresh), frame('Advice remains paused', 150, noRefresh), frame('Fresh snapshot received', 165)]
  },
  {
    id: 'recovery', name: 'Evidence disappears, then recovers',
    description: 'Simulated cancellation and missing evidence remain explicit until matching trip predictions return.',
    frames: [frame('Connection has enough time', 0), frame('Preferred train canceled', 15, cancel),
      frame('Preferred trip absent, alternatives visible', 30, input => {
        input.transit.predictions = input.transit.predictions.filter(p => p.tripId !== 'demo-green-b');
      }), frame('Incoming arrival unavailable', 45, input => { input.transit.predictions = input.transit.predictions.filter(p => p.stopId !== '70075'); }),
      frame('Complete predictions restored', 60)]
  }
];
