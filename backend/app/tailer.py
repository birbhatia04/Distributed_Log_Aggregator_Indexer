"""Durable log-tailing daemon that ships appended file lines to LogWeave."""

import asyncio
import json
import logging
import os
import socket
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import NAMESPACE_URL, UUID, uuid5

import httpx

logger = logging.getLogger('logweave.tailer')


@dataclass
class Checkpoint:
    device: int = 0
    inode: int = 0
    offset: int = 0


def load_checkpoint(path: Path) -> Checkpoint:
    try:
        data = json.loads(path.read_text())
        return Checkpoint(device=int(data['device']), inode=int(data['inode']), offset=int(data['offset']))
    except (FileNotFoundError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return Checkpoint()


def save_checkpoint(path: Path, checkpoint: Checkpoint) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(asdict(checkpoint), sort_keys=True))
    temporary.replace(path)


def _timestamp(value) -> str:
    if not value:
        return datetime.now(timezone.utc).isoformat()
    try:
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except (TypeError, ValueError):
        return datetime.now(timezone.utc).isoformat()
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.isoformat()


def parse_line(raw: str, *, source: str, host: str, identity: str) -> dict:
    """Normalize JSON logs and retain arbitrary fields as searchable metadata."""
    raw = raw.strip()
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        value = {'message': raw}
    if not isinstance(value, dict):
        value = {'message': raw, 'parsed_value': value}

    severity = str(value.get('severity', value.get('level', 'INFO'))).upper()
    aliases = {'WARNING': 'WARN', 'ERR': 'ERROR', 'CRITICAL': 'FATAL', 'TRACE': 'DEBUG'}
    severity = aliases.get(severity, severity)
    if severity not in {'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'}:
        severity = 'INFO'
    message = str(value.get('message', value.get('msg', raw))) or raw
    known = {'event_id', 'timestamp', 'time', 'service', 'host', 'severity', 'level', 'message', 'msg', 'trace_id', 'metadata'}
    supplied_metadata = value.get('metadata')
    metadata = dict(supplied_metadata) if isinstance(supplied_metadata, dict) else {}
    if supplied_metadata is not None and not isinstance(supplied_metadata, dict):
        metadata['original_metadata'] = supplied_metadata
    metadata.update({key: item for key, item in value.items() if key not in known})
    metadata.update({'tailed_file': source, 'tail_identity': identity})
    event_id = value.get('event_id')
    try:
        event_id = str(UUID(str(event_id))) if event_id else str(uuid5(NAMESPACE_URL, identity))
    except ValueError:
        event_id = str(uuid5(NAMESPACE_URL, identity))
    service = str(value.get('service') or os.getenv('TAIL_SERVICE', 'file-source')).strip() or 'file-source'
    event_host = str(value.get('host') or host).strip() or host
    return {
        'event_id': event_id,
        'timestamp': _timestamp(value.get('timestamp', value.get('time'))),
        'service': service[:100],
        'host': event_host[:150],
        'severity': severity,
        'message': message[:10000],
        'trace_id': str(value['trace_id'])[:128] if value.get('trace_id') else None,
        'metadata': metadata,
    }


def read_batch(log_path: Path, checkpoint: Checkpoint, batch_size: int) -> tuple[list[dict], Checkpoint]:
    stat = log_path.stat()
    rotated = checkpoint.inode and (checkpoint.inode != stat.st_ino or checkpoint.device != stat.st_dev)
    truncated = checkpoint.offset > stat.st_size
    start = 0 if rotated or truncated else checkpoint.offset
    records = []
    committed_offset = start
    with log_path.open('rb') as handle:
        handle.seek(start)
        while len(records) < batch_size:
            line_start = handle.tell()
            raw = handle.readline()
            if not raw:
                break
            if not raw.endswith(b'\n'):
                # A writer may still be appending this line. Read it next time.
                handle.seek(line_start)
                break
            committed_offset = handle.tell()
            text = raw.decode('utf-8', errors='replace').rstrip('\r\n')
            if not text:
                continue
            identity = f'{stat.st_dev}:{stat.st_ino}:{line_start}:{text}'
            records.append(parse_line(text, source=str(log_path), host=socket.gethostname(), identity=identity))
    return records, Checkpoint(device=stat.st_dev, inode=stat.st_ino, offset=committed_offset)


async def ship_forever() -> None:
    log_path = Path(os.getenv('TAIL_FILE', '/logs/application.log'))
    checkpoint_path = Path(os.getenv('TAIL_CHECKPOINT', '/state/checkpoint.json'))
    ingest_url = os.getenv('INGEST_URL', 'http://localhost:8000/api/logs')
    api_key = os.getenv('AGENT_API_KEY', '')
    batch_size = max(1, min(1000, int(os.getenv('TAIL_BATCH_SIZE', '200'))))
    poll_seconds = max(0.05, float(os.getenv('TAIL_POLL_SECONDS', '0.5')))
    backoff = 1.0
    checkpoint = load_checkpoint(checkpoint_path)
    headers = {'X-LogWeave-Agent-Key': api_key} if api_key else {}

    async with httpx.AsyncClient(timeout=15, headers=headers) as client:
        while True:
            try:
                records, next_checkpoint = read_batch(log_path, checkpoint, batch_size)
                if not records:
                    # Persist rotation/truncation even when the new file is empty.
                    if next_checkpoint != checkpoint:
                        save_checkpoint(checkpoint_path, next_checkpoint)
                        checkpoint = next_checkpoint
                    await asyncio.sleep(poll_seconds)
                    continue
                response = await client.post(ingest_url + '/batch', json=records)
                response.raise_for_status()
                # Advance only after the server accepts the complete batch.
                save_checkpoint(checkpoint_path, next_checkpoint)
                checkpoint = next_checkpoint
                backoff = 1.0
                logger.info('Shipped %d lines through byte %d', len(records), checkpoint.offset)
            except FileNotFoundError:
                await asyncio.sleep(poll_seconds)
            except (OSError, httpx.HTTPError, ValueError) as exc:
                logger.warning('Tailer retrying in %.1fs: %s', backoff, exc)
                await asyncio.sleep(backoff)
                backoff = min(30.0, backoff * 2)


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s %(message)s')
    asyncio.run(ship_forever())
