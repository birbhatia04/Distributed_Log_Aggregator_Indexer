# Tailed log source

The `tailer` service watches `application.log`. Append either plain text or a JSON object followed by a newline; accepted lines are normalized and sent through the same FastAPI → Redis Streams → worker → PostgreSQL pipeline as every other source.

Example:

```bash
printf '%s\n' '{"timestamp":"2026-10-28T10:00:00+05:30","service":"checkout","host":"checkout-1","severity":"ERROR","message":"payment timeout","trace_id":"demo-tail-1"}' >> sample-logs/application.log
```

Its byte offset is stored in the `tailer_state` Docker volume, so restarting the daemon does not resend acknowledged lines. File replacement and truncation are detected automatically.
