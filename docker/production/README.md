# Production Docker Configuration

This directory contains the Docker production configuration for Telnyx Contact Center.

## Files

```
docker/production/
├── Dockerfile         # Multi-stage production build
├── compose.yaml       # Docker Compose: app + PostgreSQL
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
docker compose up --build -d
```

## Logging

The app writes structured JSON logs to stdout. Read them with:

```bash
docker compose logs -f app
```

Optional log-level and file-sink configuration via environment variables:

```bash
LOG_LEVEL=info                 # trace|debug|info|warn|error|fatal
LOG_CONSOLE_PRETTY=false       # true for readable console output in dev
LOG_DIR=/app/logs              # JSONL log directory
LOG_ROTATION_MODE=daily        # daily|startup
```

For detailed deployment instructions, see [`../README.md`](../README.md).
