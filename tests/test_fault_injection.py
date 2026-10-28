"""Opt-in destructive resilience tests for the local Compose environment.

Run explicitly with LOGWEAVE_FAULT_TESTS=1. Services are restored in finally
blocks so a failed assertion does not intentionally leave the stack offline.
"""

import os
import subprocess
import time
from uuid import uuid4

import httpx
import pytest


pytestmark = pytest.mark.skipif(
    os.getenv('LOGWEAVE_FAULT_TESTS') != '1',
    reason='set LOGWEAVE_FAULT_TESTS=1 to run dependency fault injection',
)
BASE = os.getenv('LOGWEAVE_TEST_URL', 'http://localhost:8000')


def compose(*args):
    return subprocess.run(['docker', 'compose', *args], check=True, capture_output=True, text=True)


def wait_for(predicate, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = predicate()
            if value:
                return value
        except (httpx.HTTPError, KeyError):
            pass
        time.sleep(.5)
    pytest.fail('Timed out waiting for recovery')


@pytest.fixture
def client():
    with httpx.Client(base_url=BASE, timeout=5) as value:
        value.get('/api/session').raise_for_status()
        yield value


def payload(marker):
    return {
        'event_id': str(uuid4()), 'service': 'fault-test', 'host': 'fault-node',
        'severity': 'ERROR', 'message': f'{marker} durable recovery event',
    }


def test_worker_crash_preserves_backlog(client):
    marker = f'workerfault{uuid4().hex}'
    compose('stop', 'worker')
    try:
        response = client.post('/api/logs', json=payload(marker))
        response.raise_for_status()
        wait_for(lambda: client.get('/api/metrics').json()['queue_depth'] >= 1)
    finally:
        compose('up', '-d', '--scale', 'worker=2', 'worker')
    wait_for(lambda: client.get('/api/logs', params={'q': marker}).json()['total'] == 1)


def test_worker_network_partition_recovers(client):
    marker = f'networkfault{uuid4().hex}'
    compose('up', '-d', '--scale', 'worker=1', 'worker')
    container = compose('ps', '-q', 'worker').stdout.strip().splitlines()[0]
    network = subprocess.run(
        ['docker', 'inspect', '-f', '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}', container],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    subprocess.run(['docker', 'network', 'disconnect', network, container], check=True)
    try:
        client.post('/api/logs', json=payload(marker)).raise_for_status()
        wait_for(lambda: client.get('/api/metrics').json()['queue_depth'] >= 1)
    finally:
        subprocess.run(['docker', 'network', 'connect', network, container], check=True)
        compose('up', '-d', '--scale', 'worker=2', 'worker')
    wait_for(lambda: client.get('/api/logs', params={'q': marker}).json()['total'] == 1)


def test_postgres_outage_recovers_pending_event(client):
    marker = f'databasefault{uuid4().hex}'
    compose('stop', 'postgres', 'postgres-shard-1')
    try:
        client.post('/api/logs', json=payload(marker)).raise_for_status()
        time.sleep(2)
    finally:
        compose('start', 'postgres', 'postgres-shard-1')
    wait_for(lambda: client.get('/api/health').status_code == 200)
    wait_for(lambda: client.get('/api/logs', params={'q': marker}).json()['total'] == 1)


def test_redis_outage_is_visible_and_service_recovers(client):
    compose('stop', 'redis')
    try:
        wait_for(lambda: httpx.get(BASE + '/api/health', timeout=3).status_code == 503)
    finally:
        compose('start', 'redis')
    wait_for(lambda: httpx.get(BASE + '/api/health', timeout=3).status_code == 200)
