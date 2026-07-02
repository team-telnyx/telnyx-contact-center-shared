#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  deploy-from-s3.sh s3://bucket/prefix/short-sha

Runs on an EC2 host. Downloads a prebuilt Docker image tarball from S3,
verifies the checksum, loads the image, recreates the app container with the
host-specific env file, and rolls back to the previously recorded image if the
new container fails health checks.

Environment overrides:
  APP_NAME                 default: telnyx-contact-center
  CONTAINER_NAME           default: $APP_NAME
  ENV_FILE                 default: /opt/$APP_NAME/app.env
  RELEASE_ROOT             default: /opt/$APP_NAME/releases
  CURRENT_IMAGE_FILE       default: /opt/$APP_NAME/current-image
  HEALTH_URL               default: http://127.0.0.1:3000/api/health
  HEALTH_ATTEMPTS          default: 30
  HEALTH_INTERVAL_SECONDS  default: 2
  HOST_APP_PORT            default: 3000
  CONTAINER_APP_PORT       default: 3000
  HOST_WS_PORT             default: 3001
  CONTAINER_WS_PORT        default: 3001
  MEDIA_DIR                optional host dir to bind to /app/public/media
  LOG_DIR                  optional host dir to bind to /app/logs

By default this script does not create legacy /home/ubuntu/apps bind mounts.
Use MEDIA_DIR/LOG_DIR only for deployments that intentionally need host-backed
local filesystem media or log files. S3-backed media/log archive deployments
should leave both unset.
  DOCKER_NETWORK           optional existing Docker network
  EXTRA_DOCKER_ARGS        optional extra args appended before image name
USAGE
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

ARTIFACT_PREFIX="${1:-}"
if [ -z "$ARTIFACT_PREFIX" ]; then
  usage >&2
  exit 2
fi

if [[ "$ARTIFACT_PREFIX" != s3://* ]]; then
  echo "Artifact prefix must be an s3:// URI, got: $ARTIFACT_PREFIX" >&2
  exit 2
fi

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 127
  fi
}

require aws
require docker
require zstd
require python3
require sha256sum
require curl

APP_NAME="${APP_NAME:-telnyx-contact-center}"
CONTAINER_NAME="${CONTAINER_NAME:-$APP_NAME}"
ENV_FILE="${ENV_FILE:-/opt/$APP_NAME/app.env}"
RELEASE_ROOT="${RELEASE_ROOT:-/opt/$APP_NAME/releases}"
CURRENT_IMAGE_FILE="${CURRENT_IMAGE_FILE:-/opt/$APP_NAME/current-image}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-2}"
HOST_APP_PORT="${HOST_APP_PORT:-3000}"
CONTAINER_APP_PORT="${CONTAINER_APP_PORT:-3000}"
HOST_WS_PORT="${HOST_WS_PORT:-3001}"
CONTAINER_WS_PORT="${CONTAINER_WS_PORT:-3001}"
MEDIA_DIR="${MEDIA_DIR:-}"
LOG_DIR="${LOG_DIR:-}"
DOCKER_NETWORK="${DOCKER_NETWORK:-}"
EXTRA_DOCKER_ARGS="${EXTRA_DOCKER_ARGS:-}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Env file not found: $ENV_FILE" >&2
  exit 3
fi

release_id="$(basename "$ARTIFACT_PREFIX")"
if [ -z "$release_id" ] || [ "$release_id" = "/" ]; then
  release_id="$(date -u +%Y%m%d%H%M%S)"
fi
release_dir="$RELEASE_ROOT/$release_id"
mkdir -p "$release_dir" "$(dirname "$CURRENT_IMAGE_FILE")"
cd "$release_dir"

echo "Downloading artifact from $ARTIFACT_PREFIX"
aws s3 cp "$ARTIFACT_PREFIX/manifest.json" manifest.json --only-show-errors
aws s3 cp "$ARTIFACT_PREFIX/image.tar.zst" image.tar.zst --only-show-errors
aws s3 cp "$ARTIFACT_PREFIX/image.tar.zst.sha256" image.tar.zst.sha256 --only-show-errors

echo "Verifying image checksum"
sha256sum -c image.tar.zst.sha256

IMAGE_NAME="$(python3 - <<'PY'
import json
with open('manifest.json', 'r', encoding='utf-8') as f:
    print(json.load(f)['image'])
PY
)"

if [ -z "$IMAGE_NAME" ]; then
  echo "manifest.json does not contain an image name" >&2
  exit 4
fi

previous_image=""
if [ -f "$CURRENT_IMAGE_FILE" ]; then
  previous_image="$(tr -d '\n' < "$CURRENT_IMAGE_FILE")"
fi

run_container() {
  local image="$1"
  local -a args
  args=(
    run -d
    --name "$CONTAINER_NAME"
    --restart unless-stopped
    --env-file "$ENV_FILE"
    -p "$HOST_APP_PORT:$CONTAINER_APP_PORT"
    -p "$HOST_WS_PORT:$CONTAINER_WS_PORT"
  )

  if [ -n "$DOCKER_NETWORK" ]; then
    args+=(--network "$DOCKER_NETWORK")
  fi

  if [ -n "$MEDIA_DIR" ]; then
    mkdir -p "$MEDIA_DIR"
    args+=(-v "$MEDIA_DIR:/app/public/media")
  fi

  if [ -n "$LOG_DIR" ]; then
    mkdir -p "$LOG_DIR"
    args+=(-v "$LOG_DIR:/app/logs")
  fi

  if [ -n "$EXTRA_DOCKER_ARGS" ]; then
    # Intentionally split operator-provided extra docker args.
    # shellcheck disable=SC2206
    local extra=( $EXTRA_DOCKER_ARGS )
    args+=("${extra[@]}")
  fi

  args+=("$image")
  docker "${args[@]}"
}

wait_for_health() {
  local attempt
  for attempt in $(seq 1 "$HEALTH_ATTEMPTS"); do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null; then
      return 0
    fi
    echo "Health check not ready ($attempt/$HEALTH_ATTEMPTS): $HEALTH_URL"
    sleep "$HEALTH_INTERVAL_SECONDS"
  done
  return 1
}

rollback() {
  if [ -z "$previous_image" ]; then
    echo "No previous image recorded; cannot auto-rollback." >&2
    return 1
  fi

  echo "Rolling back to previous image: $previous_image" >&2
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  run_container "$previous_image"
  wait_for_health
}

echo "Loading Docker image: $IMAGE_NAME"
zstd -dc image.tar.zst | docker load

echo "Recreating container $CONTAINER_NAME with $IMAGE_NAME"
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
if ! run_container "$IMAGE_NAME"; then
  echo "New image failed to start: $IMAGE_NAME" >&2
  rollback || true
  exit 5
fi

if ! wait_for_health; then
  echo "New image failed health checks: $IMAGE_NAME" >&2
  rollback || true
  exit 5
fi

echo "$IMAGE_NAME" > "$CURRENT_IMAGE_FILE"
echo "DEPLOY_OK image=$IMAGE_NAME previous=${previous_image:-none} artifact=$ARTIFACT_PREFIX"
