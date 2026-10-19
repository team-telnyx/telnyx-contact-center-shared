# Telnyx Contact Center — Docker Deployment

This directory contains everything needed to deploy the Telnyx Contact Center on a single machine using Docker containers.

## Architecture

The Docker setup runs two containers:

- **PostgreSQL 17** — database with a persistent volume
- **Next.js application** — production build of the Contact Center, including the integrated Video AI runtime and its Chromium/FFmpeg dependencies

Both containers are defined in `docker/production/compose.yaml` and managed by the `deploy.sh` script. Local installs also apply `compose.local.yaml`, which publishes PostgreSQL only on loopback.

## Quick Start

### Prerequisites

- Docker Engine (20+) and Docker Compose V2
- A Telnyx account with:
  - An API key
  - A Call Control Application
  - The webhook URL configured to point to your server

### 1. Configure environment

```bash
cp docker/production/sample.env docker/production/.env
```

Edit `docker/production/.env` with your actual values:

| Variable | Description |
|---|---|
| `POSTGRES_PASSWORD` | Secure password for the database |
| `TELNYX_API_KEY` | Your Telnyx API key |
| `TELNYX_CALL_CONTROL_ID` | Your Telnyx Call Control Application ID |
| `TELNYX_WEBHOOK_SECRET` | Telnyx webhook verification secret |
| `NEXTAUTH_SECRET` | Random string (min 32 chars) for session signing |
| `NEXTAUTH_URL` | Your public URL (e.g. `https://cc.example.com`) |
| `DEFAULT_OWNER_EMAIL` | Initial admin user email |
| `DEFAULT_OWNER_PASSWORD` | Initial admin password (change after first login) |
| `ALLOWED_EMAIL_DOMAINS` | Comma-separated allowed email domains for registration |

### 2. Deploy

```bash
chmod +x docker/deploy.sh
./docker/deploy.sh production
```

The script will:
1. Build the Docker image from `docker/production/Dockerfile`
2. Start PostgreSQL and the app container
3. Wait for health checks
4. Run database schema initialization automatically on first start

### 3. Verify

```bash
# Application health
curl http://localhost:3000/api/health

# Container status
docker compose -f docker/production/compose.yaml -f docker/production/compose.local.yaml ps
```

## Deployment Modes

### Normal deploy (preserves database)

```bash
./docker/deploy.sh production
```

Stops and rebuilds only the app container. Database data is preserved.

### Fresh deploy (recreates database)

```bash
./docker/deploy.sh production --fresh
```

Removes all containers and volumes, recreating the database from scratch. **This deletes all data.**

### Audit and repair a legacy Telnyx Credential Connection

Credential Connections created before the deploy wizard may have a null
`sip_uri_calling_preference`, which can cause SIP transfers to fail with a 403
reported as `user_busy`. Audit the connection configured in
`docker/production/.env` without changing it:

```bash
./docker/deploy.sh production --audit-telnyx-credentials
```

The command uses `TELNYX_API_KEY` and `TELNYX_SIP_CONNECTION_ID` from `.env`.
Exit status `0` means the connection already uses `unrestricted`; status `2`
means a repair is required. To inspect a different, explicitly scoped
connection:

```bash
./docker/deploy.sh production --audit-telnyx-credentials --connection-id <connection-id>
```

centrally managed installations can read their existing environment file directly;
secrets do not need to be copied into the repository:

```bash
./docker/deploy.sh production --audit-telnyx-credentials \
  --env-file /opt/cc-prod/app.env
```

Repair first displays the current value, asks for confirmation, PATCHes only
`sip_uri_calling_preference`, and verifies the value with a fresh GET:

```bash
./docker/deploy.sh production --repair-telnyx-credentials
```

For an explicitly approved non-interactive maintenance job, add `--yes`. The
command never scans or changes every Credential Connection in the Telnyx
account; it operates only on the configured or explicitly supplied ID.

## Manual Deployment

If you prefer to run Docker Compose directly:

```bash
cd docker/production

# Build and start, including bundled PostgreSQL
docker compose --profile with-pg -f compose.yaml -f compose.local.yaml up --build -d

# Check logs
docker compose -f compose.yaml -f compose.local.yaml logs -f

# Stop
docker compose -f compose.yaml -f compose.local.yaml down
```

Omit `--profile with-pg` only when the environment points to an existing PostgreSQL server.

## Video AI and Vision

Use the **[deployment and activation guide](../deploy/README.md#video-ai-and-vision)** after the base application is running. Video AI runs inside the app deployment; it does not add another service container.

The current Compose definition already applies:

- `security_opt: seccomp=./chromium-seccomp.json` for sandboxed Chromium;
- `stop_grace_period: 60s` for media cleanup before shutdown;
- a private persistent volume at `/app/.data/video-recordings` (`CC_VIDEO_RECORDINGS_PATH` can select an existing host path).

On a single host, leave `VIDEO_AI_EXTERNAL_WORKER` and `VIDEO_AI_CONTROL_URL` unset,
use the normal app launcher, and do not set `VIDEO_CONFERENCE_AI_ENABLED` or
`VIDEO_VISION_ENABLED` to `false`. PostgreSQL and `TELNYX_API_KEY` remain required.
No additional Video AI enablement flag is needed with these defaults.

For an **existing installation**, retain the current `.env` and private recordings,
update the checkout including its Compose files, and run the normal
`./docker/deploy.sh production`. If recordings previously lived only inside the
container, copy them to persistent storage before mounting over that directory.
An image-only upgrade or container restart does not apply missing security options
or mounts. Custom container deployments must follow the guide's
[migration instructions](../deploy/README.md#video-ai-and-vision)
and store those options in their deployment mechanism for later updates and rollbacks.

Then configure the assistant, Video-enabled fallback queue, Vision mode and allowed
sources in **Admin → Web Widgets → Video**, and **Publish**. Run the guide's
[live verification checklist](../deploy/README.md#video-ai-and-vision)
in a new call. `/api/health` alone does not establish Video AI readiness.

## Database Schema & Seeding

The application automatically creates all database tables on startup via `yarn ensure:pg`. The schema includes:

- **Core**: `users`, `domains`, `app_settings`, `skills`
- **Contact Center**: `cc_queues`, `cc_queue_user_assignments`, and the Core `acd_*` lifecycle, capacity, artifact, and stream tables
- **Voice Flows**: `voice_flows`, `voice_flow_phone_numbers`, `voice_flow_executions`
- **Authentication**: `auth_users`, `auth_accounts`, `auth_sessions` (NextAuth.js)

Seeding is **idempotent** — running it multiple times will not create duplicates.

## Health Checks

Both containers have Docker health checks configured:

| Service | Check | Interval |
|---|---|---|
| PostgreSQL | Authenticated `SELECT 1` over TCP/SCRAM | 10s |
| Application | `GET /api/health` | 30s |

## Logs

```bash
# All services
docker compose -f docker/production/compose.yaml logs -f

# App only
docker compose -f docker/production/compose.yaml logs -f app

# PostgreSQL only
docker compose -f docker/production/compose.yaml logs -f postgres
```

## Streaming WebSocket (optional)

The app starts a streaming WebSocket server on `STREAMING_WS_PORT` (defaults to `PORT + 1`, normally `3001`). This is needed for:

- AI assistant streaming
- Telnyx STT (Speech-to-Text) streaming
- Hardphone bridge

Expose port `3001` through your reverse proxy and set `WS_BASE_URL` to the public `wss://` URL in `.env`.

## High Availability

For high-availability deployments with multiple application nodes behind a load balancer:

1. Use a managed PostgreSQL instance (e.g. AWS RDS Multi-AZ, Google Cloud SQL HA)
2. Run the app container on at least two nodes in different availability zones
3. Terminate TLS at the load balancer
4. Use `/api/health` as the health check endpoint
5. Increase the load balancer idle timeout to ~300 seconds for SSE and WebSocket connections
6. Ensure all `NEXT_PUBLIC_*` variables, plus `GOOGLE_MAPS_KEY`, are consistent across nodes (they are compiled into the browser bundle at build time)
7. Use shared storage for artifacts that must be read across nodes. Video AI fallback compositions specifically require the same private shared filesystem mounted on every reader/compositor; S3-compatible object storage is not a substitute for this mount.

Video AI owns live media connections and uses PostgreSQL leases to coordinate workers.
Follow the [HA prerequisites](../deploy/README.md#video-ai-and-vision)
for per-node private relay addresses, security-group connectivity and shared storage.
The HA wizard disables Video AI until these prerequisites are explicitly configured.
Allow graceful shutdown and verify session recovery and recording playback during
your rollout; web health alone does not validate the media path.

## Troubleshooting

### Video assistant service is unavailable

Check application logs for `video_ai_runtime_error` and for
`video_ai_runtime_state` reaching `ready`. `No usable sandbox!` after an image-only
upgrade usually means the app container lacks the checked-in seccomp policy.
Recreate it through the updated deployment definition; do not disable Chromium's
sandbox. See the [activation troubleshooting table](../deploy/README.md#video-ai-and-vision)
for feature flags, capacity, assistant/profile validation and Vision consent.

### Permission denied: Cannot connect to Docker daemon

```bash
sudo usermod -aG docker $USER
# Log out and log back in
```

### PostgreSQL is not responding

```bash
docker compose -f docker/production/compose.yaml -f docker/production/compose.local.yaml logs postgres
docker compose -f docker/production/compose.yaml -f docker/production/compose.local.yaml restart postgres
```

### App container fails to start

```bash
docker compose -f docker/production/compose.yaml -f docker/production/compose.local.yaml logs app
```

Common issues:
- Missing required environment variables in `.env`
- PostgreSQL not ready before app starts (health check will retry)
- Invalid `TELNYX_API_KEY` or `TELNYX_CALL_CONTROL_ID`
