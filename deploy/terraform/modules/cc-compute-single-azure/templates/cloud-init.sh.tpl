#!/bin/bash
set -euxo pipefail

# ---------------------------------------------------------------------------
# Telnyx Contact Center — Azure single-node app bootstrap
#
# Mirrors deploy/terraform/modules/cc-compute-single-gcp/templates/
# startup-script.sh.tpl (the GCP equivalent) closely: this script prepares
# the MACHINE (Docker, Azure CLI, jq) and fetches runtime secrets to disk.
# It deliberately does NOT start the app container itself — the first (and
# every subsequent) deploy is triggered by deploy/cli/lib/azure-cloud.mjs
# over `az vm run-command invoke` once an image tarball has been shipped to
# Blob Storage, so boot-time and update-time logic never diverge (same
# rationale as the AWS SSM / GCP IAP-SSH mechanisms).
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

# --- Azure CLI (used by azure-cloud.mjs's deploy script to fetch the image
#     tarball from Blob Storage + secrets from Key Vault). Canonical's
#     Ubuntu Azure VM images do NOT ship az pre-installed — install from
#     Microsoft's own apt repo, same pattern as the GCP path installing
#     gcloud from Google's repo. ---
curl -sL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/azure-cli.list
apt-get update -y
apt-get install -y azure-cli

mkdir -p /opt/cc/logs /opt/cc/releases

# `az login --identity` authenticates using the VM's attached User-Assigned
# Managed Identity via the Azure Instance Metadata Service — no credential
# file, no secret, the direct equivalent of GCP's automatic
# metadata-server-based gcloud auth on a GCE instance and AWS's IAM
# instance-profile auth for the AWS CLI/SSM agent.
az login --identity --client-id "${managed_identity_client_id}" >/dev/null

# NOTE: single-node runs the app container directly via `docker run` (no
# compose.yaml). Phase 1 has no Application Gateway equivalent to AWS's
# ALB+ACM / GCP's HTTPS LB path yet (see cc-compute-single-azure module
# header / azure/single-node's `domain` variable doc) — the app serves
# plain HTTP directly on app_port/streaming_ws_port; the operator's own
# reverse proxy/CDN is responsible for HTTPS if needed.
az keyvault secret show \
  --vault-name "${key_vault_name}" \
  --name "${app_env_secret_name}" \
  --query value -o tsv > /opt/cc/app.env || true
chmod 0600 /opt/cc/app.env || true

# Storage connection-string credentials are a SEPARATE secret from app.env
# (see cc-storage-azure module header) — fetch it so the app's Azure Blob
# storage driver (lib/storage/azure-blob-driver.mjs, STORAGE_PROVIDER=azure)
# has AZURE_STORAGE_CONNECTION_STRING available, mirroring how the AWS/GCP
# paths fold their own STORAGE_* values into node.env.
STORAGE_CONNECTION_STRING="$(az keyvault secret show --vault-name "${key_vault_name}" --name "${storage_connection_string_secret_name}" --query value -o tsv || echo '')"

cat > /opt/cc/node.env <<EOF
APP_PORT=${app_port}
STREAMING_WS_PORT=${streaming_ws_port}
STORAGE_PROVIDER=azure
STORAGE_ACCOUNT=${storage_account_name}
STORAGE_CONTAINER=${storage_container_name}
AZURE_STORAGE_CONNECTION_STRING=$STORAGE_CONNECTION_STRING
EOF
chmod 0600 /opt/cc/node.env

# --- Optional Portainer Agent (opt-in, same as the AWS/GCP paths) ---
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

echo "cc single-node Azure machine bootstrap complete" > /var/log/cc-bootstrap.done
