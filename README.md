# CoCreate Server Load Test

CoCreate Server Load Test is a dependency-free Node.js load generator for CoCreate Server clusters. Run it on a separate load-generator node to send HTTP/HTTPS requests, download files, and exercise CoCreate socket envelopes while the target environment independently records CPU, memory, worker, replica, and autoscaling telemetry. The client records request rate, latency, response bytes, health interruptions, socket reconnects, and failures for comparison with that server-side telemetry.

The runner uses Node.js built-ins only. It has no npm runtime dependencies, load-testing framework, or external load-test executable.

## Install on the load-generator node

Use Node.js 22.4 or newer. Clone or copy this repository onto a machine separate from the target server:

```sh
npm run setup
```

Setup writes `cocreate-server-loadtest.config.json` with mode `0600`; that file is ignored by Git. The runner uses Node's built-in `fetch`, `WebSocket`, and worker threads. No `npm install` step is required.

## Configure the target

Run `npm run setup` on the load-generator node and provide the CoCreate host, organization ID, and optional API key. The config uses the same `host`, `organization_id`, and `apikey` fields as CoCreate clients. `HOST`, `ORGANIZATION_ID`, and `API_KEY` can override local config for a run. Keep credentials on the load-generator node and out of result artifacts.

The host should be the externally reachable service hostname, for example `https://api.example.com`. The runner uses `wss` for remote hosts and puts the organization ID in the socket path.

## HTTP and file downloads

Use GET to exercise health, API, or file endpoints. The full response body is read so downloaded bytes and transfer latency are represented.

```sh
LOAD_MODE=http-get \
HTTP_URL=https://api.example.com/health \
RATE=5 DURATION_SECONDS=30 \
RESULT_FILE=results/health.json SAMPLES_FILE=results/health.jsonl \
npm run load
```

`RATE` is the total request start rate per second. HTTP POST is available for controlled test endpoints; it is blocked unless explicitly enabled:

```sh
LOAD_MODE=http-post \
HTTP_URL=https://api.example.com/test/echo \
ALLOW_HTTP_POST=YES \
BODY_JSON='{"source":"load-test","id":"{{UUID}}"}' \
RATE=2 DURATION_SECONDS=15 \
npm run load
```

`HEADERS_JSON` supplies JSON headers, `REQUEST_TIMEOUT_MS` sets the request timeout, `RESULT_FILE` saves the summary, and `SAMPLES_FILE` saves one JSONL record per request. Use disposable test data for write requests.

## CoCreate envelope and socket workload

Provide a representative CoCreate envelope in `ENVELOPE_JSON` or `ENVELOPE_FILE`. Read operations are allowed by default; other methods require `ALLOW_ENVELOPE_WRITES=YES` because they may modify stored data.

```sh
LOAD_MODE=envelope \
ENVELOPE_JSON='{"method":"object.read","array":"load-test","filter":{"query":{"status":"active"}}}' \
SOCKET_CLIENTS=4 RATE=20 DURATION_SECONDS=60 \
SERVER_SIZE=small SERVER_WORKERS=2 TEST_ENVIRONMENT=staging \
RESULT_FILE=results/read-small-2-workers.json \
npm run load
```

Each `SOCKET_CLIENTS` worker thread opens its own WebSocket connection and client ID. It sends CoCreate envelopes with the organization, socket, frame, UUID, timestamp, and optional API key fields. `RATE` is the total request rate across those clients; the runner distributes requests among them. `REQUEST_TIMEOUT_MS` bounds response waits. After a disconnect, a client retries with exponential backoff starting at `RECONNECT_DELAY_MS` (default 1 second) up to `MAX_RECONNECT_DELAY_MS` (default 10 seconds). Disconnect and reconnect timestamps are included in the result. The runner implements the small load-test transport directly so it does not pull the browser CRUD package into the generator.

Choose a query that returns a predictable, bounded amount of data. Avoid write tests against production or shared user data. The runner does not create test records or clean them up automatically.

## Scale and recovery profiles

`PROFILE_JSON` runs named phases in order. Each phase has a duration and total request rate. This allows a single run to apply a ramp, hold, burst, and cooldown profile:

```sh
PROFILE_JSON='[
  {"name":"warmup","duration":"30s","rate":1},
  {"name":"baseline","duration":"2m","rate":10},
  {"name":"scale-out","duration":"5m","rate":50},
  {"name":"cooldown","duration":"5m","rate":1}
]' \
HEALTH_URL=https://api.example.com/health \
OBSERVATION_URL=https://monitor.example.com/cocreate/summary \
MONITOR_INTERVAL_MS=5000 \
LOAD_MODE=envelope ENVELOPE_FILE=profiles/representative-read.json \
SOCKET_CLIENTS=8 RESULT_FILE=results/scale-cycle.json \
npm run load
```

`HEALTH_URL` is polled during the run to record availability and response time. `OBSERVATION_URL` is polled for JSON snapshots; its response is stored without assuming a specific cloud provider's scaling schema. These monitor requests are a small additional load and should be accounted for in interpretation. The load client records when phases ran; correlate timestamps with your independent server and autoscaler telemetry to determine scale-up delay, recovery time, scale-down timing, and interruptions.

## Reading results

The summary includes target and workload settings, generator host details, total and per-phase counts, achieved request rate, latency percentiles, response bytes, errors, health checks, and observation snapshots. Set `SAMPLES_FILE` to save per-request JSONL records for spreadsheet or analysis tools. Run the generator on a separate machine, keep its location and capacity consistent between comparisons, and check that it is not CPU or network saturated.

The command exits with status `1` if requests fail, a phase misses planned starts, or a health poll fails. The result files are written before that exit status is set, so failed runs still produce measurements.

For a minimum viable node-size baseline, compare the same workload and test location across candidate sizes. Include steady load, a controlled ramp, a burst, and cooldown. Correlate client-side results with server telemetry such as actual worker count, CPU quota, memory, event-loop delay, replicas, and database/socket/mesh metrics. Increase load in steps and stop if the target becomes unstable; capacity is the highest profile that meets the chosen latency, error, and availability criteria with headroom.

The test client records request and health failures, but it does not determine why a failure occurred or control cluster scaling. Your infrastructure telemetry remains the source for replica counts, resource usage, and scaling events.

