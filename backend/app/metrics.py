import time
from .sessions import key, stream

async def mark(redis, session_id, kind, amount=1, *, timings=None):
    second = int(time.time())
    pipe = redis.pipeline()
    counter = key(session_id, f'counter:{kind}')
    rate = key(session_id, f'rate:{kind}:{second}')
    pipe.incrby(counter, amount)
    pipe.incrby(rate, amount)
    pipe.expire(rate, 300)
    if timings:
        totals = key(session_id, 'performance:totals')
        recent = key(session_id, f'performance:rate:{second}')
        for component, elapsed_ms in timings.items():
            pipe.hincrby(totals, f'{component}:count', 1)
            pipe.hincrbyfloat(totals, f'{component}:ms', elapsed_ms)
            pipe.hincrby(recent, component, 1)
        pipe.expire(recent, 300)
    await pipe.execute()


def component_performance(component, totals, recent):
    count = int(totals.get(f'{component}:count', 0))
    return {
        'indexed': count,
        'indexed_rate': int(recent.get(component, 0)),
        'average_ms': round(float(totals[f'{component}:ms']) / count, 2) if count else None,
    }


async def snapshot(redis, session_id, shard_count=0):
    now = int(time.time())
    kinds = ['received', 'indexed', 'rejected', 'errors']
    pipe = redis.pipeline()
    for kind in kinds:
        pipe.get(key(session_id, f'counter:{kind}'))
    for kind in kinds:
        pipe.get(key(session_id, f'rate:{kind}:{now - 1}'))
    pipe.xlen(stream(session_id))
    pipe.hgetall(key(session_id, 'generator:state'))
    pipe.get(key(session_id, 'workers:paused'))
    pipe.get(key(session_id, 'workers:delay_ms'))
    pipe.hgetall(key(session_id, 'performance:totals'))
    pipe.hgetall(key(session_id, f'performance:rate:{now - 1}'))
    values = await pipe.execute()
    totals, recent = values[12:14]
    heartbeats = await redis.hgetall('workers:heartbeat')
    workers = [name for name, ts in heartbeats.items() if time.time() - float(ts) < 8]
    worker_flags = await redis.mget([key(session_id, f'workers:paused:{name}') for name in workers]) if workers else []
    active_count = 0 if values[10] == '1' else sum(flag != '1' for flag in worker_flags)
    received, indexed, rejected, errors = (int(x or 0) for x in values[:4])
    rates = [int(x or 0) for x in values[4:8]]
    pending = int(values[8])
    generator = values[9]
    latency_total = float(await redis.get(key(session_id, 'processing:total_ms')) or 0)
    latency_count = int(await redis.get(key(session_id, 'processing:count')) or 0)
    return {
        'received': received, 'indexed': indexed, 'rejected': rejected, 'errors': errors,
        'received_rate': rates[0], 'indexed_rate': rates[1], 'rejected_rate': rates[2], 'error_rate': rates[3],
        'queue_depth': pending, 'indexing_lag': pending,
        'active_workers': active_count, 'workers': workers,
        'worker_paused': {name: flag == '1' for name, flag in zip(workers, worker_flags)},
        'avg_processing_ms': round(latency_total / latency_count, 1) if latency_count else 0,
        'generator': {'status': generator.get('status', 'stopped'), 'rate': int(generator.get('rate', 10))},
        'workers_paused': values[10] == '1', 'worker_delay_ms': int(values[11] or 0),
        'worker_performance': [
            {'name': name, 'paused': values[10] == '1' or flag == '1',
             **component_performance(f'worker:{name}', totals, recent)}
            for name, flag in zip(workers, worker_flags)
        ],
        'shard_performance': [
            {'shard': shard, **component_performance(f'shard:{shard}', totals, recent)}
            for shard in range(shard_count)
        ],
        'timestamp': now,
    }
