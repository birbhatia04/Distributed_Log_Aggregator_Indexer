"""Application-level distribution and query fan-out across PostgreSQL shards."""

import asyncio
from collections import defaultdict

from .core import shard_number


EVENT_COLUMNS = """event_id, timestamp, service, host, severity, message, trace_id,
metadata, received_at, indexed_at"""


async def search(pools, where, args, page, limit):
    """Query every shard concurrently and perform a global ordered merge."""
    wanted = page * limit

    async def one(pool):
        async with pool.acquire() as conn:
            total = await conn.fetchval(f'SELECT count(*) FROM log_events {where}', *args)
            rows = await conn.fetch(
                f'''SELECT {EVENT_COLUMNS} FROM log_events {where}
                ORDER BY timestamp DESC, event_id DESC LIMIT ${len(args) + 1}''',
                *args, wanted,
            )
        return total, [dict(row) for row in rows]

    results = await asyncio.gather(*(one(pool) for pool in pools))
    rows = [row for _, shard_rows in results for row in shard_rows]
    rows.sort(key=lambda row: (row['timestamp'], str(row['event_id'])), reverse=True)
    start = (page - 1) * limit
    return sum(total for total, _ in results), rows[start:start + limit]


async def event_by_id(pools, session_id, event_id):
    # New data has a deterministic location. Fall back to all shards so data
    # written before sharding was enabled remains readable.
    preferred = shard_number(event_id, len(pools))
    ordered = [pools[preferred], *(pool for index, pool in enumerate(pools) if index != preferred)]
    for pool in ordered:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                f'SELECT {EVENT_COLUMNS} FROM log_events WHERE session_id=$1 AND event_id=$2',
                session_id, event_id,
            )
        if row:
            return dict(row)
    return None


async def service_summary(pools, session_id):
    async def one(pool):
        async with pool.acquire() as conn:
            return await conn.fetch('''SELECT service, count(*) AS volume,
              count(*) FILTER (WHERE severity IN ('ERROR','FATAL')) AS errors,
              max(timestamp) AS last_seen FROM log_events WHERE session_id=$1
              GROUP BY service''', session_id)

    merged = {}
    for rows in await asyncio.gather(*(one(pool) for pool in pools)):
        for row in rows:
            current = merged.setdefault(row['service'], {'service': row['service'], 'volume': 0, 'errors': 0, 'last_seen': row['last_seen']})
            current['volume'] += row['volume']
            current['errors'] += row['errors']
            current['last_seen'] = max(current['last_seen'], row['last_seen'])
    return [merged[name] for name in sorted(merged)]


async def stats(pools, session_id):
    async def one(pool):
        async with pool.acquire() as conn:
            row = await conn.fetchrow('''SELECT count(*) AS stored,
              count(*) FILTER (WHERE severity IN ('ERROR','FATAL')) AS error_logs
              FROM log_events WHERE session_id=$1''', session_id)
            services = await conn.fetch('SELECT DISTINCT service FROM log_events WHERE session_id=$1', session_id)
            series = await conn.fetch('''SELECT date_trunc('minute', indexed_at) AS minute, count(*) AS indexed
              FROM log_events WHERE session_id=$1 AND indexed_at > now() - interval '60 minutes'
              GROUP BY 1''', session_id)
        return row, services, series

    stored = error_logs = 0
    active_services = set()
    series = defaultdict(int)
    for row, shard_services, shard_series in await asyncio.gather(*(one(pool) for pool in pools)):
        stored += row['stored']
        error_logs += row['error_logs']
        active_services.update(item['service'] for item in shard_services)
        for item in shard_series:
            series[item['minute']] += item['indexed']
    return {
        'stored': stored,
        'active_services': len(active_services),
        'error_logs': error_logs,
        'series': [{'minute': minute, 'indexed': series[minute]} for minute in sorted(series)],
    }


async def execute_all(pools, statement, *args):
    async def one(pool):
        async with pool.acquire() as conn:
            return await conn.execute(statement, *args)
    return await asyncio.gather(*(one(pool) for pool in pools))


async def delete_count(pools, statement, *args):
    results = await execute_all(pools, statement, *args)
    return sum(int(result.split()[-1]) for result in results)


async def shard_health(pools):
    async def one(index, pool):
        try:
            async with pool.acquire() as conn:
                count = await conn.fetchval('SELECT count(*) FROM log_events')
            return {'shard': index, 'healthy': True, 'events': count}
        except Exception:
            return {'shard': index, 'healthy': False, 'events': None}
    return await asyncio.gather(*(one(index, pool) for index, pool in enumerate(pools)))
