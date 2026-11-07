import { createHmac, timingSafeEqual } from 'node:crypto';
import type { JourneySettings } from '../shared/contracts.js';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const identifier = /^[A-Za-z0-9_.:-]{1,128}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function signSession(id: string, expires: number, secret: string): string {
  const value = `${id}.${expires}`;
  return `${value}.${createHmac('sha256', secret).update(value).digest('base64url')}`;
}
export function readSession(cookie: string | undefined, secret: string, now: number): string | null {
  const token = cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('hop_session='))?.slice(12);
  if (!token || token.length > 200) return null;
  const [id, expires, signature, extra] = token.split('.');
  if (extra || !uuid.test(id ?? '') || !/^\d{1,16}$/.test(expires ?? '') || Number(expires) <= now || !signature) return null;
  const expected = signSession(id, Number(expires), secret).split('.')[2];
  const a = Buffer.from(signature), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}
export function validateSettings(body: unknown): JourneySettings {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid journey settings.');
  const s = body as Record<string, unknown>;
  if (typeof s.incomingTripId !== 'string' || !identifier.test(s.incomingTripId) ||
      !(s.preferredOutgoingTripId === null || (typeof s.preferredOutgoingTripId === 'string' && identifier.test(s.preferredOutgoingTripId))) ||
      typeof s.extraTransferSeconds !== 'number' || !Number.isInteger(s.extraTransferSeconds) || s.extraTransferSeconds < 0 || s.extraTransferSeconds > 1800 ||
      typeof s.boarded !== 'boolean') throw new HttpError(400, 'Select a trip and an extra allowance from 0 to 30 minutes.');
  return { incomingTripId: s.incomingTripId, preferredOutgoingTripId: s.preferredOutgoingTripId as string | null,
    extraTransferSeconds: s.extraTransferSeconds, boarded: s.boarded };
}
export function checkOrigin(origin: string | undefined, expected: string): void {
  if (origin !== expected) throw new HttpError(403, 'Request origin is not allowed.');
}
export function idempotencyKey(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !identifier.test(value)) throw new HttpError(400, 'Provide a valid Idempotency-Key.');
  return value;
}
