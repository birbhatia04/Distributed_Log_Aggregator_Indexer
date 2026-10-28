"""End-to-end checks against a running local Docker Compose stack.

Run with: .venv/bin/pytest tests -v
"""
import json
import os
import time
from uuid import uuid4
import httpx
import pytest
from app.schemas import LogIn
from app.sessions import COOKIE, stream

BASE = os.getenv('LOGWEAVE_TEST_URL', 'http://localhost:8000')


def wait_for(predicate, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(.25)
    pytest.fail('Timed out waiting for pipeline state')


@pytest.fixture(scope='module')
def client():
    with httpx.Client(base_url=BASE, timeout=10) as c:
        try:
            c.get('/api/health').raise_for_status()
        except Exception:
            pytest.skip('Distributed Log Aggregator & Indexer stack is not running')
        c.get('/api/session').raise_for_status()
        yield c


def test_anonymous_sessions_are_isolated(client):
    """The same event ID, controls, and reset remain private to each visitor."""
    with httpx.Client(base_url=BASE, timeout=10) as other:
        other.get('/api/session').raise_for_status()
        assert client.cookies.get(COOKIE) != other.cookies.get(COOKIE)
        event_id = str(uuid4())
        marker = uuid4().hex
        for visitor, message in ((client, 'first'), (other, 'second')):
            visitor.post('/api/logs', json={
                'event_id': event_id, 'service': 'api-gateway', 'host': 'isolation-test',
                'severity': 'INFO', 'message': f'{marker} {message}',
            }).raise_for_status()
        wait_for(lambda: client.get('/api/logs', params={'q': marker}).json()['total'] == 1)
        wait_for(lambda: other.get('/api/logs', params={'q': marker}).json()['total'] == 1)
        assert client.get(f'/api/logs/{event_id}').json()['message'] == f'{marker} first'
        assert other.get(f'/api/logs/{event_id}').json()['message'] == f'{marker} second'
        client.post('/api/workers/control', json={'paused': True}).raise_for_status()
        try:
            assert other.get('/api/metrics').json()['workers_paused'] is False
        finally:
            client.post('/api/workers/control', json={'paused': False}).raise_for_status()
        client.post('/api/demo/reset').raise_for_status()
        assert client.get('/api/logs', params={'q': marker}).json()['total'] == 0
        assert other.get('/api/logs', params={'q': marker}).json()['total'] == 1


def test_generator_only_feeds_its_own_session(client):
    with httpx.Client(base_url=BASE, timeout=10) as first, httpx.Client(base_url=BASE, timeout=10) as second:
        first.get('/api/session').raise_for_status()
        second.get('/api/session').raise_for_status()
        first.post('/api/generator/start', json={'rate': 10}).raise_for_status()
        try:
            wait_for(lambda: first.get('/api/metrics').json()['received'] > 0)
            assert second.get('/api/metrics').json()['received'] == 0
            assert second.get('/api/metrics').json()['generator']['status'] == 'stopped'
        finally:
            first.post('/api/generator/stop').raise_for_status()


def test_unknown_session_cannot_read_logs(client):
    with httpx.Client(base_url=BASE, timeout=10) as stranger:
        assert stranger.get('/api/logs').status_code == 401
        stranger.cookies.set(COOKIE, '0' * 32)
        assert stranger.get('/api/logs').status_code == 401


def test_validation_and_jsonl_errors(client):
    bad = client.post('/api/logs', json={'service':'auth-service','host':'auth-1','severity':'BOGUS','message':'x'})
    assert bad.status_code == 422
    response = client.post('/api/logs/import', files={'file':('sample.jsonl',b'not-json\n'+json.dumps({'service':'auth-service','host':'auth-1','severity':'INFO','message':'from JSONL'}).encode()+b'\n')})
    assert response.status_code == 200
    assert response.json()['accepted'] == 1
    assert response.json()['rejected'] == 1
    assert response.json()['errors'][0]['line'] == 1


def test_index_search_filter_and_idempotency(client):
    event_id = str(uuid4())
    payload = {'event_id':event_id,'service':'payment-service','host':'payments-test-1','severity':'ERROR','message':'Unique sapphire transaction timeout','trace_id':'test-trace-sapphire','metadata':{'suite':'integration'}}
    for _ in range(2):
        assert client.post('/api/logs',json=payload).status_code == 202
    def found():
        response = client.get('/api/logs',params={'q':'sapphire','service':'payment-service','severity':'ERROR','trace_id':'test-trace-sapphire'})
        response.raise_for_status()
        return response.json()['items']
    rows = wait_for(found)
    assert len([row for row in rows if row['event_id']==event_id]) == 1
    assert client.get(f'/api/logs/{event_id}').json()['message']==payload['message']
    assert client.get('/api/logs',params={'service':'auth-service','trace_id':'test-trace-sapphire'}).json()['total']==0


def test_pause_backlog_and_recovery(client):
    client.post('/api/workers/control',json={'paused':True}).raise_for_status()
    try:
        before = client.get('/api/metrics').json()['queue_depth']
        payload = [{'event_id':str(uuid4()),'service':'api-gateway','host':'gateway-test','severity':'WARN','message':'Queue recovery marker'} for _ in range(8)]
        client.post('/api/logs/batch',json=payload).raise_for_status()
        wait_for(lambda: client.get('/api/metrics').json()['queue_depth'] >= before + 8)
    finally:
        client.post('/api/workers/control',json={'paused':False}).raise_for_status()
    wait_for(lambda: client.get('/api/logs',params={'q':'recovery marker'}).json()['total'] >= 8)
    wait_for(lambda: client.get('/api/metrics').json()['queue_depth'] <= before)


def test_schema_rejects_naive_timestamp():
    with pytest.raises(Exception):
        LogIn(service='x',host='x',severity='INFO',message='x',timestamp='2026-01-01T00:00:00')


def test_abandoned_pending_message_is_reclaimed(client):
    """A fake consumer reserves an event, then real workers reclaim it after idle timeout."""
    import shutil
    import subprocess
    if not shutil.which('docker'):
        pytest.skip('Docker CLI unavailable for pending recovery test')
    event_id = str(uuid4())
    prior = client.get('/api/metrics').json()['generator']
    client.post('/api/generator/stop').raise_for_status()
    try:
        wait_for(lambda: client.get('/api/metrics').json()['queue_depth'] == 0)
        client.post('/api/workers/control', json={'paused': True}).raise_for_status()
        try:
            time.sleep(2)
            client.post('/api/logs', json={'event_id':event_id,'service':'notification-service','host':'notifications-test','severity':'INFO','message':'Abandoned pending recovery proof'}).raise_for_status()
            result = subprocess.run(['docker','compose','exec','-T','redis','redis-cli','XREADGROUP','GROUP','indexers','abandoned-test','COUNT','1','STREAMS',stream(client.cookies.get(COOKIE)),'>'],capture_output=True,text=True,check=True)
            assert event_id in result.stdout
        finally:
            client.post('/api/workers/control', json={'paused': False}).raise_for_status()
        wait_for(lambda: client.get(f'/api/logs/{event_id}').status_code == 200, timeout=20)
    finally:
        if prior['status'] == 'running':
            client.post('/api/generator/start', json={'rate':prior['rate']}).raise_for_status()
        elif prior['status'] == 'paused':
            client.post('/api/generator/pause').raise_for_status()


def test_individual_worker_control(client):
    metrics = client.get('/api/metrics').json()
    if not metrics['workers']:
        pytest.skip('No worker heartbeat yet')
    name = metrics['workers'][0]
    client.post(f'/api/workers/{name}/control', json={'paused': True}).raise_for_status()
    try:
        wait_for(lambda: client.get('/api/metrics').json()['worker_paused'].get(name) is True)
    finally:
        client.post(f'/api/workers/{name}/control', json={'paused': False}).raise_for_status()
    wait_for(lambda: client.get('/api/metrics').json()['worker_paused'].get(name) is False)


def test_frontend_proxy_reaches_backend(client):
    with httpx.Client(base_url=os.getenv('LOGWEAVE_FRONTEND_URL', 'http://localhost:5173'), timeout=10) as frontend:
        response = frontend.get('/api/system/health')
        response.raise_for_status()
        assert response.json() == {'api': True, 'redis': True, 'postgres': True}


def test_index_shards_are_healthy(client):
    response = client.get('/api/system/shards')
    response.raise_for_status()
    data = response.json()
    assert data['count'] >= 1
    assert all(shard['healthy'] for shard in data['shards'])
