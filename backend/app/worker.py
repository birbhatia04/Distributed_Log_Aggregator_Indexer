"""Workers consume each visitor's independent Redis Stream."""

import asyncio
import json
import logging
import socket
import time
from uuid import uuid4

from pydantic import ValidationError

from .core import GROUP, connect_db, connect_redis, initialize_db
from .metrics import mark
from .schemas import LogEvent
from .sessions import active_sessions, dead_letter, key, stream

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger('logweave.worker')
NAME = f'{socket.gethostname()}-{uuid4().hex[:6]}'


async def index_one(pool, redis, session_id, message_id, fields):
    started = time.monotonic()
    stream_name = stream(session_id)
    try:
        event = LogEvent.model_validate_json(fields['event'])
    except (ValidationError, KeyError) as exc:
        await redis.xadd(dead_letter(session_id), {'original_id': message_id, 'payload': fields.get('event', ''), 'reason': str(exc)[:500]})
        await redis.xack(stream_name, GROUP, message_id)
        await redis.xdel(stream_name, message_id)
        await mark(redis, session_id, 'rejected')
        return
    try:
        delay = int(await redis.get(key(session_id, 'workers:delay_ms')) or 0)
        if delay:
            await asyncio.sleep(delay / 1000)
        async with pool.acquire() as conn:
            result = await conn.execute('''
            INSERT INTO log_events (session_id, event_id, timestamp, service, host, severity, message, trace_id, metadata, received_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
            ON CONFLICT (session_id, event_id) DO NOTHING
            ''', session_id, event.event_id, event.timestamp, event.service, event.host, event.severity.value,
            event.message, event.trace_id, json.dumps(event.metadata), event.received_at)
        # The insert commits before acknowledgment. Retries are idempotent
        # within this simulation and cannot collide with another visitor.
        await redis.xack(stream_name, GROUP, message_id)
        await redis.xdel(stream_name, message_id)
        if result == 'INSERT 0 1':
            await mark(redis, session_id, 'indexed')
        pipe = redis.pipeline()
        pipe.incrbyfloat(key(session_id, 'processing:total_ms'), (time.monotonic() - started) * 1000)
        pipe.incr(key(session_id, 'processing:count'))
        await pipe.execute()
    except Exception:
        await mark(redis, session_id, 'errors')
        logger.exception('Indexing failed for %s; message left pending', message_id)


async def session_ready(redis, session_id):
    pipe = redis.pipeline()
    pipe.get(key(session_id, 'workers:paused'))
    pipe.get(key(session_id, f'workers:paused:{NAME}'))
    flags = await pipe.execute()
    return flags == [None, None] or all(flag != '1' for flag in flags)


async def run():
    redis = connect_redis()
    pool = await connect_db()
    await initialize_db(pool)
    last_reclaim = 0.0
    try:
        while True:
            await redis.hset('workers:heartbeat', NAME, time.time())
            sessions = await active_sessions(redis)
            ready = [sid for sid in sessions if await session_ready(redis, sid)]
            if not ready:
                await asyncio.sleep(.3)
                continue
            if time.monotonic() - last_reclaim > 5:
                for session_id in ready:
                    try:
                        _, claimed, _ = await redis.xautoclaim(
                            stream(session_id), GROUP, NAME, min_idle_time=5000,
                            start_id='0-0', count=50,
                        )
                        for message_id, fields in claimed:
                            if await session_ready(redis, session_id):
                                await index_one(pool, redis, session_id, message_id, fields)
                    except Exception:
                        logger.exception('Pending recovery failed for a simulation')
                last_reclaim = time.monotonic()
            try:
                batches = await redis.xreadgroup(
                    GROUP, NAME, {stream(sid): '>' for sid in ready},
                    count=50, block=1000,
                )
                for stream_name, messages in batches:
                    session_id = stream_name.split(':')[1]
                    for message_id, fields in messages:
                        if await session_ready(redis, session_id):
                            await index_one(pool, redis, session_id, message_id, fields)
            except Exception:
                logger.exception('Worker read failed')
                await asyncio.sleep(1)
    finally:
        await pool.close()
        await redis.aclose()


if __name__ == '__main__':
    asyncio.run(run())
