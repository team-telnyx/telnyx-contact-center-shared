#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  deploy-artifact-ssm.sh --target <name> --artifact s3://bucket/prefix/sha [--config deploy/targets.json]

Runs from an operator machine with AWS CLI access. It resolves a target from the
JSON config and runs scripts/deploy-from-s3.sh remotely through AWS SSM.

Target config supports:
  type: "single-node" or "ha"
  region: AWS region
  profile: optional AWS CLI profile
  instance_ids: explicit array of EC2 instance IDs
  instance_tag: optional EC2 tag selector, for example "App=cc-ha"
  container_name, app_name, env_file, health_url, docker_network, media_dir, log_dir
  host_app_port, host_ws_port, container_app_port, container_ws_port
  app_target_group_arn, ws_target_group_arn: optional for HA drain/register
  alb_drain_seconds: default 30

Examples:
  ./scripts/deploy-artifact-ssm.sh \
    --target legacy-cc-prod \
    --artifact s3://cc-build-artifacts/telnyx-contact-center/9f3a1c7

  ./scripts/deploy-artifact-ssm.sh \
    --target cc-ha \
    --artifact s3://cc-build-artifacts/telnyx-contact-center/9f3a1c7 \
    --config deploy/targets.json
USAGE
}

CONFIG="deploy/targets.json"
TARGET=""
ARTIFACT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --config)
      CONFIG="$2"
      shift 2
      ;;
    --target)
      TARGET="$2"
      shift 2
      ;;
    --artifact)
      ARTIFACT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$TARGET" ] || [ -z "$ARTIFACT" ]; then
  usage >&2
  exit 2
fi

if [ ! -f "$CONFIG" ]; then
  echo "Config file not found: $CONFIG" >&2
  exit 3
fi

if [[ "$ARTIFACT" != s3://* ]]; then
  echo "Artifact must be an s3:// URI, got: $ARTIFACT" >&2
  exit 3
fi

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 127
  fi
}
require aws
require python3

json_get() {
  local expr="$1"
  python3 - "$CONFIG" "$TARGET" "$expr" <<'PY'
import json, sys
config, target, expr = sys.argv[1:4]
with open(config, 'r', encoding='utf-8') as f:
    data = json.load(f)
node = data.get(target)
if node is None:
    raise SystemExit(f"Target not found in config: {target}")
cur = node
for part in expr.split('.'):
    if not part:
        continue
    if isinstance(cur, dict):
        cur = cur.get(part)
    else:
        cur = None
        break
if cur is None:
    print('')
elif isinstance(cur, bool):
    print('true' if cur else 'false')
elif isinstance(cur, (list, dict)):
    print(json.dumps(cur))
else:
    print(cur)
PY
}

REGION="$(json_get region)"
PROFILE="$(json_get profile)"
TYPE="$(json_get type)"
INSTANCE_TAG="$(json_get instance_tag)"
INSTANCE_IDS_JSON="$(json_get instance_ids)"
APP_TG="$(json_get app_target_group_arn)"
WS_TG="$(json_get ws_target_group_arn)"
APP_PORT="$(json_get host_app_port)"
APP_PORT="${APP_PORT:-3000}"
WS_PORT="$(json_get host_ws_port)"
WS_PORT="${WS_PORT:-3001}"
ALB_DRAIN_SECONDS="$(json_get alb_drain_seconds)"
ALB_DRAIN_SECONDS="${ALB_DRAIN_SECONDS:-30}"

if [ -z "$REGION" ]; then
  echo "Target $TARGET is missing region" >&2
  exit 4
fi
if [ -z "$TYPE" ]; then
  TYPE="single-node"
fi

aws_args=(--region "$REGION")
if [ -n "$PROFILE" ]; then
  aws_args+=(--profile "$PROFILE")
fi

resolve_instances() {
  if [ -n "$INSTANCE_IDS_JSON" ]; then
    python3 - <<PY
import json
for item in json.loads('''$INSTANCE_IDS_JSON'''):
    print(item)
PY
    return
  fi

  if [ -z "$INSTANCE_TAG" ]; then
    echo "Target must define instance_ids or instance_tag" >&2
    exit 4
  fi

  local key="${INSTANCE_TAG%%=*}"
  local value="${INSTANCE_TAG#*=}"
  aws ec2 describe-instances "${aws_args[@]}" \
    --filters "Name=tag:${key},Values=${value}" "Name=instance-state-name,Values=running" \
    --query 'Reservations[].Instances[].InstanceId' \
    --output text | tr '\t' '\n'
}

mapfile -t INSTANCE_IDS < <(resolve_instances | sed '/^$/d')
if [ "${#INSTANCE_IDS[@]}" -eq 0 ]; then
  echo "No running EC2 instances resolved for target $TARGET" >&2
  exit 4
fi

remote_script="$(base64 < scripts/deploy-from-s3.sh | tr -d '\n')"

remote_env_exports() {
  local -a keys=(
    app_name APP_NAME
    container_name CONTAINER_NAME
    env_file ENV_FILE
    health_url HEALTH_URL
    host_app_port HOST_APP_PORT
    container_app_port CONTAINER_APP_PORT
    host_ws_port HOST_WS_PORT
    container_ws_port CONTAINER_WS_PORT
    media_dir MEDIA_DIR
    log_dir LOG_DIR
    docker_network DOCKER_NETWORK
    extra_docker_args EXTRA_DOCKER_ARGS
  )
  local i key env value
  for ((i=0; i<${#keys[@]}; i+=2)); do
    key="${keys[$i]}"
    env="${keys[$((i+1))]}"
    value="$(json_get "$key")"
    if [ -n "$value" ]; then
      printf 'export %s=%q\n' "$env" "$value"
    fi
  done
}

REMOTE_COMMAND="set -euo pipefail
mkdir -p /tmp/cc-artifact-deploy
printf '%s' '$remote_script' | base64 -d > /tmp/cc-artifact-deploy/deploy-from-s3.sh
chmod +x /tmp/cc-artifact-deploy/deploy-from-s3.sh
$(remote_env_exports)
sudo -E /tmp/cc-artifact-deploy/deploy-from-s3.sh '$ARTIFACT'"

send_ssm() {
  local instance_id="$1"
  local command_id
  command_id="$(aws ssm send-command "${aws_args[@]}" \
    --document-name AWS-RunShellScript \
    --instance-ids "$instance_id" \
    --comment "Deploy $TARGET from $ARTIFACT" \
    --parameters commands="$REMOTE_COMMAND" \
    --query 'Command.CommandId' \
    --output text)"

  echo "SSM command for $instance_id: $command_id"

  local status="Pending"
  while :; do
    status="$(aws ssm get-command-invocation "${aws_args[@]}" \
      --command-id "$command_id" \
      --instance-id "$instance_id" \
      --query 'Status' \
      --output text 2>/dev/null || true)"
    case "$status" in
      Success|Cancelled|TimedOut|Failed|Cancelling)
        break
        ;;
      *)
        sleep 5
        ;;
    esac
  done

  aws ssm get-command-invocation "${aws_args[@]}" \
    --command-id "$command_id" \
    --instance-id "$instance_id" \
    --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
    --output json

  if [ "$status" != "Success" ]; then
    echo "SSM deploy failed on $instance_id with status $status" >&2
    return 5
  fi
}

wait_target_state() {
  local tg="$1"
  local instance_id="$2"
  local desired="$3"
  local port="$4"
  local state=""
  for _ in $(seq 1 60); do
    state="$(aws elbv2 describe-target-health "${aws_args[@]}" \
      --target-group-arn "$tg" \
      --targets "Id=$instance_id,Port=$port" \
      --query 'TargetHealthDescriptions[0].TargetHealth.State' \
      --output text 2>/dev/null || true)"
    if [ "$state" = "$desired" ] || { [ "$desired" = "unused" ] && [ "$state" = "None" ]; }; then
      return 0
    fi
    sleep 5
  done
  echo "Target $instance_id:$port in $tg did not reach $desired, last state: $state" >&2
  return 1
}

deploy_instance() {
  local instance_id="$1"
  local deploy_status=0
  echo "Deploying $TARGET to $instance_id from $ARTIFACT"

  if [ "$TYPE" = "ha" ]; then
    if [ -n "$APP_TG" ]; then
      echo "Deregistering $instance_id from app target group"
      aws elbv2 deregister-targets "${aws_args[@]}" --target-group-arn "$APP_TG" --targets "Id=$instance_id,Port=$APP_PORT"
      sleep "$ALB_DRAIN_SECONDS"
    fi
    if [ -n "$WS_TG" ]; then
      echo "Deregistering $instance_id from websocket target group"
      aws elbv2 deregister-targets "${aws_args[@]}" --target-group-arn "$WS_TG" --targets "Id=$instance_id,Port=$WS_PORT"
      sleep "$ALB_DRAIN_SECONDS"
    fi
  fi

  if send_ssm "$instance_id"; then
    deploy_status=0
  else
    deploy_status=$?
  fi

  if [ "$TYPE" = "ha" ]; then
    if [ -n "$APP_TG" ]; then
      echo "Registering $instance_id back to app target group"
      aws elbv2 register-targets "${aws_args[@]}" --target-group-arn "$APP_TG" --targets "Id=$instance_id,Port=$APP_PORT"
      wait_target_state "$APP_TG" "$instance_id" healthy "$APP_PORT"
    fi
    if [ -n "$WS_TG" ]; then
      echo "Registering $instance_id back to websocket target group"
      aws elbv2 register-targets "${aws_args[@]}" --target-group-arn "$WS_TG" --targets "Id=$instance_id,Port=$WS_PORT"
      wait_target_state "$WS_TG" "$instance_id" healthy "$WS_PORT"
    fi
  fi

  return "$deploy_status"
}

for instance_id in "${INSTANCE_IDS[@]}"; do
  deploy_instance "$instance_id"
done

echo "DEPLOY_TARGET_OK target=$TARGET instances=${INSTANCE_IDS[*]} artifact=$ARTIFACT"
