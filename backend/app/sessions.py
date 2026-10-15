"""Anonymous, server-owned simulation sessions.

The cookie is an unguessable capability. Only sessions registered in Redis are
accepted, so supplying an arbitrary cookie cannot access another simulation.
"""

import os
import re
import secrets
import time

COOKIE = 'logweave_session'
REGISTRY = 'sessions:active'
SESSION_TTL = max(300, int(os.getenv('SESSION_TTL_SECONDS', '3600')))
MAX_ACTIVE_SESSIONS = max(1, int(os.getenv('MAX_ACTIVE_SESSIONS', '50')))
SESSION_PATTERN = re.compile(r'^[0-9a-f]{32}$')


def key(session_id: str, name: str) -> str:
    return f'session:{session_id}:{name}'


def stream(session_id: str) -> str:
    return key(session_id, 'events')


def dead_letter(session_id: str) -> str:
    return key(session_id, 'dead-letter')


async def active_sessions(redis) -> list[str]:
    return await redis.zrangebyscore(REGISTRY, time.time() - SESSION_TTL, '+inf')


async def valid_session(redis, session_id: str | None) -> bool:
    if not session_id or not SESSION_PATTERN.fullmatch(session_id):
        return False
    last_seen = await redis.zscore(REGISTRY, session_id)
    return last_seen is not None and last_seen > time.time() - SESSION_TTL


async def touch_session(redis, session_id: str) -> None:
    await redis.zadd(REGISTRY, {session_id: time.time()})


async def create_session(redis) -> str:
    # Reserve a slot atomically so simultaneous first visits cannot exceed the
    # configured capacity. Expired sessions are cleaned by the generator.
    now = time.time()
    session_id = secrets.token_hex(16)
    reserved = await redis.eval('''
        if redis.call('ZCOUNT', KEYS[1], ARGV[1], '+inf') >= tonumber(ARGV[2]) then
            return 0
        end
        redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
        return 1
    ''', 1, REGISTRY, now - SESSION_TTL, MAX_ACTIVE_SESSIONS, now, session_id)
    if not reserved:
        raise RuntimeError('The live demo is at capacity. Please try again later.')
    return session_id
