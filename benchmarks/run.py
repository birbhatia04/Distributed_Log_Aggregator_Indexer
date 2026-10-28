"""Reproducible end-to-end throughput, latency, search, and scaling benchmark."""

import argparse
import csv
import json
import math
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from uuid import uuid4

import httpx


def percentile(values, fraction):
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.ceil(fraction * len(ordered)) - 1)]


def wait_for(predicate, timeout=120):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(.2)
    raise TimeoutError('benchmark did not drain before timeout')


def set_workers(count):
    subprocess.run(
        ['docker', 'compose', 'up', '-d', '--scale', f'worker={count}', 'worker'],
        check=True,
    )


def one_run(base_url, event_count, batch_size, worker_count, timeout):
    set_workers(worker_count)
    marker = f'benchmarker{uuid4().hex}'
    with httpx.Client(base_url=base_url, timeout=20) as client:
        client.get('/api/session').raise_for_status()
        wait_for(lambda: client.get('/api/metrics').json()['active_workers'] == worker_count, timeout=30)
        payloads = [{
            'event_id': str(uuid4()), 'timestamp': datetime.now(timezone.utc).isoformat(),
            'service': 'benchmark-source', 'host': f'benchmark-{index % 8}',
            'severity': 'INFO' if index % 10 else 'ERROR',
            'message': f'{marker} measured event {index}',
            'metadata': {'benchmark': marker, 'sequence': index},
        } for index in range(event_count)]

        ingest_started = time.perf_counter()
        for offset in range(0, event_count, batch_size):
            response = client.post('/api/logs/batch', json=payloads[offset:offset + batch_size])
            response.raise_for_status()
        ingest_seconds = time.perf_counter() - ingest_started

        wait_for(
            lambda: client.get('/api/logs', params={'q': marker, 'limit': 1}).json()['total'] == event_count,
            timeout=timeout,
        )
        end_to_end_seconds = time.perf_counter() - ingest_started

        rows = []
        for page in range(1, math.ceil(event_count / 200) + 1):
            response = client.get('/api/logs', params={'q': marker, 'limit': 200, 'page': page})
            response.raise_for_status()
            rows.extend(response.json()['items'])
        indexing_ms = [
            (datetime.fromisoformat(row['indexed_at']) - datetime.fromisoformat(row['received_at'])).total_seconds() * 1000
            for row in rows
        ]
        search_latencies = []
        for _ in range(20):
            started = time.perf_counter()
            client.get('/api/logs', params={'q': marker, 'limit': 50}).raise_for_status()
            search_latencies.append((time.perf_counter() - started) * 1000)

    return {
        'workers': worker_count,
        'events': event_count,
        'batch_size': batch_size,
        'ingest_requests_per_second': round(event_count / ingest_seconds, 2),
        'indexed_events_per_second': round(event_count / end_to_end_seconds, 2),
        'end_to_end_seconds': round(end_to_end_seconds, 3),
        'index_latency_p50_ms': round(median(indexing_ms), 2),
        'index_latency_p95_ms': round(percentile(indexing_ms, .95), 2),
        'index_latency_p99_ms': round(percentile(indexing_ms, .99), 2),
        'search_latency_p50_ms': round(median(search_latencies), 2),
        'search_latency_p95_ms': round(percentile(search_latencies, .95), 2),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://localhost:8000')
    parser.add_argument('--events', type=int, default=1000)
    parser.add_argument('--batch-size', type=int, default=100)
    parser.add_argument('--worker-counts', type=int, nargs='+', default=[1, 2, 4])
    parser.add_argument('--timeout', type=int, default=120)
    parser.add_argument('--output-dir', type=Path, default=Path('benchmarks/results'))
    args = parser.parse_args()
    if args.events < 1 or not 1 <= args.batch_size <= 1000:
        parser.error('events must be positive and batch-size must be between 1 and 1000')

    results = []
    try:
        for workers in args.worker_counts:
            results.append(one_run(args.url, args.events, args.batch_size, workers, args.timeout))
            print(json.dumps(results[-1], indent=2))
    finally:
        set_workers(2)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    json_path = args.output_dir / f'benchmark-{stamp}.json'
    csv_path = args.output_dir / f'benchmark-{stamp}.csv'
    json_path.write_text(json.dumps({'generated_at': stamp, 'runs': results}, indent=2))
    with csv_path.open('w', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=results[0].keys())
        writer.writeheader()
        writer.writerows(results)
    print(f'Wrote {json_path} and {csv_path}')


if __name__ == '__main__':
    main()
