"""Single dedicated traffic-generator process for all active simulations."""

import asyncio
import logging
import os
import random
import time
from datetime import datetime, timezone
from uuid import uuid4

import httpx

from .core import connect_dbs, connect_redis
from .storage import execute_all
from .sessions import COOKIE, REGISTRY, SESSION_TTL, active_sessions, key

logger = logging.getLogger('logweave.generator')
MAX_TOTAL_RATE = max(1, int(os.getenv('MAX_TOTAL_GENERATION_RATE', '500')))
GENERATOR_IDLE = min(SESSION_TTL, max(30, int(os.getenv('GENERATOR_IDLE_SECONDS', '120'))))

MESSAGES = {
    'auth-service': [('INFO', 'Login successful for user {n}'), ('WARN', 'Invalid credentials for user {n}'), ('WARN', 'Token expired for session {n}'), ('ERROR', 'User {n} not found')],
    'payment-service': [('INFO', 'Transaction {n} completed'), ('WARN', 'Payment timeout for transaction {n}'), ('ERROR', 'Payment failed for transaction {n}'), ('INFO', 'Refund initiated for transaction {n}')],
    'api-gateway': [('INFO', 'Request GET /api/orders/{n} completed'), ('WARN', 'Rate limit exceeded for client {n}'), ('ERROR', 'Upstream timeout for request {n}'), ('ERROR', 'Internal server error on /api/users/{n}')],
    'database-service': [('INFO', 'Query completed for shard {n}'), ('WARN', 'Slow query detected on shard {n}'), ('ERROR', 'Connection pool exhausted on shard {n}')],
    'notification-service': [('INFO', 'Email delivered to recipient {n}'), ('WARN', 'Delivery retry scheduled for recipient {n}'), ('ERROR', 'Push delivery failed for recipient {n}')],
}


def make_log():
    service = random.choice(list(MESSAGES))
    severity, template = random.choice(MESSAGES[service])
    n = random.randint(1000, 9999)
    return {
        'event_id': str(uuid4()), 'timestamp': datetime.now(timezone.utc).isoformat(),
        'service': service, 'host': f'{service}-{random.randint(1, 3)}',
        'severity': severity, 'message': template.format(n=n),
        'trace_id': uuid4().hex[:16], 'metadata': {'environment': 'demo', 'request_id': n},
    }


async def send_batch(client, redis, ingest_url, session_id, count):
    try:
        response = await client.post(
            ingest_url + '/batch', json=[make_log() for _ in range(count)],
            cookies={COOKIE: session_id},
        )
        response.raise_for_status()
    except Exception as exc:
        await redis.set(key(session_id, 'generator:last_error'), str(exc)[:250], ex=60)


async def cleanup_expired(redis, pools):
    expired = await redis.zrangebyscore(REGISTRY, '-inf', time.time() - SESSION_TTL)
    for session_id in expired:
        # Expired entries are already excluded from generation and worker reads.
        # Keep the registry entry until cleanup succeeds so failures can retry.
        await execute_all(pools, 'DELETE FROM log_events WHERE session_id=$1', session_id)
        keys = [name async for name in redis.scan_iter(match=key(session_id, '*'))]
        if keys:
            await redis.delete(*keys)
        await redis.zrem(REGISTRY, session_id)
    retention_days = max(1, int(os.getenv('RETENTION_DAYS', '7')))
    await execute_all(
        pools,
        "DELETE FROM log_events WHERE indexed_at < now() - ($1 * interval '1 day')",
        retention_days,
    )


async def generate(redis, ingest_url, pools):
    next_due = {}
    last_cleanup = 0.0
    async with httpx.AsyncClient(timeout=15) as client:
        while True:
            now = time.monotonic()
            if now - last_cleanup > 60:
                try:
                    await cleanup_expired(redis, pools)
                except Exception:
                    logger.exception('Expired-session cleanup failed')
                last_cleanup = now
            sessions = await active_sessions(redis)
            states = await asyncio.gather(*(redis.hgetall(key(sid, 'generator:state')) for sid in sessions))
            last_seen = await asyncio.gather(*(redis.zscore(REGISTRY, sid) for sid in sessions))
            for session_id, state, seen in zip(sessions, states, last_seen):
                if state.get('status') == 'running' and (seen or 0) < time.time() - GENERATOR_IDLE:
                    await redis.hset(key(session_id, 'generator:state'), 'status', 'stopped')
                    state['status'] = 'stopped'
            running = [
                (sid, state, max(1, min(500, int(state.get('rate', 10)))))
                for sid, state in zip(sessions, states) if state.get('status') == 'running'
            ]
            total_requested = sum(rate for _, _, rate in running)
            scale = min(1.0, MAX_TOTAL_RATE / total_requested) if total_requested else 1.0
            sends = []
            for session_id, state, requested in running:
                rate = max(1, round(requested * scale))
                if now < next_due.get(session_id, 0):
                    continue
                burst = int(state.get('burst', 0))
                if burst:
                    await redis.hdel(key(session_id, 'generator:state'), 'burst')
                count = min(100, max(1, round(rate / 10)) + min(50, burst))
                sends.append(send_batch(client, redis, ingest_url, session_id, count))
                next_due[session_id] = now + count / rate
            if sends:
                await asyncio.gather(*sends)
            next_due = {sid: due for sid, due in next_due.items() if sid in sessions}
            await asyncio.sleep(.05)


async def run():
    redis = connect_redis()
    pools = await connect_dbs()
    try:
        await generate(redis, os.getenv('INGEST_URL', 'http://localhost:8000/api/logs'), pools)
    finally:
        await asyncio.gather(*(pool.close() for pool in pools))
        await redis.aclose()


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run())
