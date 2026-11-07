import type { AdviceStatus } from "../shared/contracts.js";

export const statusLabels: Record<AdviceStatus, string> = {
  enough_time: "Enough time",
  tight: "A tight connection",
  insufficient_time: "Too little transfer time",
  unavailable: "Connection unavailable",
  unknown: "Waiting for predictions",
  stale: "Predictions are stale",
};
const clock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
});
const date = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});
export function time(value: string | null | undefined) {
  return value && Number.isFinite(Date.parse(value))
    ? clock.format(new Date(value))
    : "Awaiting prediction";
}
export function timestamp(value: string) {
  return date.format(new Date(value));
}
export function duration(seconds: number | null) {
  if (seconds === null) return "Not available";
  const value = Math.abs(Math.round(seconds));
  return `${seconds < 0 ? "−" : ""}${Math.floor(value / 60)}m ${value % 60}s`;
}
export function branch(routeId: string) {
  return routeId.replace("Green-", "Green Line · ");
}
export function ageSeconds(observedAt: string | undefined, now: number) {
  return observedAt && Number.isFinite(Date.parse(observedAt))
    ? Math.max(0, (now - Date.parse(observedAt)) / 1000)
    : Infinity;
}
