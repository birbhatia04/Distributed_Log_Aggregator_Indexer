# Phase 2 benchmarks

With the Compose stack running, execute:

```bash
.venv/bin/python benchmarks/run.py --events 1000 --worker-counts 1 2 4
```

Each worker count receives a fresh anonymous session and the same workload. The runner records HTTP ingestion throughput, end-to-end indexing throughput, p50/p95/p99 queue-to-index latency, and p50/p95 search latency. It restores two workers and writes timestamped JSON and CSV files under `benchmarks/results/`.

Run on an otherwise idle machine and record CPU, memory, Docker version, and machine model alongside submitted results. Repeat at least three times before making a scaling claim.
