# Distributed Log Aggregator & Indexer system design

## Problem and objectives

Application logs spread across services are difficult to search and reason about. The Distributed Log Aggregator & Indexer centralizes structured events, buffers bursty traffic, indexes with multiple processes, and exposes search and measured operating state. The classroom objective is to demonstrate queue growth, worker failure, recovery, and scaling with real infrastructure.

## Functional and non-functional requirements

The system ingests one event or a batch, validates structure, reports JSONL import errors, queues accepted events, indexes them idempotently, supports filtered full-text search, and exposes live metrics and controls. It favors clear failure behavior, reproducibility, local resource use, and maintainable modules over maximum throughput. No benchmark claim is made.

## High-level architecture

```mermaid
flowchart LR
  A[Five log sources] --> B[FastAPI ingestion]
  B --> C[(Redis Stream)]
  C --> D[Indexer worker replicas]
  D --> E[(PostgreSQL log_events)]
  E --> F[FastAPI search]
  F --> G[React dashboard]
  C --> H[Redis metrics and controls]
  H --> G
```

The generator runs as one dedicated process and posts to the ingestion HTTP route with the visitor's anonymous session cookie. Each visitor has a separate Redis stream and controls; every PostgreSQL query is scoped to that session. Indexers are separate containers and consumer names. Compose starts two; more can be added with `--scale worker=N`.

## Log ingestion sequence

```mermaid
sequenceDiagram
  participant S as Source or generator
  participant A as FastAPI
  participant R as Redis Stream
  S->>A: POST /api/logs or /batch
  A->>A: Pydantic validation and received_at
  alt valid and queue below limit
    A->>R: XADD event JSON
    R-->>A: stream ID
    A-->>S: 202 accepted + event IDs
  else malformed or queue full
    A-->>S: 422 or 429 with reason
  end
```

## Log indexing sequence

```mermaid
sequenceDiagram
  participant R as Redis consumer group
  participant W as Indexer worker
  participant P as PostgreSQL
  W->>R: XREADGROUP batch or XAUTOCLAIM idle pending
  R-->>W: Event and stream ID
  W->>W: Validate queued event
  alt valid
    W->>P: INSERT ... ON CONFLICT DO NOTHING
    P-->>W: committed
    W->>R: XACK then XDEL
  else permanently malformed
    W->>R: XADD dead-letter with reason
    W->>R: XACK then XDEL
  end
```

## Failure and recovery

```mermaid
flowchart TD
  A[Worker paused or crashes] --> B[New entries stay in stream]
  B --> C[Queue depth grows]
  C --> D[Worker resumes or replica starts]
  D --> E[XREADGROUP new entries]
  D --> F[XAUTOCLAIM abandoned pending after 5s]
  E --> G[Idempotent PostgreSQL insert]
  F --> G
  G --> H[XACK and XDEL]
  H --> I[Backlog drains and logs are searchable]
```

## Data model and indexing

`log_events` has UUID `event_id` as primary key; event timestamp, service, host, severity, message, trace ID, JSONB metadata, received time, indexed time, and generated `search_vector`. B-tree indexes cover time, `(service,time)`, `(severity,time)`, and non-null trace ID. GIN indexes `search_vector`. Search combines optional filters with `AND`, orders by timestamp descending, and uses page/limit pagination. This is simple offset pagination; keyset pagination would be preferable for very large histories.

## API design

- `POST /api/logs`, `/api/logs/batch`, `/api/logs/import`: ingestion and JSONL.
- `GET /api/logs`, `/api/logs/{event_id}`: filter and inspect events.
- `GET /api/services`, `/api/stats`: service and stored volume summaries.
- `GET /api/metrics`, `/api/metrics/stream`: current counters and SSE.
- `POST /api/generator/{start,pause,stop,burst}`: traffic controls.
- `POST /api/workers/control`, `/api/workers/{name}/control`: pause or slow consumers.
- `POST /api/demo/reset`, `/api/retention/run`: local data lifecycle.

## Delivery, fault tolerance, and consistency

Delivery is at least once. Workers acknowledge only after a successful database insert; PostgreSQL unique event IDs make repeated inserts safe. A crash before acknowledgment leaves a pending entry for `XAUTOCLAIM`. A crash after acknowledgment but before deletion can leave an acknowledged stream entry; local monitoring uses `XLEN`, so that rare orphan can overstate backlog until cleanup. API publication and its Redis metric increment are separate operations; a crash between them can slightly undercount received events. There is no atomic transaction across Redis and PostgreSQL. Search reflects committed rows, so it is eventually consistent with ingestion.

Backpressure uses a maximum stream length of 100,000; requests receive 429 above that threshold. Unexpected processing exceptions leave entries pending and count errors. Permanently malformed queued records go to a dead-letter stream. Redis AOF `everysec` and PostgreSQL volumes persist local state across container restarts.

## Scaling and trade-offs

More consumer replicas can improve throughput while PostgreSQL and CPU allow. A per-event insert and acknowledgment keep behavior easy to teach but cost throughput. A single Redis stream and PostgreSQL table suit a laptop; partitioning, bulk inserts, stronger rate accounting, authentication, and a production metrics stack would be future steps. The injected delay is a real delay in worker processing; it is a failure experiment control rather than a simulated metric.
