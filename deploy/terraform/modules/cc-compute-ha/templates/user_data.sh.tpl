#!/bin/bash
set -euxo pipefail

# ---------------------------------------------------------------------------
# Telnyx Contact Center — HA app node bootstrap (node #${node_index})
#
# Same machine-prep-only contract as cc-compute-single's user_data.sh.tpl —
# see that file's header comment for the full rationale. The only HA-specific
# difference is there's no per-node EIP (the ALB is the single public entry
# point) and cloud-deploy.mjs's rolling-deploy loop additionally
# deregisters/re-registers this node from the ALB target groups around each
# deploy (§4a).
# ---------------------------------------------------------------------------

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y \
  ca-certificates curl gnupg lsb-release \
  unzip jq zstd

# --- EC2 Instance Connect — Canonical's Ubuntu AMIs ship this pre-installed,
#     but re-assert defensively so the EC2 console's browser "Connect" button
#     always works against the admin_ssh_cidrs ingress rule the wizard
#     auto-configures (see cc-compute-single's user_data.sh.tpl for the same
#     pattern). ---
apt-get install -y ec2-instance-connect || true

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

# --- AWS CLI v2 ---
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install || true

# --- SSM agent (presence only — registration wait is cloud-deploy.mjs's job,
#     see plan §4h) ---
snap install amazon-ssm-agent --classic || true
systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent.service || true

# --- CloudWatch agent ---
curl -fsSL https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb -o /tmp/cwagent.deb
dpkg -i -E /tmp/cwagent.deb || true

mkdir -p /opt/cc/logs /opt/cc/releases

# NOTE: HA nodes run the app container directly (no bundled Postgres, no
# Caddy — TLS terminates at the ALB, not per-node), so unlike single-node
# there's no compose.yaml `cloud` profile involved here: cloud-deploy.mjs's
# per-node deploy script runs the app image with a plain `docker run`
# (ported from fde-internals/scripts/deploy-from-s3.sh), binding directly to
# app_port/streaming_ws_port. See cloud-deploy.mjs for the exact invocation.

aws secretsmanager get-secret-value \
  --region "${region}" \
  --secret-id "${app_env_secret}" \
  --query SecretString --output text > /opt/cc/app.env || true
chmod 0600 /opt/cc/app.env || true

cat > /opt/cc/node.env <<EOF
NODE_INDEX=${node_index}
APP_PORT=${app_port}
STREAMING_WS_PORT=${streaming_ws_port}
STORAGE_PROVIDER=s3
STORAGE_BUCKET=${storage_bucket}
STORAGE_REGION=${storage_region}
STORAGE_ENDPOINT=https://s3.${storage_region}.amazonaws.com
STORAGE_FORCE_PATH_STYLE=false
EOF

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

echo "cc HA node ${node_index} machine bootstrap complete" > /var/log/cc-bootstrap.done
