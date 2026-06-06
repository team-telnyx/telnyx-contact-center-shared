# Production diagnostics

The app writes structured JSON diagnostic logs to stdout by default. Docker logs remain the primary place to read runtime diagnostics:

```bash
sudo docker logs -f telnyx-contact-center-app
```

## Optional persistent JSONL log file

For short-lived troubleshooting sessions, especially on GMR/STT, enable a file sink through environment variables and the `/app/logs` mount from `compose.yaml`.

Host preparation:

```bash
mkdir -p /home/ubuntu/apps/logs
```

Recommended `.env` toggles for GMR STT troubleshooting:

```bash
LOG_LEVEL=debug
DEBUG_TELNYX_STT=true
LOG_FILE_PATH=/app/logs/diagnostics.jsonl
```

Read logs:

```bash
tail -f /home/ubuntu/apps/logs/diagnostics.jsonl
```

Disable after troubleshooting:

```bash
LOG_LEVEL=info
DEBUG_TELNYX_STT=false
# remove LOG_FILE_PATH or leave it unset
```

## Safety notes

- Diagnostic logs redact keys such as `Authorization`, `token`, `secret`, `password`, `api_key`.
- Telnyx media payloads/audio buffers are not written; only counters, byte sizes, tracks, states, and sanitized provider error frames are logged.
- Do not leave `DEBUG_TELNYX_STT=true` enabled permanently on busy instances; it logs first media frames and periodic counters by design.
