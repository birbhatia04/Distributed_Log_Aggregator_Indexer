"""Run the API, two indexers, and demo generator in one Render web service."""

import os
import signal
import subprocess
import sys
import time


def main():
    port = int(os.environ.get('PORT', '10000'))
    env = {**os.environ, 'INGEST_URL': f'http://127.0.0.1:{port}/api/logs'}
    commands = [
        ('API', ['uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', str(port)]),
        ('indexer 1', ['app.worker']),
        ('indexer 2', ['app.worker']),
        ('generator', ['app.generator']),
    ]
    children = []
    stopping = False

    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        for name, args in commands:
            if stopping:
                break
            children.append((name, subprocess.Popen([sys.executable, '-m', *args], env=env)))
        while not stopping:
            for name, child in children:
                code = child.poll()
                if code is not None:
                    print(f'{name} exited unexpectedly (status {code})', file=sys.stderr, flush=True)
                    return 1
            time.sleep(0.25)
        return 0
    finally:
        for _, child in children:
            if child.poll() is None:
                child.terminate()
        deadline = time.monotonic() + 8
        for _, child in children:
            try:
                child.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


if __name__ == '__main__':
    sys.exit(main())
