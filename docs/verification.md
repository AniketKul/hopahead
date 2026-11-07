# Verification record

Verified locally on November 6, 2026, Pacific time (November 7 UTC). This is an initial single-host release, not a production capacity certification.

## Functional checks

| Check | Result |
|---|---|
| Node unit tests | 64 passed |
| Real Kafka/PostgreSQL integration tests | 17 passed |
| GTFS import test | Passed; rejects missing/conflicting transfers and uses the published total |
| TypeScript + production Vite build | Passed |
| Playwright browser checks | 8 passed, including one real MBTA/API/outbox/Kafka/worker journey |
| Dependency audit | Zero known vulnerabilities reported at verification time |
| Docker build and six-service startup | Passed; Kafka and PostgreSQL health checks healthy |

Browser coverage includes keyboard setup, pinned incoming and outgoing trips, extra transfer time, older-revision rejection, cross-tab deletion, local stale-state aging, replay play/scrub without live writes, and a 375-pixel viewport. Screenshots, videos and traces were disabled. The seven deterministic browser tests use controlled API responses. The additional opt-in live test used the actual running Compose stack and MBTA data; service availability makes it unsuitable as a required CI check.

The first live-browser attempt found a real gap between available Red Line departures and exceeded its original 30-second test timeout. The UI correctly showed no complete predictions. With a service-appropriate observation window, the actual end-to-end journey passed. No synthetic journey was substituted for that live result.

## Failure and recovery evidence

Integration tests cover incomplete/duplicate/conflicting chunks, duplicate manifests, rollback of receipt plus effects, obsolete generations, unchanged-row write suppression, consumer checkpoint gaps, quarantine, collector ownership, command-topic recovery isolation, and heartbeats during long work. API tests cover owner-scoped command idempotency, conflicting retries, signed sessions, origin checks and concurrent SSE connection limits. Stream tests cover backpressure and bounded coalescing.

A deliberate Compose worker SIGKILL occurred after PostgreSQL recorded next offset **176**, while Kafka's consumer group still recorded **175**. The restarted worker sought the database checkpoint and advanced beyond it without duplicate receipts. The [runtime receipt](runtime-checks.json) records the timestamps and observed offsets. Consumer-group reassignment can wait for the configured **60-second session timeout** after an abrupt death; the original 45-second checker was too short. A repeated check within a 90-second observation window passed. This is evidence of eventual process recovery, not instantaneous failover.

A separate Kafka broker restart preserved its log volume and resumed ingestion beyond the previously observed offsets. Recovery temporarily accumulated tens of seconds of lag; the advice rules pause positive advice for excessive projection lag. No host failure, disk failure or multi-broker availability claim is made.

## Measurements

The source capture contained **23,033–23,087 raw citywide prediction resources**, approximately **13.3 MB JSON / 0.75 MB gzip** per snapshot. Non-revenue records were excluded from serving state. The initial live Kafka-to-PostgreSQL baseline completed about **754 ms after observation receipt**; that is one observation, not a live latency percentile.

The [projection benchmark](benchmark.json) binds measurements to input and source-file SHA-256 hashes. It used PostgreSQL 17.7 in Docker on an ARM64 macOS host with 12 logical CPUs and 36 GiB host memory, 128 MB PostgreSQL shared buffers, and 4 MB work memory. It directly exercised the production chunk/projection code in isolated schemas, with two concurrent full-state readers and two explicit checkpoint/vacuum cycles per workload.

| Short workload | Update apply p50 / p95 | Full-state read p95 / p99 | Scoped relation growth |
|---|---:|---:|---:|
| Captured Boston, ~23k rows | 661 / 819 ms | 282 / 292 ms | 35.3 MB |
| Synthetic 3×, ~69k rows | 3,142 / 3,586 ms | 1,486 / 1,636 ms | 188.5 MB |

Each workload replayed nine snapshots, giving eight update samples. The runs lasted about 9 and 40 seconds. Synthetic identities and ETAs were deliberately changed; this is not measured Boston peak traffic. Both workloads passed duplicate-redelivery, projection-count, concurrent-read and cleanup assertions. Autovacuum was enabled; it ran during the synthetic scenario but not during the short captured scenario.

Shared PostgreSQL WAL growth was approximately 126 MB and 769 MB. These numbers include other activity on the same database cluster. Peak benchmark-process RSS was approximately 707 MB and 1.14 GB, including input copies, synthetic builders and concurrent readers; it is not production worker memory. The JSON artifact provides the detailed methodology and individual samples.

After restricting serving reads to the supported rail routes, a separate Docker API smoke issued **50 `/api/board` requests at concurrency 10**: **p50 43 ms, p95 78 ms, p99 83 ms**, with no HTTP errors. This measures local board reads, not 1,000 active journey evaluations or a sustained browser-fanout limit. It ran under different conditions from the earlier exploratory API check, so no controlled speedup ratio is claimed.

## Boundaries and reproduction

- No commuter-peak capture, multi-hour soak, 1,000-watch load test, disk-exhaustion test, multi-host failure test or GPU benchmark was performed.
- The replay lab contains deterministic simulated scenarios. Live history retains bounded decision evidence; there is no arbitrary whole-city historical timeline UI in this release.
- Retained-snapshot metadata and offset-gap recovery are implemented; 24-hour raw history is not guaranteed when partition size retention removes older segments.
- The broker and database use persistent local volumes. Public hosting and operational hardening remain outside this local release.

Run `npm test`, `npm run test:integration`, `python3 -m unittest discover -s tests -p 'test_*.py'`, and `npm run build`. Run `npm run test:browser` with the app available; set `HOPAHEAD_LIVE_TEST=1` to include actual service data. Integration tests need the environment documented in the README.

For the capacity harness, provide three complete V3 citywide prediction JSON captures named `predictions-0.json` through `predictions-2.json`, then run:

```bash
node --import tsx scripts/benchmark.ts --self-check
node --import tsx scripts/benchmark.ts --input /path/to/captures > result.json
```

Set `DATABASE_URL` first. The harness creates and drops only generated benchmark schemas, but CHECKPOINT and WAL measurements operate at cluster scope. The original raw captures are not bundled; their hashes and counts are recorded, and a later live capture will produce different measurements.
