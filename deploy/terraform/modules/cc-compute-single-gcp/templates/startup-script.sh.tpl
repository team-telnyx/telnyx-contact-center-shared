#!/bin/bash
set -euxo pipefail

# ---------------------------------------------------------------------------
# Telnyx Contact Center — GCP single-node app bootstrap
#
# Mirrors deploy/terraform/modules/cc-compute-single/templates/user_data.sh.tpl
# (the AWS equivalent) almost line for line: this script prepares the
# MACHINE (Docker, gcloud CLI, zstd) and fetches runtime secrets to disk. It
# deliberately does NOT start the app container itself — the first (and
# every subsequent) deploy is triggered by deploy/cli/lib/gcp-cloud.mjs over
# `gcloud compute ssh --tunnel-through-iap` once an image tarball has been
# shipped to GCS, so boot-time and update-time logic never diverge (same
# rationale as the AWS path's SSM RunCommand mechanism).
# ---------------------------------------------------------------------------

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y \
  ca-certificates curl gnupg lsb-release \
  unzip jq zstd apt-transport-https

# --- Docker ---
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable --now docker

# --- Google Cloud CLI (used by gcp-cloud.mjs's deploy script to fetch the
#     image tarball from GCS + secrets from Secret Manager). Canonical's
#     Ubuntu GCE images do NOT ship gcloud pre-installed (unlike AWS's
#     Ubuntu AMIs, which need the AWS CLI installed the same way) — install
#     from Google's own apt repo. ---
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee -a /etc/apt/sources.list.d/google-cloud-sdk.list
curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
apt-get update -y
apt-get install -y google-cloud-cli

mkdir -p /opt/cc/logs /opt/cc/releases

# python3 is NOT installed here deliberately — the GCP remote deploy script
# (deploy/cli/lib/gcp-cloud.mjs's REMOTE_DEPLOY_SCRIPT_GCP) parses
# manifest.json with `jq` (already installed above) instead of python3 (which
# the AWS path's equivalent script uses), so there is no extra dependency to
# add here.

# NOTE: single-node runs the app container directly via `docker run` (no
# compose.yaml, no Caddy) — same mechanism as the AWS path. Phase 1 has no
# HTTPS Load Balancer equivalent to AWS's ALB+ACM path yet (see
# cc-compute-single-gcp module header / gcp/single-node's `domain` variable
# doc) — the app serves plain HTTP directly on app_port/streaming_ws_port;
# the operator's own reverse proxy/CDN is responsible for HTTPS if needed.
gcloud secrets versions access latest \
  --secret="${app_env_secret_id}" \
  --project="${project_id}" > /opt/cc/app.env || true
chmod 0600 /opt/cc/app.env || true

# Storage HMAC credentials are a SEPARATE secret from app.env (see
# cc-storage-gcp module header) — fetch and fold the two STORAGE_ACCESS_KEY/
# STORAGE_SECRET_KEY fields into node.env below, same file the AWS path uses
# for its own non-secret STORAGE_* values.
HMAC_JSON="$(gcloud secrets versions access latest --secret="${storage_hmac_secret_id}" --project="${project_id}" || echo '{}')"
STORAGE_ACCESS_KEY="$(echo "$HMAC_JSON" | jq -r '.access_id // empty')"
STORAGE_SECRET_KEY="$(echo "$HMAC_JSON" | jq -r '.secret // empty')"

cat > /opt/cc/node.env <<EOF
APP_PORT=${app_port}
STREAMING_WS_PORT=${streaming_ws_port}
STORAGE_PROVIDER=s3
STORAGE_BUCKET=${storage_bucket}
STORAGE_REGION=auto
STORAGE_ENDPOINT=https://storage.googleapis.com
STORAGE_FORCE_PATH_STYLE=true
STORAGE_ACCESS_KEY=$STORAGE_ACCESS_KEY
STORAGE_SECRET_KEY=$STORAGE_SECRET_KEY
EOF
chmod 0600 /opt/cc/node.env

# --- Optional Portainer Agent (opt-in, same as the AWS path) ---
if [ "${portainer_agent_enabled}" = "true" ]; then
  DOCKER_ROOT=$(docker info --format '{{.DockerRootDir}}')
  VOLUMES_DIR="$DOCKER_ROOT/volumes"
  mkdir -p "$VOLUMES_DIR"
  docker rm -f portainer_agent || true
  docker run -d \
    --name portainer_agent \
    --restart=always \
    -p ${portainer_agent_port}:9001 \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$VOLUMES_DIR":/var/lib/docker/volumes \
    portainer/agent:lts
fi

echo "cc single-node GCP machine bootstrap complete" > /var/log/cc-bootstrap.done
