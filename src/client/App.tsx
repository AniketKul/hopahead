import { useEffect, useState, type FormEvent } from "react";
import { AdviceCard, History, RouteSchematic } from "./Journey.js";
import { Replay } from "./Replay.js";
import { ageSeconds, duration, time } from "./format.js";
import { useJourney } from "./useJourney.js";

export function App() {
  const live = useJourney();
  const [mode, setMode] = useState<"live" | "replay">("live");
  const [incoming, setIncoming] = useState("");
  const [extra, setExtra] = useState("0");
  const [editing, setEditing] = useState(false);
  const [formError, setFormError] = useState("");
  const journey = live.journey;
  useEffect(() => {
    if (journey) {
      setIncoming(journey.settings.incomingTripId);
      setExtra(String(journey.settings.extraTransferSeconds / 60));
    }
  }, [
    journey?.id,
    journey?.settings.incomingTripId,
    journey?.settings.extraTransferSeconds,
  ]);
  useEffect(() => {
    if (!journey && live.board?.incoming[0])
      setIncoming((previous) => previous || live.board!.incoming[0].tripId);
  }, [journey?.id, live.board?.incoming]);
  const observedAt =
    journey?.advice?.source?.observedAt ?? live.board?.source?.observedAt;
  const age = ageSeconds(observedAt, live.now);
  const stale = age >= 90;
  const options = live.board?.incoming ?? [];
  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError("");
    const minutes = Number(extra);
    if (!incoming || !Number.isFinite(minutes) || minutes < 0 || minutes > 15) {
      setFormError("Choose a departure and between 0 and 15 extra minutes.");
      return;
    }
    const sameTrip = journey?.settings.incomingTripId === incoming;
    if (
      await live.save({
        incomingTripId: incoming,
        preferredOutgoingTripId: sameTrip
          ? journey.settings.preferredOutgoingTripId
          : null,
        extraTransferSeconds: Math.round(minutes * 60),
        boarded: sameTrip ? journey.settings.boarded : false,
      })
    )
      setEditing(false);
  }
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to journey
      </a>
      <div className="app-shell">
        <header className="site-header">
          <a className="brand" href="/" aria-label="HopAhead home">
            <span className="brand-mark" aria-hidden="true">
              ↗
            </span>
            <span>
              HopAhead<span className="brand-period">.</span>
            </span>
          </a>
          <span className="city-tag">
            BOSTON <span aria-hidden="true">/</span> MBTA
          </span>
          <nav aria-label="View">
            <button
              className={mode === "live" ? "active" : ""}
              aria-pressed={mode === "live"}
              onClick={() => setMode("live")}
            >
              Live journey
            </button>
            <button
              className={mode === "replay" ? "active" : ""}
              aria-pressed={mode === "replay"}
              onClick={() => setMode("replay")}
            >
              Replay lab
            </button>
          </nav>
        </header>
        <main id="main">
          <section className="hero">
            <div>
              <span className="eyebrow">
                A little more certainty in your commute
              </span>
              <h1>
                Your next connection,
                <br />
                one step ahead.
              </h1>
              <p>
                Watch the transfer. Understand the tradeoff.
                <br className="desktop-break" /> Get to Copley with a clearer
                plan.
              </p>
            </div>
            <div className="hero-note">
              <span aria-hidden="true">↗</span>
              <p>
                One journey.
                <br />
                <strong>Every change explained.</strong>
              </p>
              <small>Harvard → Copley · First Boston corridor</small>
            </div>
          </section>
          <RouteSchematic />
          {mode === "replay" ? (
            <Replay />
          ) : (
            <>
              <div className="live-heading">
                <div>
                  <span
                    className={`connection-dot ${stale ? "stale" : ""}`}
                    aria-hidden="true"
                  />
                  <strong>
                    {stale
                      ? "Waiting for fresh predictions"
                      : "Watching Boston’s live predictions"}
                  </strong>
                </div>
                <span>
                  {Number.isFinite(age)
                    ? `Observed ${Math.floor(age)}s ago`
                    : "No observation yet"}{" "}
                  · {live.connected ? "Connected" : "Reconnecting"}
                </span>
              </div>
              {live.error && (
                <div className="error-message" role="alert">
                  <p>{live.error}</p>
                  <button
                    className="text-button"
                    onClick={() => void live.refresh()}
                  >
                    Try again
                  </button>
                </div>
              )}
              <div className="live-workspace">
                <aside className="journey-setup">
                  <span className="eyebrow">Your journey</span>
                  <h2>Make room for the transfer.</h2>
                  <p className="muted">
                    Pick the Red Line train you plan to take. We’ll keep it
                    pinned as the predictions change.
                  </p>
                  {!journey || editing ? (
                    <form onSubmit={submit}>
                      <label htmlFor="incoming">Your Red Line departure</label>
                      <select
                        id="incoming"
                        value={incoming}
                        onChange={(event) => setIncoming(event.target.value)}
                        disabled={live.loading || live.busy}
                        required
                      >
                        {!options.length && !journey && (
                          <option value="">
                            {live.loading
                              ? "Loading departures…"
                              : "No departures available"}
                          </option>
                        )}
                        {journey &&
                          !options.some(
                            (item) =>
                              item.tripId === journey.settings.incomingTripId,
                          ) && (
                            <option value={journey.settings.incomingTripId}>
                              Pinned trip · {journey.settings.incomingTripId}
                            </option>
                          )}
                        {options.map((item) => (
                          <option key={item.tripId} value={item.tripId}>
                            {time(item.departureTime)} · Park Street{" "}
                            {time(item.arrivalTime)}
                          </option>
                        ))}
                      </select>
                      <p className="field-hint">
                        Depart Harvard · arrive Park Street
                      </p>
                      <label htmlFor="extra">Extra transfer time</label>
                      <div className="number-field">
                        <input
                          id="extra"
                          type="number"
                          min="0"
                          max="15"
                          step="0.5"
                          value={extra}
                          onChange={(event) => setExtra(event.target.value)}
                          disabled={live.busy}
                          aria-describedby="extra-hint"
                        />
                        <span>minutes</span>
                      </div>
                      <p id="extra-hint" className="field-hint">
                        Add time for your own pace. The published station
                        allowance is already included.
                      </p>
                      {formError && (
                        <p role="alert" className="error-message">
                          {formError}
                        </p>
                      )}
                      <button
                        className="primary-button full-width"
                        disabled={live.busy || !incoming || live.loading}
                      >
                        {live.busy
                          ? "Saving…"
                          : journey
                            ? "Update my journey"
                            : "Watch this connection"}
                        <span aria-hidden="true"> ↗</span>
                      </button>
                      {journey && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => setEditing(false)}
                        >
                          Keep current journey
                        </button>
                      )}
                    </form>
                  ) : (
                    <div className="pinned-journey">
                      <span className="pinned-label">
                        ✓ Pinned to your train
                      </span>
                      <p>
                        <strong>Red Line · Harvard</strong>
                        <br />
                        {time(journey.advice?.incomingDeparture?.departureTime)}
                      </p>
                      <dl>
                        <div>
                          <dt>Extra transfer time</dt>
                          <dd>
                            {duration(journey.settings.extraTransferSeconds)}
                          </dd>
                        </div>
                        <div>
                          <dt>Progress</dt>
                          <dd>
                            {journey.settings.boarded
                              ? "On the Red Line"
                              : "Waiting to board"}
                          </dd>
                        </div>
                      </dl>
                      {!journey.settings.boarded && (
                        <button
                          className="secondary-button full-width"
                          onClick={() =>
                            void live.save({
                              ...journey.settings,
                              boarded: true,
                            })
                          }
                          disabled={live.busy}
                        >
                          I’m on this Red Line train
                        </button>
                      )}
                      {journey.settings.preferredOutgoingTripId && (
                        <div className="preferred-departure">
                          <p className="field-hint">
                            You’re watching a preferred Green Line departure.
                          </p>
                          <button
                            className="text-button"
                            onClick={() =>
                              void live.save({
                                ...journey.settings,
                                preferredOutgoingTripId: null,
                              })
                            }
                            disabled={live.busy}
                          >
                            Use best available connection
                          </button>
                        </div>
                      )}
                      <div className="watch-actions">
                        <button
                          className="text-button"
                          onClick={() => setEditing(true)}
                        >
                          Edit journey
                        </button>
                        <button
                          className="text-button"
                          onClick={() => void live.clear()}
                          disabled={live.busy}
                        >
                          Stop watching
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="setup-footnote">
                    <span aria-hidden="true">◎</span>
                    <p>
                      One transfer, checked end to end.
                      <br />
                      <small>All times shown in Boston time.</small>
                    </p>
                  </div>
                </aside>
                <div className="journey-result">
                  {journey?.advice ? (
                    <AdviceCard
                      advice={journey.advice}
                      now={live.now}
                      onChoose={(tripId) =>
                        void live.save({
                          ...journey.settings,
                          preferredOutgoingTripId: tripId,
                        })
                      }
                    />
                  ) : (
                    <section className="empty-journey">
                      <span className="empty-route" aria-hidden="true">
                        R <i>···↗</i> G
                      </span>
                      <span className="eyebrow">
                        Your connection, with context
                      </span>
                      <h2>
                        {journey
                          ? "Checking your connection…"
                          : options.length
                            ? "Choose your train. We’ll watch the connection."
                            : "The next journey starts here."}
                      </h2>
                      <p>
                        {journey
                          ? "Your train is pinned. We’re waiting for the next processed prediction to explain your options."
                          : options.length
                            ? "See the transfer margin, compare verified Green Line departures, and understand every recommendation."
                            : "There are no complete departure predictions for this corridor right now. The feed may be warming up or service may be between trips."}
                      </p>
                      {!journey && (
                        <button
                          className="text-button"
                          onClick={() => setMode("replay")}
                        >
                          Explore a simulated journey{" "}
                          <span aria-hidden="true">↗</span>
                        </button>
                      )}
                    </section>
                  )}
                  {journey && <History journey={journey} />}
                </div>
              </div>
            </>
          )}
        </main>
        <footer>
          <a className="footer-brand" href="/">
            HopAhead.
          </a>
          <p>Built for the moments between trains.</p>
          <span>
            Independent project · Predictions from MBTA
            <br />
            Estimates can change. Always follow station guidance.
          </span>
        </footer>
      </div>
    </>
  );
}
