import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import ValidationError
from fastapi.exceptions import RequestValidationError
from .core import connect_dbs, connect_redis, initialize_dbs, ensure_group
from .schemas import LogIn, LogEvent, Severity, GeneratorConfig, WorkerConfig
from .metrics import mark, snapshot
from .sessions import COOKIE, REGISTRY, SESSION_PATTERN, SESSION_TTL, create_session, key, stream, touch_session, valid_session
from .storage import delete_count, event_by_id, search, service_summary, shard_health, stats as storage_stats

@asynccontextmanager
async def lifespan(app):
    app.state.redis = connect_redis()
    app.state.pools = await connect_dbs()
    await initialize_dbs(app.state.pools)
    yield
    await asyncio.gather(*(pool.close() for pool in app.state.pools))
    await app.state.redis.aclose()

app = FastAPI(title='Distributed Log Aggregator & Indexer API', version='1.0.0', lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=os.getenv('CORS_ORIGINS', 'http://localhost:5173').split(','), allow_methods=['*'], allow_headers=['*'])


def current_session(request: Request) -> str:
    return request.state.session_id


def set_session_cookie(response, request, session_id):
    secure = os.getenv('SESSION_COOKIE_SECURE', '').lower() == 'true' or request.url.scheme == 'https'
    response.set_cookie(COOKIE, session_id, httponly=True, secure=secure, samesite='lax', path='/api')


def private_response(response):
    response.headers['Cache-Control'] = 'private, no-store'
    return response


@app.middleware('http')
async def anonymous_session(request: Request, call_next):
    path = request.url.path
    if request.method == 'OPTIONS' or path in ('/api/health', '/api/system/health', '/api/system/shards') or not path.startswith('/api/'):
        return await call_next(request)
    redis = request.app.state.redis
    agent_key = os.getenv('AGENT_API_KEY')
    agent_session = os.getenv('AGENT_SESSION_ID')
    if agent_key and agent_session and request.headers.get('X-LogWeave-Agent-Key') == agent_key:
        if not SESSION_PATTERN.fullmatch(agent_session):
            return JSONResponse(status_code=503, content={'detail': 'AGENT_SESSION_ID must be 32 lowercase hex characters'})
        request.state.session_id = agent_session
        await touch_session(redis, agent_session)
        await ensure_group(redis, agent_session)
        return private_response(await call_next(request))
    supplied = request.cookies.get(COOKIE)
    if path == '/api/session':
        if await valid_session(redis, supplied):
            session_id = supplied
            await touch_session(redis, session_id)
        else:
            try:
                session_id = await create_session(redis)
                await ensure_group(redis, session_id)
            except RuntimeError as exc:
                return private_response(JSONResponse(status_code=503, content={'detail': str(exc)}))
            except Exception:
                if 'session_id' in locals():
                    await redis.zrem(REGISTRY, session_id)
                raise
        request.state.session_id = session_id
        response = await call_next(request)
        set_session_cookie(response, request, session_id)
        return private_response(response)
    if not await valid_session(redis, supplied):
        return private_response(JSONResponse(status_code=401, content={'detail': 'Simulation expired. Reload to start a new one.'}))
    request.state.session_id = supplied
    await touch_session(redis, supplied)
    return private_response(await call_next(request))


@app.get('/api/session')
async def session_ready():
    return {'status': 'ready'}

@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    if request.url.path.startswith('/api/logs'):
        await mark(app.state.redis, current_session(request), 'rejected')
    return JSONResponse(status_code=422, content={'detail': [{'loc': list(e['loc']), 'msg': e['msg'], 'type': e['type']} for e in exc.errors()]})

async def publish(entries: list[LogIn], session_id: str):
    if not entries:
        raise HTTPException(422, 'Batch cannot be empty')
    if len(entries) > 1000:
        raise HTTPException(413, 'Batch exceeds 1000 events')
    redis = app.state.redis
    if await redis.xlen(stream(session_id)) > int(os.getenv('MAX_SESSION_QUEUE', '10000')):
        raise HTTPException(429, 'Queue is full; retry later')
    received_at = datetime.now(timezone.utc)
    pipe = redis.pipeline()
    for entry in entries:
        event = LogEvent(**entry.model_dump(), received_at=received_at)
        pipe.xadd(stream(session_id), {'event': event.model_dump_json()})
    try:
        await pipe.execute()
    except Exception as exc:
        raise HTTPException(503, 'Queue unavailable') from exc
    await mark(redis, session_id, 'received', len(entries))
    return {'accepted': len(entries), 'event_ids': [str(e.event_id) for e in entries]}

@app.get('/api/health')
async def health():
    try:
        await app.state.redis.ping()
        for pool in app.state.pools:
            async with pool.acquire() as conn:
                await conn.fetchval('SELECT 1')
        return {'status': 'healthy'}
    except Exception as exc:
        raise HTTPException(503, 'Dependency unavailable') from exc

@app.post('/api/logs', status_code=202)
async def ingest(entry: LogIn, request: Request):
    return await publish([entry], current_session(request))

@app.post('/api/logs/batch', status_code=202)
async def ingest_batch(entries: list[LogIn], request: Request):
    return await publish(entries, current_session(request))

@app.post('/api/logs/import')
async def import_jsonl(request: Request, file: UploadFile = File(...)):
    if not file.filename or not file.filename.endswith('.jsonl'):
        raise HTTPException(415, 'Upload a .jsonl file')
    content = await file.read(5_000_001)
    if len(content) > 5_000_000:
        raise HTTPException(413, 'File exceeds 5 MB')
    entries, errors = [], []
    for line_number, line in enumerate(content.splitlines(), 1):
        if not line.strip():
            continue
        try:
            entries.append(LogIn.model_validate_json(line))
        except ValidationError as exc:
            errors.append({'line': line_number, 'error': exc.errors()[0]['msg']})
    accepted = 0
    for offset in range(0, len(entries), 1000):
        accepted += (await publish(entries[offset:offset+1000], current_session(request)))['accepted']
    if errors:
        await mark(app.state.redis, current_session(request), 'rejected', len(errors))
    return {'accepted': accepted, 'rejected': len(errors), 'errors': errors[:100]}

@app.get('/api/system/health')
async def component_health():
    redis_ok = db_ok = False
    try:
        redis_ok = bool(await app.state.redis.ping())
    except Exception:
        pass
    try:
        checks = []
        for pool in app.state.pools:
            async with pool.acquire() as conn:
                checks.append(await conn.fetchval('SELECT 1') == 1)
        db_ok = all(checks)
    except Exception:
        pass
    return {'api': True, 'redis': redis_ok, 'postgres': db_ok}

@app.get('/api/logs')
async def search_logs(
    request: Request,
    q: str | None = None, service: list[str] | None = Query(default=None), severity: Severity | None = None,
    trace_id: str | None = None, start: datetime | None = None, end: datetime | None = None,
    page: int = Query(1, ge=1), limit: int = Query(50, ge=1, le=200)
):
    conditions, args = ['session_id = $1'], [current_session(request)]
    if q:
        args.append(q)
        conditions.append(f"search_vector @@ plainto_tsquery('english', ${len(args)})")
    if service:
        args.append(service)
        conditions.append(f'service = ANY(${len(args)}::text[])')
    if severity:
        args.append(severity.value)
        conditions.append(f'severity = ${len(args)}')
    if trace_id:
        args.append(trace_id)
        conditions.append(f'trace_id = ${len(args)}')
    for name, value, operator in [('timestamp', start, '>='), ('timestamp', end, '<=')]:
        if value:
            args.append(value)
            conditions.append(f'{name} {operator} ${len(args)}')
    where = 'WHERE ' + ' AND '.join(conditions) if conditions else ''
    total, rows = await search(app.state.pools, where, args, page, limit)
    return {'items': rows, 'total': total, 'page': page, 'limit': limit}

@app.get('/api/logs/{event_id}')
async def get_event(event_id: str, request: Request):
    try:
        from uuid import UUID
        parsed = UUID(event_id)
    except ValueError:
        raise HTTPException(422, 'Invalid event ID')
    row = await event_by_id(app.state.pools, current_session(request), parsed)
    if not row:
        raise HTTPException(404, 'Event not found')
    return row

@app.get('/api/services')
async def services(request: Request):
    return await service_summary(app.state.pools, current_session(request))

@app.get('/api/stats')
async def stats(request: Request):
    return await storage_stats(app.state.pools, current_session(request))


@app.get('/api/system/shards')
async def shards():
    return {'count': len(app.state.pools), 'shards': await shard_health(app.state.pools)}

@app.get('/api/metrics')
async def metrics(request: Request):
    return await snapshot(app.state.redis, current_session(request))

@app.get('/api/metrics/stream')
async def metrics_stream(request: Request):
    session_id = current_session(request)
    async def events():
        while True:
            try:
                if not await valid_session(app.state.redis, session_id):
                    break
                yield f'data: {json.dumps(await snapshot(app.state.redis, session_id))}\n\n'
            except Exception:
                yield 'event: error\ndata: {"message":"Metrics unavailable"}\n\n'
            await asyncio.sleep(1)
    return StreamingResponse(events(), media_type='text/event-stream', headers={'Cache-Control': 'no-cache'})

@app.post('/api/generator/start')
async def start_generator(config: GeneratorConfig, request: Request):
    await app.state.redis.hset(key(current_session(request), 'generator:state'), mapping={'status': 'running', 'rate': config.rate})
    return {'status': 'running', 'rate': config.rate}

@app.post('/api/generator/pause')
async def pause_generator(request: Request):
    await app.state.redis.hset(key(current_session(request), 'generator:state'), 'status', 'paused')
    return {'status': 'paused'}

@app.post('/api/generator/stop')
async def stop_generator(request: Request):
    await app.state.redis.hset(key(current_session(request), 'generator:state'), 'status', 'stopped')
    return {'status': 'stopped'}

@app.post('/api/generator/burst')
async def burst_generator(config: GeneratorConfig, request: Request):
    await app.state.redis.hset(key(current_session(request), 'generator:state'), mapping={'status': 'running', 'burst': config.rate})
    return {'status': 'running', 'burst_rate': config.rate}

@app.post('/api/workers/control')
async def control_workers(config: WorkerConfig, request: Request):
    session_id = current_session(request)
    if config.paused is not None:
        await app.state.redis.set(key(session_id, 'workers:paused'), '1' if config.paused else '0')
    if config.delay_ms is not None:
        await app.state.redis.set(key(session_id, 'workers:delay_ms'), config.delay_ms)
    return await snapshot(app.state.redis, session_id)

@app.post('/api/workers/{name}/control')
async def control_worker(name: str, config: WorkerConfig, request: Request):
    session_id = current_session(request)
    if name not in (await snapshot(app.state.redis, session_id))['workers']:
        raise HTTPException(404, 'Worker not active')
    if config.paused is None:
        raise HTTPException(422, 'Provide paused state')
    await app.state.redis.set(key(session_id, f'workers:paused:{name}'), '1' if config.paused else '0')
    return {'worker': name, 'paused': config.paused}

@app.post('/api/demo/reset')
async def reset_demo(request: Request):
    """Rotate this visitor into a fresh simulation; other visitors are untouched."""
    redis = app.state.redis
    old_session = current_session(request)
    await redis.hset(key(old_session, 'generator:state'), 'status', 'stopped')
    await redis.zadd(REGISTRY, {old_session: time.time() - SESSION_TTL - 1})
    try:
        new_session = await create_session(redis)
        await ensure_group(redis, new_session)
    except RuntimeError as exc:
        await touch_session(redis, old_session)
        raise HTTPException(503, str(exc)) from exc
    response = JSONResponse({'status': 'reset'})
    set_session_cookie(response, request, new_session)
    return response

@app.post('/api/retention/run')
async def retention(request: Request):
    days = max(1, int(os.getenv('RETENTION_DAYS', '7')))
    deleted = await delete_count(
        app.state.pools,
        "DELETE FROM log_events WHERE session_id=$1 AND timestamp < now() - ($2 * interval '1 day')",
        current_session(request), days,
    )
    return {'deleted': deleted, 'retention_days': days}
