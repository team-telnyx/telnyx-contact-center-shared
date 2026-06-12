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
  "HEARTBEAT_MS=25000" \
  "PHONE_MAC_IP_MAP="; do
  key="${kv%%=*}"
  if ! grep -q "^${key}=" .env; then
    printf '%s\n' "$kv" >> .env
  fi
done

if grep -q "^PHONE_MAC_IP_MAP=$" .env && command -v arp >/dev/null 2>&1; then
  detected_map="$(arp -an 2>/dev/null | python3 -c 'import re,sys
pairs=[]
for line in sys.stdin:
    ip=re.search(r"\\((\\d+\\.\\d+\\.\\d+\\.\\d+)\\)", line)
    mac=re.search(r" at ([0-9a-fA-F:]{11,17}) ", line)
    if not ip or not mac: continue
    norm="".join(part.zfill(2) for part in mac.group(1).lower().split(":"))
    if len(norm)==12 and norm != "000000000000":
        pairs.append(f"{norm}={ip.group(1)}")
print(",".join(dict.fromkeys(pairs)))'
)"
  if [[ -n "$detected_map" ]]; then
    python3 - <<PY
from pathlib import Path
p=Path('.env')
s=p.read_text()
s=s.replace('PHONE_MAC_IP_MAP=', 'PHONE_MAC_IP_MAP=${detected_map}', 1)
p.write_text(s)
PY
    echo "Detected local phone MAC/IP hints from ARP cache."
  fi
fi

docker compose up -d --build

echo "Hardphone bridge is starting. Health: http://127.0.0.1:${PORT:-8787}/health"
echo "Use Authorization: Bearer <BRIDGE_TOKEN> for /v1/* calls."
