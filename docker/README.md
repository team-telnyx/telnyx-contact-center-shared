# Telnyx Contact Center — Docker Deployment

This directory contains everything needed to deploy the Telnyx Contact Center on a single machine using Docker containers.

## Architecture

The Docker setup runs two containers:

- **PostgreSQL 17** — database with a persistent volume
- **Next.js application** — production build of the Contact Center

Both containers are defined in `docker/production/compose.yaml` and managed by the `deploy.sh` script.

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
docker compose -f docker/production/compose.yaml ps
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

## Manual Deployment

If you prefer to run Docker Compose directly:

```bash
cd docker/production

# Build and start
docker compose up --build -d

# Check logs
docker compose logs -f

# Stop
docker compose down
```

## Database Schema & Seeding

The application automatically creates all database tables on startup via `yarn ensure:pg`. The schema includes:

- **Core**: `users`, `domains`, `app_settings`, `skills`
- **Contact Center**: `cc_queues`, `cc_interactions`, `cc_agent_state`, `cc_queue_state`
- **Voice Flows**: `voice_flows`, `voice_flow_phone_numbers`, `voice_flow_executions`
- **Authentication**: `auth_users`, `auth_accounts`, `auth_sessions` (NextAuth.js)

Seeding is **idempotent** — running it multiple times will not create duplicates.

## Health Checks

Both containers have Docker health checks configured:

| Service | Check | Interval |
|---|---|---|
| PostgreSQL | `pg_isready` | 10s |
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
6. Ensure all `NEXT_PUBLIC_*` variables are consistent across nodes (they are compiled into the browser bundle at build time)
7. Store recordings, uploads, and media in S3-compatible object storage shared across nodes

The app is designed to be stateless or near-stateless — in-memory state is periodically synced to PostgreSQL, so individual nodes can be replaced without data loss.

## Troubleshooting

### Permission denied: Cannot connect to Docker daemon

```bash
sudo usermod -aG docker $USER
# Log out and log back in
```

### PostgreSQL is not responding

```bash
docker compose -f docker/production/compose.yaml logs postgres
docker compose -f docker/production/compose.yaml restart postgres
```

### App container fails to start

```bash
docker compose -f docker/production/compose.yaml logs app
```

Common issues:
- Missing required environment variables in `.env`
- PostgreSQL not ready before app starts (health check will retry)
- Invalid `TELNYX_API_KEY` or `TELNYX_CALL_CONTROL_ID`
