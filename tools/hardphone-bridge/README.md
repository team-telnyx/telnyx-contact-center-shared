# Hardphone Local Bridge

Local sidecar for controlling LAN-only desk phones from Telnyx Contact Center deployments.

## Why it exists

Poly/Yealink CTI endpoints are usually RFC1918 LAN addresses (`10.x`, `192.168.x`) and must not be exposed to the public internet. The bridge runs inside the customer LAN, talks to phones locally, and opens a persistent **outbound WebSocket** to Contact Center. CC never needs inbound reachability to the LAN.

For local Docker Desktop testing, point the bridge at the CC streaming sidecar via `ws://host.docker.internal:3001/hardphone-bridge`.

## Current MVP

- Runs as a Docker container.
- Opens an outbound WebSocket to CC: `CC_WS_URL=ws://.../hardphone-bridge`.
- Sends `hello` and heartbeat messages; receives `command` messages; returns `command_result` messages.
- Keeps the token-protected local HTTP API for diagnostics/manual LAN testing.
- Supports Polycom/Poly VVX/Edge REST CTI:
  - status
  - dial
  - answer
  - hangup
  - hold/resume
  - reboot
  - reprovision
- Supports basic Yealink Action URI commands:
  - dial
  - answer
  - hangup
  - hold
  - reboot

## Start locally

```bash
cd tools/hardphone-bridge
./scripts/deploy-local.sh
```

The script creates `.env` from `.env.example` and generates a `BRIDGE_TOKEN` if missing. The same token must be set in Contact Center as `HARDPHONE_BRIDGE_TOKEN`.

For local end-to-end testing on Docker Desktop:

```bash
# terminal 1, from repo root — local CC relay sidecar
HARDPHONE_BRIDGE_TOKEN=$(grep '^BRIDGE_TOKEN=' tools/hardphone-bridge/.env | cut -d= -f2-) \
STREAMING_WS_PORT=3001 node -e "import('./lib/streaming-ws-handler.mjs').then(m=>m.initStreamingWSServer({port:3001}))"

# terminal 2 — Docker bridge in LAN mode
cd tools/hardphone-bridge
./scripts/deploy-local.sh
```

The bridge connects out to `ws://host.docker.internal:3001/hardphone-bridge` by default.

## API examples

Health does not require auth:

```bash
curl http://127.0.0.1:8787/health
```

Poly status:

```bash
TOKEN=$(grep '^BRIDGE_TOKEN=' .env | cut -d= -f2-)
curl -sS -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8787/v1/polycom/10.10.10.121/status
```

Poly dial:

```bash
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"number":"+48123123123","admin_password":"<phone-admin-password>"}' \
  http://127.0.0.1:8787/v1/polycom/10.10.10.121/dial
```

## Target architecture for production bridge mode

```text
Contact Center cloud
  ├─ Bridge registry: bridge_id, token hash, site label, online status
  ├─ Command relay: creates command_id, sends JSON over bridge WS
  └─ Phones UI: selects CTI mode = local_bridge and bridge_id

Outbound WebSocket/TLS

Local bridge in LAN
  ├─ persistent outbound connection to CC
  ├─ receives command: { command_id, vendor, host, action, payload }
  ├─ calls phone over LAN: Poly REST / Yealink Action URI / AudioCodes API
  └─ sends result: { command_id, ok, result }

Desk phones
  └─ private addresses, never exposed publicly
```

## What still needs product integration

The outbound WebSocket relay now exists in the CC streaming sidecar and works for local/cloud-to-LAN command delivery. Next product slices:

1. DB tables: `hp_local_bridges`, `hp_local_bridge_commands` for persistent registry/audit instead of the current in-memory relay.
2. Admin UI for generating bridge tokens, showing online bridges, and assigning phones to `bridge_id`.
3. `cti_mode = local_bridge` driver that sends commands through the bridge relay instead of calling phone IP directly.
4. Optional Docker enrollment command generated from UI.

## Security notes

- Keep `BRIDGE_TOKEN` secret.
- Do not expose this service directly to the public internet.
- Prefer VPN/Tailscale/Cloudflare Access/mTLS if CC calls the bridge via HTTP.
- Phone admin passwords should eventually be retrieved per-command from CC secrets, not stored in bridge `.env`.
