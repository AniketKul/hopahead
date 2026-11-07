import { useEffect, useState } from "react";
import { evaluate } from "../domain/advice.js";
import type { ReplayScenario } from "../shared/contracts.js";
import { AdviceCard } from "./Journey.js";
import { request } from "./useJourney.js";
import { timestamp } from "./format.js";

export function Replay() {
  const [scenarios, setScenarios] = useState<ReplayScenario[]>([]);
  const [selected, setSelected] = useState("");
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    request<ReplayScenario[]>("/api/replay")
      .then((data) => {
        if (current) {
          setScenarios(data);
          setSelected(data[0]?.id ?? "");
        }
      })
      .catch((err) => {
        if (current) setError(err.message);
      });
    return () => {
      current = false;
    };
  }, []);
  const scenario = scenarios.find((item) => item.id === selected);
  const frame = scenario?.frames[position];
  useEffect(() => {
    if (!playing || !scenario) return;
    const timer = setInterval(() => {
      setPosition((previous) => {
        const next = Math.min(previous + 1, scenario.frames.length - 1);
        if (next === scenario.frames.length - 1) setPlaying(false);
        return next;
      });
    }, 1500);
    return () => clearInterval(timer);
  }, [playing, scenario]);
  return (
    <div className="replay-workspace">
      <section className="replay-controls" aria-labelledby="replay-heading">
        <div>
          <span className="eyebrow">Replay lab</span>
          <h2 id="replay-heading">See why the advice changes.</h2>
          <p>
            Walk through a disruption, one observation at a time. The same
            connection rules power live advice and these recorded scenarios.
          </p>
        </div>
        <p className="simulation-notice">
          Simulated journey · never changes your live watch
        </p>
        {error && (
          <p role="alert" className="error-message">
            Replay could not load: {error}
          </p>
        )}
        {!scenario && !error && <p role="status">Loading replay scenarios…</p>}
        {scenario && (
          <>
            <label htmlFor="scenario">Disruption scenario</label>
            <select
              id="scenario"
              value={selected}
              onChange={(event) => {
                setSelected(event.target.value);
                setPosition(0);
                setPlaying(false);
              }}
            >
              {scenarios.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <p className="scenario-description">{scenario.description}</p>
            <div className="replay-buttons">
              <button
                className="primary-button"
                onClick={() => {
                  if (position === scenario.frames.length - 1) setPosition(0);
                  setPlaying((value) => !value);
                }}
                aria-label={playing ? "Pause replay" : "Play replay"}
              >
                {playing ? "Ⅱ Pause" : "▷ Play"}
              </button>
              <button
                className="secondary-button"
                onClick={() => {
                  setPlaying(false);
                  setPosition(0);
                }}
                aria-label="Restart replay"
              >
                ↶ Restart
              </button>
            </div>
            <label htmlFor="replay-position">
              Replay position{" "}
              <span>
                {position + 1} / {scenario.frames.length}
              </span>
            </label>
            <input
              id="replay-position"
              type="range"
              min={0}
              max={scenario.frames.length - 1}
              value={position}
              onChange={(event) => {
                setPosition(Number(event.target.value));
                setPlaying(false);
              }}
              aria-valuetext={frame?.label}
            />
            <div className="replay-frame">
              <span className="eyebrow">Snapshot {position + 1}</span>
              <h3>{frame?.label}</h3>
              {frame && (
                <time dateTime={frame.input.evaluatedAt}>
                  {timestamp(frame.input.evaluatedAt)}
                </time>
              )}
            </div>
          </>
        )}
      </section>
      <div className="replay-result">
        {frame && (
          <AdviceCard
            advice={evaluate(frame.input)}
            now={Date.parse(frame.input.evaluatedAt)}
            replay
          />
        )}
      </div>
    </div>
  );
}
