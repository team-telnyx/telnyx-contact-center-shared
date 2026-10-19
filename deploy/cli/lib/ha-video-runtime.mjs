// Evaluated before any HA node is drained or its running container replaced.
// Per-node settings live in /opt/cc/node.env; app.env may explicitly disable AI.
export const HA_VIDEO_SETUP = String.raw`
read_video_env() {
  awk -F= -v wanted="$1" '$1 == wanted { sub(/^[^=]*=/, ""); value=$0 } END { gsub(/^"|"$/, "", value); print value }' "$APP_DIR/app.env" "$APP_DIR/node.env"
}
video_args=(--env VIDEO_CONFERENCE_AI_ENABLED=false)
video_enabled="$(read_video_env VIDEO_CONFERENCE_AI_ENABLED)"
[ -n "$video_enabled" ] || video_enabled=false
video_path="$(read_video_env CC_VIDEO_RECORDINGS_PATH)"
if [ "$video_enabled" != "false" ]; then
  video_ip="$(read_video_env VIDEO_AI_PRIVATE_IP)"
  video_port="$(read_video_env VIDEO_AI_CONTROL_PORT)"
  [ -n "$video_port" ] || video_port=3092
  python3 - "$video_ip" "$video_port" <<'CC_VIDEO_ADDRESS'
import ipaddress, sys
try:
    address = ipaddress.IPv4Address(sys.argv[1])
    assert any(address in ipaddress.IPv4Network(n) for n in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))
    assert 1024 <= int(sys.argv[2]) <= 65535
except (ValueError, AssertionError):
    sys.exit('HA Video AI requires VIDEO_AI_PRIVATE_IP (this node RFC1918 address) and a valid VIDEO_AI_CONTROL_PORT in /opt/cc/node.env')
CC_VIDEO_ADDRESS
  if ! ip -o -4 addr show | awk '{ split($4, a, "/"); print a[1] }' | grep -Fxq "$video_ip"; then
    echo "HA Video AI private relay address is not assigned to this host" >&2; exit 64
  fi
  video_args=(
    --env VIDEO_AI_BIND=0.0.0.0
    --env "VIDEO_AI_CONTROL_PORT=$video_port"
    --env "VIDEO_AI_CONTROL_URL=http://$video_ip:$video_port"
    --publish "$video_ip:$video_port:$video_port"
  )
fi
# Keep existing recordings readable even when the AI worker is disabled.
if [ "$video_enabled" != "false" ] || [ -n "$video_path" ]; then
  case "$video_path" in
    /*) ;;
    *) echo "HA Video AI requires CC_VIDEO_RECORDINGS_PATH pointing to the same private shared filesystem on every node" >&2; exit 64 ;;
  esac
  case "$video_path" in
    *,*) echo "HA Video AI recording path cannot contain a comma" >&2; exit 64 ;;
  esac
  if [ ! -d "$video_path" ] || [ ! -w "$video_path" ]; then
    echo "HA Video AI recording directory must exist and be writable" >&2; exit 64
  fi
  case "$(findmnt -n -o FSTYPE --target "$video_path")" in
    nfs|nfs4|cifs|ceph|fuse.ceph|fuse.glusterfs|lustre) ;;
    *) echo "HA Video AI recordings require a mounted shared filesystem; a host-local directory or Docker volume is not supported" >&2; exit 64 ;;
  esac
  video_args+=(
    --env CC_VIDEO_RECORDING_DIR=/app/.data/video-recordings
    --mount "type=bind,source=$video_path,target=/app/.data/video-recordings"
  )
fi
`;

export const HA_VIDEO_PREFLIGHT = `#!/usr/bin/env bash
set -euo pipefail
APP_DIR=/opt/cc
aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$APP_ENV_SECRET" --query SecretString --output text > "$APP_DIR/app.env"
chmod 0600 "$APP_DIR/app.env"
${HA_VIDEO_SETUP}
echo "DEPLOY_OK HA video configuration checked"
`;
