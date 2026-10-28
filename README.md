# Distributed Log Aggregator & Indexer

A distributed log aggregator and indexer for a local system design demonstration. A durable file-tailing daemon and synthetic sources send logs through a real FastAPI → Redis Streams → independent worker → sharded PostgreSQL pipeline before the React UI can search them.

## Quick start

```bash
cp .env.example .env
docker compose up --build
```

Open the [Distributed Log Aggregator & Indexer](http://localhost:5173) and the [API documentation](http://localhost:8000/docs). Start traffic in **System lab**. The default Compose configuration starts two indexer replicas and one dedicated traffic generator. Each browser gets its own anonymous simulation; no account is required.

## Demonstrate failure and recovery

1. Start traffic at 50 logs/s. Watch the **Overview** and **Pipeline explorer**.
2. In **System lab**, pause all workers. Redis backlog rises while ingestion continues.
3. Resume workers. The backlog drains and committed logs appear in **Log explorer**.
4. Set a processing delay to create a bottleneck. Clear it to recover.
5. Scale workers with `docker compose up -d --scale worker=4 worker`. Compare measured throughput. Scale down with `docker compose up -d --scale worker=2 worker`.

The generator's Start, Pause, Stop, and Burst controls call backend endpoints. The generator process posts batches to the ingestion HTTP path using that visitor's session cookie. Redis streams, counters, and controls are separate per visitor; PostgreSQL search is filtered by session. Chart history is collected while the browser is open and is not persisted across refreshes.

## Tail a real log file

Compose starts a standalone `tailer` daemon that watches `sample-logs/application.log`. Append a complete newline-terminated JSON or plaintext record:

```bash
printf '%s\n' '{"service":"checkout","host":"checkout-1","severity":"ERROR","message":"payment timeout"}' >> sample-logs/application.log
docker compose logs -f tailer
```

The daemon reads only newly appended bytes, persists its `(device, inode, offset)` checkpoint in `tailer_state`, waits for incomplete lines, detects replacement and truncation, assigns deterministic event IDs, batches records, and retries failed requests with exponential backoff. Machine ingestion is authenticated with `AGENT_API_KEY`.

## API examples

```bash
curl -c /tmp/logweave-cookies http://localhost:8000/api/session
curl -b /tmp/logweave-cookies -X POST http://localhost:8000/api/logs -H 'Content-Type: application/json' -d '{"service":"auth-service","host":"auth-1","severity":"INFO","message":"Login successful","trace_id":"demo-42"}'
curl -b /tmp/logweave-cookies 'http://localhost:8000/api/logs?q=login&service=auth-service&limit=25'
curl -b /tmp/logweave-cookies http://localhost:8000/api/metrics
curl -b /tmp/logweave-cookies -F 'file=@sample.jsonl' http://localhost:8000/api/logs/import
```

The API accepts individual or batches of up to 1,000 structured events. Each accepted event gets an ID if omitted and a server-side received timestamp. JSONL import returns accepted and rejected counts plus line errors. Invalid HTTP requests return 422.

## Tests

```bash
# With the stack running
python3.12 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/pytest tests -v

# Frontend compile and production bundle
cd frontend && npm ci && npm test && npm run build
```

The integration tests use anonymous sessions against the running Compose services. A reset rotates only the test client's session.

Run the deliberately disruptive Phase 2 tests separately. They stop or disconnect local services and always attempt restoration:

```bash
LOGWEAVE_FAULT_TESTS=1 .venv/bin/pytest tests/test_fault_injection.py -v
```

Run the reproducible scaling benchmark:

```bash
.venv/bin/python benchmarks/run.py --events 1000 --worker-counts 1 2 4
```

## Layout

- `backend/app/main.py`: ingestion, search, metrics, controls, SSE, retention.
- `backend/app/worker.py`: consumer group processing, recovery, idempotent inserts.
- `backend/app/generator.py`: realistic traffic via ingestion HTTP.
- `backend/app/tailer.py`: durable real-file tailing, normalization, batching, and retry.
- `backend/app/storage.py`: deterministic write routing and cross-shard query fan-out.
- `frontend/src`: seven views and design tokens.
- `tests`: HTTP pipeline, tailer, fault injection, and recovery checks.
- `benchmarks`: repeatable throughput, latency, search, and worker-scaling runner.
- `docs/system-design.md`: architecture, contracts, guarantees, and Mermaid diagrams.
- `docs/phase-2.md`: implementation evidence and submission checklist.

## Configuration

`.env.example` documents database shards, Redis, tailer identity, CORS, session capacity, and retention settings. Redis AOF, both PostgreSQL shards, and tail checkpoints use named Docker volumes. Sessions expire after `SESSION_TTL_SECONDS` without activity; the generator service removes expired Redis and PostgreSQL data from every shard. The reset control starts a new private simulation. `POST /api/retention/run` deletes only the caller's old logs across all shards.

## Separate frontend and backend hosting

Deploy `frontend/` as a Vite project on Vercel (`npm run build`, output `dist`). Run the FastAPI API, **one generator process**, one or more indexer worker processes, Redis, and PostgreSQL on an always-running backend host. Set `DATABASE_URL`, `REDIS_URL`, `INGEST_URL` (the backend's private `/api/logs` URL), and the session settings on those services. `DATABASE_SHARD_URLS` is optional: when absent, the system uses `DATABASE_URL` as one shard, preserving the current Railway deployment. Set it to a comma-separated list of PostgreSQL URLs to enable distributed indexing. Set `SESSION_COOKIE_SECURE=true` for HTTPS deployment.

For a Docker host using this repository, start the backend stack with `docker compose up -d --build postgres redis backend worker generator`. Expose the API through your host's HTTPS proxy. The frontend service can remain off on that host.

The frontend uses same-origin `/api` requests and an HTTP-only session cookie. Set Vercel's `BACKEND_ORIGIN` environment variable to the public HTTPS backend origin, such as `https://api.example.com`. [`frontend/vercel.mjs`](frontend/vercel.mjs) uses it to proxy `/api` and provide the SPA fallback to `/index.html`. The rewrite keeps API calls and cookies on the frontend origin. Keep the API's `/api/metrics/stream` response unbuffered on the backend proxy. No login page is necessary.

Capacity is bounded by `MAX_ACTIVE_SESSIONS`, `MAX_SESSION_QUEUE`, and `MAX_TOTAL_GENERATION_RATE`. The generator shares its total rate budget across running simulations and stops a run after `GENERATOR_IDLE_SECONDS` without browser activity. Size the backend and set these values before public traffic.

## Limits

This is a teaching system with anonymous, unguessable session cookies rather than user accounts. Visitors cannot read or control each other's simulations, but they share the physical worker fleet and backend capacity. Run exactly one generator process; multiple generator replicas would double-generate traffic without leader election. Redis rate counters are one-second windows and history on the UI is browser-local. The Redis AOF `everysec` policy can lose up to about one second of writes on a host crash. Bulk indexing and partitioned retention would be needed for sustained production volume.

The database migration keeps pre-existing global logs under a hidden `legacy` session. New visitors begin with empty simulations, and normal retention removes the older data.

## Inspect the actual infrastructure

```bash
docker compose exec redis redis-cli ZRANGE sessions:active 0 -1
# Replace SESSION_ID with an ID from the preceding command:
docker compose exec redis redis-cli XLEN session:SESSION_ID:events
docker compose exec redis redis-cli XINFO GROUPS session:SESSION_ID:events
docker compose exec postgres psql -U logweave -d logweave -c 'SELECT count(*) FROM log_events;'
docker compose logs -f worker
```

Run these while traffic is paused or workers are slowed to see Redis buffering. The log count in PostgreSQL increases only after workers commit events.
