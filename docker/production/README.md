# Production Docker Configuration

This directory contains the Docker production configuration for Telnyx Contact Center.

The standard app image includes Video AI, Chromium and FFmpeg. Start the usual
`app` service; no Video AI sidecar is required. Compose supplies Chromium's
seccomp policy and a private persistent recording volume. Custom `docker run`
deployments must pass the same policy and volume as described in
[integrated Video AI operations](../../deploy/README.md#video-ai-and-vision).

Image builds limit Next's page-generation workers to two by default so a
high-CPU Docker Desktop VM does not exhaust a smaller memory allocation.
Override with the `CC_BUILD_WORKERS` build argument when appropriate.

Word previews run inside the CC application using bundled JavaScript libraries;
no additional conversion service is required. See
chat document previews for supported formats
and preview limits.

## Files

```
docker/production/
├── Dockerfile         # Application + integrated Video AI production build
├── chromium-seccomp.json # Browser sandbox policy
├── chromium-launcher.sh # Unprivileged Chromium launch
├── compose.yaml       # Docker Compose: app + PostgreSQL
├── compose.local.yaml # Local-only loopback port for PostgreSQL
├── sample.env         # Environment variable template (copy to .env)
└── init-schema.sql    # PostgreSQL initialization script
```

## Setup

1. Copy the sample environment file and fill in your values:

```bash
cp sample.env .env
# Edit .env with your Telnyx API key, database password, and secrets
```

2. Deploy from the project root:

```bash
./docker/deploy.sh production
```

Or manually:

```bash
docker compose -f compose.yaml -f compose.local.yaml up --build -d
```

`compose.yaml` does not publish PostgreSQL. The Local override binds it only
to `127.0.0.1` and supports `POSTGRES_HOST_PORT` when a native Postgres already
uses `5432`.

## Logging

The app writes structured JSON logs to stdout. Read them with:

```bash
docker compose -f compose.yaml -f compose.local.yaml logs -f app
```

Optional log-level and file-sink configuration via environment variables:

```bash
LOG_LEVEL=info                 # trace|debug|info|warn|error|fatal
LOG_CONSOLE_PRETTY=false       # true for readable console output in dev
LOG_DIR=/app/logs              # JSONL log directory
LOG_ROTATION_MODE=daily        # daily|startup
```

For detailed deployment instructions, see [`../README.md`](../README.md).
