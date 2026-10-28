import json
from uuid import UUID

from app.tailer import Checkpoint, load_checkpoint, parse_line, read_batch, save_checkpoint


def test_json_and_plaintext_are_normalized():
    structured = parse_line(
        json.dumps({'time': '2026-01-01T10:00:00Z', 'level': 'warning', 'msg': 'slow request', 'duration_ms': 91}),
        source='/logs/app.log', host='node-a', identity='one',
    )
    assert structured['severity'] == 'WARN'
    assert structured['message'] == 'slow request'
    assert structured['metadata']['duration_ms'] == 91
    plain = parse_line('plain application output', source='/logs/app.log', host='node-a', identity='two')
    assert plain['message'] == 'plain application output'
    assert plain['host'] == 'node-a'
    assert plain['event_id'] != structured['event_id']


def test_bad_source_fields_do_not_poison_the_tailer():
    record = parse_line(
        json.dumps({'timestamp': 'not-a-time', 'event_id': 'not-a-uuid', 'metadata': 'legacy', 'message': 'kept'}),
        source='/logs/app.log', host='node-a', identity='bad-fields',
    )
    assert record['message'] == 'kept'
    assert record['metadata']['original_metadata'] == 'legacy'
    assert UUID(record['event_id'])


def test_checkpoint_advances_only_over_complete_lines(tmp_path):
    log = tmp_path / 'application.log'
    log.write_bytes(b'first\nsecond')
    records, checkpoint = read_batch(log, Checkpoint(), 100)
    assert [record['message'] for record in records] == ['first']
    assert checkpoint.offset == len(b'first\n')
    log.write_bytes(b'first\nsecond\n')
    records, checkpoint = read_batch(log, checkpoint, 100)
    assert [record['message'] for record in records] == ['second']


def test_truncation_and_rotation_restart_at_zero(tmp_path):
    log = tmp_path / 'application.log'
    log.write_text('old line\n')
    _, checkpoint = read_batch(log, Checkpoint(), 100)
    log.write_text('new\n')
    records, checkpoint = read_batch(log, checkpoint, 100)
    assert [record['message'] for record in records] == ['new']

    rotated = tmp_path / 'application.log.1'
    log.rename(rotated)
    log.write_text('after rotation\n')
    records, checkpoint = read_batch(log, checkpoint, 100)
    assert [record['message'] for record in records] == ['after rotation']


def test_checkpoint_round_trip(tmp_path):
    path = tmp_path / 'state' / 'checkpoint.json'
    expected = Checkpoint(device=4, inode=9, offset=123)
    save_checkpoint(path, expected)
    assert load_checkpoint(path) == expected
