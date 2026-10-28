import os
from hashlib import sha256
import asyncpg
import redis.asyncio as redis
from .sessions import stream

DATABASE_URL = os.getenv('DATABASE_URL', 'postgresql://logweave:logweave_local@localhost:5432/logweave')
REDIS_URL = os.getenv('REDIS_URL', 'redis://localhost:6379/0')
GROUP = 'indexers'

async def connect_db():
    return await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=10)


def database_urls() -> list[str]:
    """Return configured index shards, retaining DATABASE_URL compatibility."""
    configured = os.getenv('DATABASE_SHARD_URLS', '')
    urls = [url.strip() for url in configured.split(',') if url.strip()]
    return urls or [DATABASE_URL]


async def connect_dbs():
    pools = []
    try:
        for url in database_urls():
            pools.append(await asyncpg.create_pool(url, min_size=1, max_size=10))
        return pools
    except Exception:
        for pool in pools:
            await pool.close()
        raise


def shard_number(value, count: int) -> int:
    """Stable hash routing: the same event reaches the same configured shard."""
    digest = sha256(str(value).encode('utf-8')).digest()
    return int.from_bytes(digest[:8], 'big') % count


def shard_pool(pools, value):
    return pools[shard_number(value, len(pools))]

def connect_redis():
    return redis.from_url(REDIS_URL, decode_responses=True)

async def ensure_group(client, session_id):
    try:
        await client.xgroup_create(stream(session_id), GROUP, id='0', mkstream=True)
    except redis.ResponseError as exc:
        if 'BUSYGROUP' not in str(exc):
            raise

async def initialize_db(pool):
    async with pool.acquire() as conn:
        # API and worker replicas may start together. Serialize the one-time
        # migration from the original global event primary key.
        await conn.execute('SELECT pg_advisory_lock(51933744)')
        try:
            await _initialize_db(conn)
        finally:
            await conn.execute('SELECT pg_advisory_unlock(51933744)')


async def initialize_dbs(pools):
    for pool in pools:
        await initialize_db(pool)


async def _initialize_db(conn):
    await conn.execute('''
        CREATE TABLE IF NOT EXISTS log_events (
            session_id TEXT NOT NULL,
            event_id UUID NOT NULL,
            timestamp TIMESTAMPTZ NOT NULL,
            service TEXT NOT NULL,
            host TEXT NOT NULL,
            severity TEXT NOT NULL CHECK (severity IN ('DEBUG','INFO','WARN','ERROR','FATAL')),
            message TEXT NOT NULL,
            trace_id TEXT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            received_at TIMESTAMPTZ NOT NULL,
            indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', message)) STORED,
            PRIMARY KEY (session_id, event_id)
        );
        ALTER TABLE log_events ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'legacy';
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
            WHERE c.conrelid = 'log_events'::regclass AND c.contype = 'p' AND a.attname = 'session_id'
          ) THEN
            ALTER TABLE log_events DROP CONSTRAINT log_events_pkey;
            ALTER TABLE log_events ADD PRIMARY KEY (session_id, event_id);
          END IF;
        END $$;
        CREATE INDEX IF NOT EXISTS log_events_session_time_idx ON log_events (session_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS log_events_session_indexed_idx ON log_events (session_id, indexed_at DESC);
        CREATE INDEX IF NOT EXISTS log_events_time_idx ON log_events (timestamp DESC);
        CREATE INDEX IF NOT EXISTS log_events_service_time_idx ON log_events (service, timestamp DESC);
        CREATE INDEX IF NOT EXISTS log_events_severity_time_idx ON log_events (severity, timestamp DESC);
        CREATE INDEX IF NOT EXISTS log_events_trace_idx ON log_events (trace_id) WHERE trace_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS log_events_search_idx ON log_events USING GIN (search_vector);
        ''')
