export interface Prediction {
  id: string; tripId: string; routeId: string; stopId: string;
  sequence: number; direction: number | null;
  arrivalTime: string | null; departureTime: string | null;
  scheduleRelationship: string | null; status: string | null;
  arrivalUncertainty: number | null; departureUncertainty: number | null;
  serviceDate: string | null;
}
export interface AlertEntity {
  route?: string; trip?: string; stop?: string; direction_id?: number;
  route_type?: number; activities?: string[];
}
export interface TransitAlert {
  id: string; header: string; description: string; effect: string;
  activePeriods: { start: string | null; end: string | null }[];
  informedEntities: AlertEntity[];
}
export interface SourceHealth {
  observedAt: string; lastModified: string | null; capturedAt: string;
  projectedAt: string; generation: number; revision: number;
  topic: string; partition: number; offset: string;
}
export interface TransitState {
  predictions: Prediction[]; alerts: TransitAlert[];
  predictionHealth: SourceHealth | null; alertHealth: SourceHealth | null;
}
export interface JourneySettings {
  incomingTripId: string; preferredOutgoingTripId: string | null;
  extraTransferSeconds: number; boarded: boolean;
}
export interface TransferData {
  version: string; source: string; importedAt: string;
  minima: Record<string, number>;
}
export type AdviceStatus = 'enough_time' | 'tight' | 'insufficient_time' | 'unavailable' | 'unknown' | 'stale';
export interface ConnectionOption {
  tripId: string; routeId: string; departureTime: string | null; arrivalTime: string | null;
  transferSeconds: number; marginSeconds: number | null; status: AdviceStatus;
  explanation: string; predictions: Prediction[];
}
export interface Advice {
  status: AdviceStatus; headline: string; explanation: string;
  incoming: Prediction | null; incomingDeparture: Prediction | null;
  selected: ConnectionOption | null; alternatives: ConnectionOption[];
  alerts: TransitAlert[]; evaluatedAt: string; ruleVersion: string; transferVersion: string;
  source: SourceHealth | null;
}
export interface EvaluationInput {
  transit: TransitState; settings: JourneySettings; transfers: TransferData; evaluatedAt: string;
}
export interface IncomingOption { tripId: string; departureTime: string; arrivalTime: string; }
export interface DecisionRecord { id: string; createdAt: string; advice: Advice; input: EvaluationInput; }
export interface JourneyView {
  id: string; revision: number; settings: JourneySettings;
  advice: Advice | null; updatedAt: string; history: DecisionRecord[];
}
export interface BoardResponse {
  incoming: IncomingOption[]; source: SourceHealth | null; serverTime: string;
  transfers: TransferData; journey: JourneyView | null;
}
export interface ReplayFrame { label: string; input: EvaluationInput; }
export interface ReplayScenario { id: string; name: string; description: string; frames: ReplayFrame[]; }
