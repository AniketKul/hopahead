import type {
  Advice,
  AdviceStatus,
  ConnectionOption,
  DecisionRecord,
  JourneyView,
} from "../shared/contracts.js";
import {
  ageSeconds,
  branch,
  duration,
  statusLabels,
  time,
  timestamp,
} from "./format.js";

export function RouteSchematic() {
  return (
    <div
      className="route-schematic"
      aria-label="Journey: Harvard, Red Line southbound to Park Street, transfer to a Green Line westbound train serving Copley"
    >
      <div className="station">
        <span className="station-dot red" />
        <strong>Harvard</strong>
        <small>Red Line southbound</small>
      </div>
      <div className="rail red-rail" aria-hidden="true">
        <span>R</span>
      </div>
      <div className="station transfer-station">
        <span className="station-dot transfer" />
        <strong>Park Street</strong>
        <small>Make your connection</small>
      </div>
      <div className="rail green-rail" aria-hidden="true">
        <span>G</span>
      </div>
      <div className="station">
        <span className="station-dot green" />
        <strong>Copley</strong>
        <small>Green Line westbound</small>
      </div>
    </div>
  );
}

function Option({
  option,
  stale,
  onChoose,
}: {
  option: ConnectionOption;
  stale: boolean;
  onChoose?: (tripId: string) => void;
}) {
  const status = stale ? "stale" : option.status;
  return (
    <article className="alternative">
      <div className="alternative-top">
        <span className="line-pill">{branch(option.routeId)}</span>
        <span className={`status-text ${status}`}>{statusLabels[status]}</span>
      </div>
      <div className="alternative-times">
        <div>
          <small>Park Street</small>
          <strong>{time(option.departureTime)}</strong>
        </div>
        <span aria-hidden="true">→</span>
        <div>
          <small>Copley</small>
          <strong>{time(option.arrivalTime)}</strong>
        </div>
      </div>
      <p>
        {stale
          ? "This estimate is aging. Wait for refreshed predictions before relying on it."
          : option.explanation}
      </p>
      {!stale && (
        <p className="muted">
          Transfer margin: {duration(option.marginSeconds)}
        </p>
      )}
      {onChoose && (
        <button
          className="text-button"
          onClick={() => onChoose(option.tripId)}
          disabled={
            stale ||
            !["enough_time", "tight", "insufficient_time"].includes(
              option.status,
            )
          }
        >
          Watch this departure <span aria-hidden="true">↗</span>
        </button>
      )}
    </article>
  );
}

export function AdviceCard({
  advice,
  now,
  replay = false,
  onChoose,
}: {
  advice: Advice;
  now: number;
  replay?: boolean;
  onChoose?: (tripId: string) => void;
}) {
  const locallyStale =
    !replay && ageSeconds(advice.source?.observedAt, now) >= 90;
  const stale = locallyStale || advice.status === "stale";
  const status: AdviceStatus = stale ? "stale" : advice.status;
  const option = advice.selected;
  const headline = locallyStale
    ? "Live predictions are stale"
    : advice.headline;
  const explanation = locallyStale
    ? "We have not received a recent prediction snapshot. These times are retained for context, but we cannot recommend this connection until data recovers."
    : advice.explanation;
  return (
    <>
      <section
        className={`advice-card ${status}`}
        aria-labelledby={replay ? "replay-advice-title" : "advice-title"}
      >
        <div className="advice-heading">
          <span className="eyebrow">
            {replay
              ? "At this moment in the replay"
              : "Your connection outlook"}
          </span>
          <span className={`status-pill ${status}`}>
            {statusLabels[status]}
          </span>
        </div>
        <h2
          id={replay ? "replay-advice-title" : "advice-title"}
          aria-live="polite"
          aria-atomic="true"
        >
          {headline}
        </h2>
        <p className="advice-explanation">{explanation}</p>
        <div className="connection-times">
          <div>
            <span className="time-label">
              <span className="mini-dot red" /> Arrive at Park Street
            </span>
            <strong>{time(advice.incoming?.arrivalTime)}</strong>
            <small>Your pinned Red Line trip</small>
          </div>
          <div className="transfer-indicator" aria-hidden="true">
            ↝
          </div>
          <div>
            <span className="time-label">
              <span className="mini-dot green" /> Leave Park Street
            </span>
            <strong>{time(option?.departureTime)}</strong>
            <small>
              {option
                ? branch(option.routeId)
                : "Waiting for a verified connection"}
            </small>
          </div>
        </div>
        <div className="margin-strip">
          <div>
            <small>Beyond your transfer allowance</small>
            <strong>
              {stale
                ? "Needs fresh data"
                : duration(option?.marginSeconds ?? null)}
            </strong>
          </div>
          <div>
            <small>Transfer allowance</small>
            <strong>
              {option ? duration(option.transferSeconds) : "Not available"}
            </strong>
          </div>
          <div>
            <small>Reach Copley</small>
            <strong>{time(option?.arrivalTime)}</strong>
          </div>
        </div>
        <p className="fine-print">
          Planning estimates, not a guarantee. The allowance includes the
          published transfer buffer plus your extra time.
        </p>
      </section>
      {advice.alerts.length > 0 && (
        <section className="alerts" aria-label="Relevant service alerts">
          {advice.alerts.map((alert) => (
            <details key={alert.id}>
              <summary>
                <span aria-hidden="true">!</span> {alert.header}
              </summary>
              <p>{alert.description}</p>
              <small>
                Service notice ·{" "}
                {alert.effect.replaceAll("_", " ").toLowerCase()}
              </small>
            </details>
          ))}
        </section>
      )}
      <section
        className="alternatives-section"
        aria-labelledby={replay ? "replay-alternatives" : "alternatives"}
      >
        <div className="section-heading">
          <h3 id={replay ? "replay-alternatives" : "alternatives"}>
            Other ways to make the connection
          </h3>
          <span>Ranked by arrival at Copley</span>
        </div>
        {advice.alternatives.length ? (
          <div className="alternatives-grid">
            {advice.alternatives.slice(0, 2).map((item) => (
              <Option
                key={item.tripId}
                option={item}
                stale={stale}
                onChoose={onChoose}
              />
            ))}
          </div>
        ) : (
          <p className="empty-inline">
            No other verified departure is available in this snapshot. We only
            show trips with predictions at both Park Street and Copley.
          </p>
        )}
      </section>
    </>
  );
}

function Evidence({ record }: { record: DecisionRecord }) {
  const { advice, input } = record;
  return (
    <details className="history-item">
      <summary>
        <span className={`history-dot ${advice.status}`} />
        <span>
          <strong>{statusLabels[advice.status]}</strong>
          <small>{timestamp(record.createdAt)}</small>
        </span>
        <span className="history-margin">
          {duration(advice.selected?.marginSeconds ?? null)}
        </span>
      </summary>
      <div className="history-detail">
        <p>{advice.explanation}</p>
        <dl>
          <div>
            <dt>Incoming trip</dt>
            <dd>{input.settings.incomingTripId}</dd>
          </div>
          <div>
            <dt>Park Street arrival</dt>
            <dd>{time(advice.incoming?.arrivalTime)}</dd>
          </div>
          <div>
            <dt>Connecting trip</dt>
            <dd>{advice.selected?.tripId ?? "No verified trip"}</dd>
          </div>
          <div>
            <dt>Park Street departure</dt>
            <dd>{time(advice.selected?.departureTime)}</dd>
          </div>
          <div>
            <dt>Extra transfer time</dt>
            <dd>{duration(input.settings.extraTransferSeconds)}</dd>
          </div>
          <div>
            <dt>Planning allowance</dt>
            <dd>{duration(advice.selected?.transferSeconds ?? null)}</dd>
          </div>
          <div>
            <dt>Evaluated</dt>
            <dd>{timestamp(input.evaluatedAt)}</dd>
          </div>
          <div>
            <dt>Rules / transfer data</dt>
            <dd>
              {advice.ruleVersion} / {advice.transferVersion}
            </dd>
          </div>
        </dl>
        <details>
          <summary>Inspect the exact decision evidence</summary>
          <pre tabIndex={0}>{JSON.stringify(input, null, 2)}</pre>
        </details>
      </div>
    </details>
  );
}

export function History({ journey }: { journey: JourneyView }) {
  return (
    <section className="history-panel" aria-labelledby="history-heading">
      <div className="section-heading">
        <div>
          <span className="eyebrow">An explanation at every turn</span>
          <h3 id="history-heading">How your connection changed</h3>
        </div>
        <span>{journey.history.length} saved decisions</span>
      </div>
      {journey.history.length ? (
        journey.history.map((record) => (
          <Evidence key={record.id} record={record} />
        ))
      ) : (
        <p className="empty-inline">
          Material recommendation changes will appear here with the facts that
          informed them.
        </p>
      )}
    </section>
  );
}
