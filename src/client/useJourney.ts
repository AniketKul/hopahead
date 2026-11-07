import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BoardResponse,
  JourneySettings,
  JourneyView,
} from "../shared/contracts.js";

export async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    signal: AbortSignal.timeout(12_000),
    headers: {
      ...init.headers,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : `The request could not finish (${response.status}). Please try again.`,
    );
  }
  return response.status === 204 ? (null as T) : response.json();
}

export function useJourney() {
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [journey, setJourney] = useState<JourneyView | null>(null);
  const current = useRef<JourneyView | null>(null);
  const command = useRef(0);
  const mutating = useRef(false);
  const closed = useRef(new Set<string>());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  const skew = useRef<number | null>(null);
  const accept = useCallback(
    (next: JourneyView | null, allowReplace = false) => {
      const old = current.current;
      if (
        !allowReplace &&
        (!next || !old || next.id !== old.id || next.revision < old.revision)
      )
        return;
      if (next && closed.current.has(next.id)) return;
      if (old && next?.id === old.id && next.revision < old.revision) return;
      if (old && next?.id !== old.id) {
        closed.current.add(old.id);
        if (closed.current.size > 32)
          closed.current.delete(closed.current.values().next().value!);
      }
      current.current = next;
      setJourney(next);
    },
    [],
  );
  const refresh = useCallback(async () => {
    const started = command.current;
    try {
      const next = await request<BoardResponse>("/api/board");
      setBoard(next);
      if (skew.current === null)
        skew.current = Date.parse(next.serverTime) - Date.now();
      if (!mutating.current && started === command.current)
        accept(next.journey, true);
      setError("");
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setLoading(false);
    }
  }, [accept]);

  useEffect(() => {
    let stopped = false;
    let stream: EventSource | undefined;
    const connect = () => {
      if (stopped || stream) return;
      stream = new EventSource("/api/events");
      stream.onopen = () => {
        setConnected(true);
        const started = command.current;
        void request<JourneyView | null>("/api/journey")
          .then((next) => {
            if (!stopped && !mutating.current && started === command.current)
              accept(next, true);
          })
          .catch(() => setConnected(false));
      };
      stream.onerror = () => setConnected(false);
      stream.addEventListener("journey", (event) => {
        try {
          if (!mutating.current)
            accept(JSON.parse((event as MessageEvent).data), true);
        } catch {
          setConnected(false);
        }
      });
    };
    // Establish the signed session before opening another request that can set its cookie.
    void refresh().then((ok) => {
      if (ok) connect();
    });
    const poll = setInterval(() => {
      void refresh().then((ok) => {
        if (ok) connect();
      });
    }, 15_000);
    const clock = setInterval(
      () => setNow(Date.now() + (skew.current ?? 0)),
      1000,
    );
    return () => {
      stopped = true;
      stream?.close();
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [accept, refresh]);

  async function save(settings: JourneySettings) {
    command.current += 1;
    mutating.current = true;
    setBusy(true);
    setError("");
    try {
      accept(
        await request<JourneyView>("/api/journey", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify(settings),
        }),
        true,
      );
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      command.current += 1;
      mutating.current = false;
      setBusy(false);
    }
  }
  async function clear() {
    command.current += 1;
    mutating.current = true;
    setBusy(true);
    setError("");
    try {
      await request("/api/journey", { method: "DELETE" });
      accept(null, true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      command.current += 1;
      mutating.current = false;
      setBusy(false);
    }
  }
  return {
    board,
    journey,
    error,
    busy,
    loading,
    connected,
    now,
    save,
    clear,
    refresh,
  };
}
