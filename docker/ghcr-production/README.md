# GHCR prebuilt-image deployment

This folder is the new deployment path for testing/prod rollout with prebuilt Docker images from GitHub Container Registry.

The legacy deployment remains untouched:

- legacy Dockerfile/compose: `docker/production/`
- legacy script: `docker/deploy.sh`

## Why this exists

The legacy container builds the Next.js app during EC2 container startup. That can cause RAM spikes/OOM on small instances. This deployment uses images built by GitHub Actions, so EC2 only pulls and starts an already-built image.

## Files

- `Dockerfile` — multi-stage image; runs `yarn build` during image build, not startup.
- `start-prod.sh` — runtime startup only: wait for Postgres, run schema ensure, start Next.js.
- `compose.yaml` — pulls `${APP_IMAGE}` from GHCR; no `build:` block.
- `deploy-ghcr.sh` — pulls a selected tag/image and starts the app with `--no-build`.
- `init-schema.sql` — copy/symlink from legacy production deployment before first use.

## GitHub Actions / GHCR image tags

The workflow publishes images to:

```text
ghcr.io/team-telnyx/telnyx-contact-center
```

Expected tags include:

```text
latest
master
sha-<full_commit_sha>
```

Prefer deploying an explicit `sha-...` tag to production rather than `latest`.

## First-time setup on EC2

From the repo root on EC2:

```bash
mkdir -p docker/ghcr-production
cp docker/production/.env docker/ghcr-production/.env
cp docker/production/init-schema.sql docker/ghcr-production/init-schema.sql
```

For a production cutover that reuses the existing legacy Postgres volume, set `POSTGRES_VOLUME` in `docker/ghcr-production/.env` to the existing Docker volume name.

Find the legacy volume with:

```bash
docker volume ls | grep postgres
```

Common legacy name is often:

```dotenv
POSTGRES_VOLUME=production_postgres_data
```

For side-by-side testing, use separate ports and a separate volume instead:

```dotenv
COMPOSE_PROJECT_NAME=telnyx-contact-center-ghcr-test
APP_PUBLISHED_PORT=3100
STREAMING_PUBLISHED_PORT=3101
POSTGRES_PUBLISHED_PORT=55432
POSTGRES_VOLUME=telnyx-contact-center-ghcr-test-postgres-data
MEDIA_DIR=/home/ubuntu/apps/media-ghcr-test
```

## Deploy a selected build

Deploy a specific image tag:

```bash
cd docker/ghcr-production
./deploy-ghcr.sh sha-73db2ca0b44f96edbeedb1b00f3c7d037dde6455
```

Or pass a full image ref:

```bash
./deploy-ghcr.sh ghcr.io/team-telnyx/telnyx-contact-center:sha-73db2ca0b44f96edbeedb1b00f3c7d037dde6455
```

## Rollback

Deploy the previous known-good SHA tag:

```bash
./deploy-ghcr.sh sha-<previous_full_commit_sha>
```

## Verification

```bash
docker compose ps
docker compose logs app --tail=100
curl -f http://localhost:${APP_PUBLISHED_PORT:-3000}/api/health
```

## Important safety notes

- This deployment path never runs `docker compose up --build` on EC2.
- This deployment path never deletes volumes.
- Do not use the legacy `./deploy.sh production --fresh` on production unless you explicitly intend to recreate the database.
- Production rollout should be a deliberate pull/start of a selected image tag; GitHub Actions building images does not deploy production by itself.
