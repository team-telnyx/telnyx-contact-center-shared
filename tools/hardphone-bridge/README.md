# Hardphone Local Bridge

Local sidecar for controlling LAN-only desk phones from Telnyx Contact Center deployments.

## Why it exists

Poly/Yealink CTI endpoints are usually RFC1918 LAN addresses (`10.x`, `192.168.x`) and must not be exposed to the public internet. The bridge runs inside the customer LAN and talks to phones locally. Contact Center can then talk to the bridge through a secure private route (VPN/Tailscale/Cloudflare Tunnel) or, in a future mode, through an outbound WebSocket tunnel.

## Current MVP

- Runs as a Docker container.
- Exposes a token-protected local HTTP API.
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

The script creates `.env` from `.env.example` and generates a `BRIDGE_TOKEN` if missing.

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

## What still needs CC integration

This MVP is immediately useful when the CC server can reach the bridge over a private route. For pure cloud-to-LAN without inbound networking, implement:

1. DB tables: `hp_local_bridges`, `hp_local_bridge_commands`.
2. Streaming WS route on CC for bridge registration/heartbeat/command results.
3. Admin UI for generating bridge tokens and assigning phones to `bridge_id`.
4. `cti_mode = local_bridge` driver that queues commands to the bridge registry instead of calling phone IP directly.
5. Optional Docker enrollment command generated from UI.

## Security notes

- Keep `BRIDGE_TOKEN` secret.
- Do not expose this service directly to the public internet.
- Prefer VPN/Tailscale/Cloudflare Access/mTLS if CC calls the bridge via HTTP.
- Phone admin passwords should eventually be retrieved per-command from CC secrets, not stored in bridge `.env`.
