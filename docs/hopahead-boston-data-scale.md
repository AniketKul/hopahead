# HopAhead: Boston-wide data scale and database decision

Measured November 5, 2026, 22:24–22:25 America/New_York (November 6, 03:24–03:25 UTC). Read-only live sampling. This is one minute of late-evening data, not rush-hour capacity or a database benchmark.

## Conclusion

Keep PostgreSQL as the candidate operational database for journeys, reference data, current predictions, and bounded recommendation evidence. The current prediction set is about 17,500 records; its repeated history is much larger. Store retained full-feed observations as compressed, bounded broker/archive data, not an unbounded relational JSON history. Validate PostgreSQL under the actual changed-row workload, reads, replay, WAL, and vacuum before claiming a supported capacity.

## What was measured

Enumerate the entire route catalog with `GET https://api-v3.mbta.com/routes?filter[listed_route]=false`, then call `/predictions?filter[route]=<all 404 returned IDs>&filter[revenue]=REVENUE,NON_REVENUE`. The default routes endpoint returned only 179 routes. Unfiltered predictions and route-type-only prediction requests returned HTTP 400.

No page limit was supplied. Successful responses had `data,jsonapi`, with no pagination links or `meta`. The official API pagination implementation applies pagination only when a positive limit is provided. Measurements therefore cover the requested full catalog/filter scope, not an accidentally truncated first page. Counts describe the MBTA network, which extends beyond Boston municipal boundaries.

All responses advertised an anonymous limit of 20 requests/minute; no 429 occurred. HTTP request count is not the prediction-change rate.

| Request start, UTC | Predictions | Trips | Active routes | Referenced stops | Raw JSON bytes | Gzip body bytes | Response seconds |
|---|---:|---:|---:|---:|---:|---:|---:|
| 03:24:19.841 | 17,489 | 954 | 122 | 5,013 | 10,126,783 | 581,461 | 3.503 |
| 03:24:34.846 | 17,417 | 952 | 122 | 5,011 | 10,087,328 | 578,922 | 3.261 |
| 03:24:49.846 | 17,361 | 949 | 122 | 5,008 | 10,055,876 | 577,870 | 4.592 |
| 03:25:04.846 | 17,284 | 946 | 122 | 5,004 | 10,012,489 | 574,753 | 5.401 |
| 03:25:19.845 | 17,575 | 957 | 122 | 4,987 | 10,178,977 | 582,835 | 4.395 |

Raw size is the decompressed byte count. Gzip size is the HTTP body, excluding protocol overhead. Content type was `application/vnd.api+json; charset=utf-8`. These resources are predicted stop visits for current and future trips, not vehicle arrivals or completed travel events.

HTTP Last-Modified values were 03:24:17, 03:24:27, 03:24:39, 03:25:01, and 03:25:09 UTC. Preserve source collection time separately from request/receipt time; this timestamp does not give an individual prediction's observation age.

## Net changes between samples

Canonical JSON comparison used `(type,id)` as the resource key and sorted property names. There were no duplicate resource keys. A candidate delta encoding included full added/changed resources and `{type,id}` removals; its compressed bytes were measured locally, not captured from MBTA SSE.

| Interval | Request-start interval, seconds | Added | Changed | Removed | Delta bytes | Gzipped delta bytes |
|---|---:|---:|---:|---:|---:|---:|
| 1–2 | 15.005 | 22 | 3,525 | 94 | 2,084,508 | 101,318 |
| 2–3 | 15.000 | 0 | 4,603 | 56 | 2,696,834 | 137,110 |
| 3–4 | 15.000 | 8 | 5,450 | 85 | 3,198,553 | 161,164 |
| 4–5 | 14.999 | 379 | 4,473 | 88 | 2,841,283 | 140,143 |
| Total | 60.004 | 409 | 18,051 | 323 | 10,821,178 | 539,735 |

This is approximately 313 observed resource deltas/second. Intermediate updates and updates that reverted between samples are not captured. It is not a measured upstream event rate or database-write rate; the application can batch updates and avoid unchanged rows.

Every sample contained 109 extra resources sharing `(trip,stop,stop_sequence)` with another record. Keep the provider's route-specific resource identity; the shorter compound key would collapse valid records.

## Static and other realtime data

At approximately 03:24 UTC: 384 vehicle records (378 revenue, six non-revenue) and 120 all-activity alert records, of which 82 were active according to their active periods. Uncompressed payloads were 226,805 bytes for vehicles and 390,133 bytes for alerts.

The full route catalog has 404 records, including hidden/shuttle variants; 373 bus-route records do not mean 373 simultaneously running bus routes. Static GTFS ZIP size was 22,789,743 bytes; members totaled 166,339,628 uncompressed bytes. Feed version: `Fall 2026, 2026-11-03T23:46:00+00:00, version D`, covering October 27–December 12.

| GTFS table | Records |
|---|---:|
| routes | 404 |
| stops | 10,291 |
| trips | 112,117 |
| stop_times | 2,858,761 |
| transfers | 8,735 |
| route_patterns | 1,213 |
| shapes | 389,908 |
| pathways | 9,325 |

Static counts cover a multiweek schedule, not daily realtime events. Import/version this data separately from frequent live updates.

## Retention arithmetic, not a forecast

Assume the observed late-evening average continues for 24 hours, with snapshots every 15 seconds. Units below are decimal GB/TB. These estimates cover prediction payloads only, excluding vehicles, alerts, envelopes, database rows/indexes/WAL, replicas, and backups. A broker's normalized/compressed encoding will not necessarily equal the API's gzip size.

| Representation | Per 24 hours | Per 30 days |
|---|---:|---:|
| Every full raw JSON snapshot | 58.13 GB | 1.744 TB |
| Every full gzip snapshot | 3.34 GB | 100.08 GB |
| Added/changed resources plus removals, raw | 15.58 GB | 467.44 GB |
| Same candidate delta batches, gzipped | 0.78 GB | 23.31 GB |

Saving every snapshot entity as its own history row would produce about 100.4 million rows/day under this assumption. Saving net changed-event records would produce about 27.0 million/day. Neither history cardinality is required merely to serve the current 17,500 prediction records.

## Database and broker implications

1. Use keyed, batched PostgreSQL changes for current predictions and transactional journey state. Keep source health timestamps in their own small records; updating `last_seen` on every prediction would reintroduce write amplification.
2. Keep a bounded decision history with exact evidence, configuration/transfer versions, and evaluation time. Recompute only affected journeys and deduplicate identical subscriptions; browser count must not multiply upstream ingestion.
3. Use Apache Kafka, as selected by the user, for compressed observations with explicit retention. Split compressed snapshots into chunks no larger than 256 KiB, keep each source's chunks and completion manifests on one partition, and size encoded batches within producer/broker/consumer limits. Only activate complete snapshots. Commit consumer offsets after transactional PostgreSQL effects and stable-message receipts; producer idempotence alone does not make PostgreSQL writes exactly once.
4. The first implementation can retain full compressed snapshots to keep replay reconstruction simple. Delta archival is a later optimization requiring a retained baseline. A 24-hour retention setting plus a nominal 10 GiB summed topic/partition budget is a starting configuration to test, not a guaranteed 24-hour service or a hard disk cap. Kafka's `retention.bytes` applies per partition; deletion operates on segments asynchronously and needs disk headroom. Use deletion retention, not source-key compaction, for the replay log. The [design](superpowers/specs/2026-11-05-hopahead-design.md) specifies the initial topic allocations and gap handling.
5. If month-scale citywide history becomes a requirement, use compressed immutable archive objects/segments and a query path suited to history. Add a columnar analytics database only when the actual queries justify it.
6. Benchmark original-rate captures and explicitly amplified stress loads alongside 1/100/1,000 monitored journeys and browser fan-out. Report lag, sustained throughput, p95/p99 latency, disk/WAL growth, recovery drain time, and maintenance overhead. No such database benchmark has yet run.

## Historical cross-check

The public LAMP light-rail vehicle-position export contains 1,689,548 Parquet rows in a configured seven-day window, in a 37,637,244-byte object modified November 6 at 02:16:06 UTC. This was read using HEAD plus 65,544 bytes of footer range requests; the dataset was not downloaded. It is a deduplicated light-rail subset, not raw citywide traffic, and its actual coverage boundaries were not inspected.

MBTA's LAMP architecture archives gzip JSON in S3, transforms/deduplicates it into partitioned Parquet, and loads compressed derived performance events into relational tables. This corroborates separating serving state from historical storage. It does not establish HopAhead's peak load or prove one database's capacity. Public derived daily performance files cannot substitute for a raw citywide peak measurement; comprehensive internal archive access requires credentials.

## Sources

- [API schema](https://api-v3.mbta.com/docs/swagger/swagger.json)
- [Complete route catalog](https://api-v3.mbta.com/routes?filter%5Blisted_route%5D=false)
- [Prediction filtering](https://github.com/mbta/api/blob/master/apps/api_web/lib/api_web/controllers/prediction_controller.ex)
- [Route filtering](https://github.com/mbta/api/blob/master/apps/api_web/lib/api_web/controllers/route_controller.ex)
- [Pagination implementation](https://github.com/mbta/api/blob/master/apps/state/lib/state/pagination.ex)
- [Parameter parsing](https://github.com/mbta/api/blob/master/apps/api_web/lib/api_web/params.ex)
- [Prediction identity](https://github.com/mbta/api/blob/master/apps/api_web/lib/api_web/views/prediction_view.ex)
- [Official GTFS ZIP](https://cdn.mbta.com/MBTA_GTFS.zip)
- [Apache Kafka topic limits and retention](https://kafka.apache.org/42/configuration/topic-configs/)
- [Apache Kafka delivery semantics](https://kafka.apache.org/42/design/design/)
- [PostgreSQL update overhead](https://www.postgresql.org/docs/18/storage-hot.html)
- [LAMP raw ingestion and Parquet conversion](https://github.com/mbta/lamp/blob/main/src/lamp_py/ingestion/README.md)
- [LAMP performance-event compression](https://github.com/mbta/lamp/blob/main/src/lamp_py/performance_manager/README.md#event-compression)
- [LAMP light-rail seven-day export](https://performancedata.mbta.com/lamp/tableau/gtfs-rt/LAMP_RT_VehiclePositions_ALL_LR_7_day.parquet)
- [LAMP export job](https://github.com/mbta/lamp/blob/main/src/lamp_py/tableau/jobs/lamp_jobs.py#L94-L101)
- [LAMP archive query path](https://github.com/mbta/lamp/blob/main/src/lamp_py/publishing/README.md)

Limitations: no peak-hour capture, authenticated SSE measurement, long-duration source study, database benchmark, or host-failure test. All capacity conclusions remain proposals pending those checks.
