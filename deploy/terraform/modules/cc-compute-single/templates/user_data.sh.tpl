#!/bin/bash
set -euxo pipefail

# ---------------------------------------------------------------------------
# Telnyx Contact Center — single-node app bootstrap
#
# This script prepares the MACHINE (Docker, AWS CLI, zstd, SSM/CloudWatch
# agents, runtime secrets on disk). It deliberately does NOT start the app
# container — the first (and every subsequent) deploy is triggered by
# deploy/cli/lib/cloud-deploy.mjs over SSM RunCommand once an image tarball
# has been shipped to S3, so boot-time and update-time logic never diverge.
# ---------------------------------------------------------------------------

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y \
  ca-certificates curl gnupg lsb-release \
  unzip jq zstd

# --- EC2 Instance Connect — Canonical's Ubuntu AMIs ship this pre-installed,
#     but re-assert defensively (same rationale as the SSM agent re-assert
#     below) so the EC2 console's browser "Connect" button always works
#     against the admin_ssh_cidrs ingress rule the wizard auto-configures. ---
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

# --- AWS CLI v2 (used by cloud-deploy.mjs's SSM-run deploy script to fetch
#     the image tarball + secrets) ---
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install || true

# --- SSM agent — Ubuntu 24.04's Canonical AMI ships this pre-installed via
#     snap, but re-assert defensively in case a future AMI drops it. Note:
#     agent PRESENCE here is not the same as agent REGISTRATION — the deploy
#     mechanism (cloud-deploy.mjs) separately polls `ssm
#     describe-instance-information` for PingStatus=Online before the first
#     SendCommand, since registration can lag 30-90s behind this script
#     finishing (see plan §4h). ---
snap install amazon-ssm-agent --classic || true
systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent.service || true

# --- CloudWatch agent ---
curl -fsSL https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb -o /tmp/cwagent.deb
dpkg -i -E /tmp/cwagent.deb || true

mkdir -p /opt/cc/logs /opt/cc/releases

# NOTE: single-node runs the app container directly via `docker run` (no
# compose.yaml, no Caddy) — same mechanism as cc-compute-ha's nodes. TLS is
# handled EITHER by an ALB in front (Route53-managed domain + ACM cert — see
# cc-compute-single's optional ALB block) OR not at all on the instance
# (external-DNS / no-domain path — the operator's own reverse proxy/CDN is
# responsible for HTTPS if they have one; the app just serves plain HTTP on
# app_port/streaming_ws_port). Caddy-on-instance/Let's-Encrypt-on-the-app-node
# was removed entirely: ACM certificates can only be attached to an ALB, not
# to a bare EC2 instance, so there was no way to use an AWS-issued cert
# without an ALB anyway, and running Caddy AND supporting an ALB would have
# meant two different, divergent TLS stories for the same topology.
aws secretsmanager get-secret-value \
  --region "${region}" \
  --secret-id "${app_env_secret}" \
  --query SecretString --output text > /opt/cc/app.env || true
chmod 0600 /opt/cc/app.env || true

cat > /opt/cc/node.env <<EOF
APP_PORT=${app_port}
STREAMING_WS_PORT=${streaming_ws_port}
STORAGE_PROVIDER=s3
STORAGE_BUCKET=${storage_bucket}
STORAGE_REGION=${storage_region}
STORAGE_ENDPOINT=https://s3.${storage_region}.amazonaws.com
STORAGE_FORCE_PATH_STYLE=false
EOF

# --- Optional Portainer Agent (opt-in, wizard Step 4 for cloud targets —
#     see plan §4i). Agent-only: no bundled Portainer server. Pairs with
#     whatever Portainer server the user already runs elsewhere; the
#     security group only opens this port to CIDRs the user explicitly gave
#     the wizard (see cc-network's portainer_server_cidrs). ---
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

echo "cc single-node machine bootstrap complete" > /var/log/cc-bootstrap.done
