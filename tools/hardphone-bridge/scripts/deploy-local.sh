#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  token="$(openssl rand -hex 32 2>/dev/null || python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
  python3 - <<PY
from pathlib import Path
p=Path('.env')
s=p.read_text()
s=s.replace('BRIDGE_TOKEN=change-me', 'BRIDGE_TOKEN=${token}')
p.write_text(s)
PY
  echo "Created tools/hardphone-bridge/.env with a generated BRIDGE_TOKEN"
fi

for kv in \
  "CC_WS_URL=ws://host.docker.internal:3001/hardphone-bridge" \
  "BRIDGE_ID=local-lab" \
  "BRIDGE_SITE=local-lan" \
  "RECONNECT_MS=5000" \
  "HEARTBEAT_MS=25000"; do
  key="${kv%%=*}"
  if ! grep -q "^${key}=" .env; then
    printf '%s\n' "$kv" >> .env
  fi
done

docker compose up -d --build

echo "Hardphone bridge is starting. Health: http://127.0.0.1:${PORT:-8787}/health"
echo "Use Authorization: Bearer <BRIDGE_TOKEN> for /v1/* calls."
