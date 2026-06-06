#!/bin/bash
set -euo pipefail

# Deploy a prebuilt Telnyx Contact Center image from GHCR.
#
# Usage:
#   ./deploy-ghcr.sh [tag-or-image]
#
# Examples:
#   ./deploy-ghcr.sh latest
#   ./deploy-ghcr.sh sha-73db2ca0b44f96edbeedb1b00f3c7d037dde6455
#   ./deploy-ghcr.sh ghcr.io/team-telnyx/telnyx-contact-center:sha-73db2ca0b44f96edbeedb1b00f3c7d037dde6455
#
# Notes:
# - This script never builds on the EC2 host.
# - The legacy deployment remains in docker/production + docker/deploy.sh.
# - Do not use the legacy --fresh flow here; this script never deletes volumes.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/compose.yaml"
IMAGE_REPO="${IMAGE_REPO:-ghcr.io/team-telnyx/telnyx-contact-center}"
IMAGE_OR_TAG="${1:-${APP_IMAGE:-latest}}"

if [[ "${IMAGE_OR_TAG}" == */*:* ]]; then
  export APP_IMAGE="${IMAGE_OR_TAG}"
else
  export APP_IMAGE="${IMAGE_REPO}:${IMAGE_OR_TAG}"
fi

cd "${SCRIPT_DIR}"

if [[ ! -f .env ]]; then
  echo "❌ No .env file found in ${SCRIPT_DIR}."
  echo "   Copy the existing production .env into this directory before deploying."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "❌ Cannot connect to Docker daemon. Try running with a docker-enabled user or sudo."
  exit 1
fi

echo "🚀 Deploying prebuilt image: ${APP_IMAGE}"
echo "📥 Pulling app image..."
docker compose -f "${COMPOSE_FILE}" pull app

echo "🔁 Starting app from prebuilt image (no local build)..."
docker compose -f "${COMPOSE_FILE}" up -d --no-build app

echo "⏳ Waiting briefly for health check..."
sleep 10

echo "📊 Service status:"
docker compose -f "${COMPOSE_FILE}" ps

echo "🔍 Checking application health on published port ${APP_PUBLISHED_PORT:-3000}..."
if curl -f "http://localhost:${APP_PUBLISHED_PORT:-3000}/api/health" >/dev/null 2>&1; then
  echo "✅ Application is healthy"
else
  echo "⚠️  Application health check failed or app is still starting. Recent app logs:"
  docker compose -f "${COMPOSE_FILE}" logs app --tail=80
fi

echo "✅ Deployment command completed for ${APP_IMAGE}"
