# High Availability Deployment Architecture

This document describes the supported high availability (HA) deployment pattern for the Telnyx Contact Center application. It is intentionally environment-neutral and can be shared publicly. It does not include customer-specific hostnames, IP addresses, AWS account IDs, credentials, or private deployment details.

## Overview

Telnyx Contact Center can run as a horizontally scaled web application behind an HTTPS load balancer. The application is packaged as a container image and deployed to multiple application nodes across availability zones. Persistent state is externalized into managed services so individual application nodes can be replaced without losing application data.

The recommended production-style HA topology is:

```text
Users / Agents / Telnyx Webhooks
          |
          v
DNS + TLS
          |
          v
Application Load Balancer / HTTPS Load Balancer
          |
          +-----------------------------+
          |                             |
          v                             v
 App Node A                       App Node B
 containerized app                containerized app
          |                             |
          +-------------+---------------+
                        |
                        v
        Managed PostgreSQL, Multi-AZ / HA database
                        |
                        v
        Shared object storage for media and uploads
```

## Goals

- Run at least two application nodes in separate availability zones or fault domains.
- Terminate TLS at the load balancer.
- Keep application nodes stateless or near-stateless.
- Store durable application state in PostgreSQL.
- Store recordings, media, exports, and file uploads in S3-compatible object storage.
- Support rolling replacement of app nodes without changing DNS.
- Support load balancer health checks using `/api/health`.
- Keep secrets outside container images and source control.

## Application Node Requirements

Each application node runs the same container image and needs:

- Linux host or container runtime platform.
- Docker, Kubernetes, ECS, Nomad, or another container runtime.
- Network access to PostgreSQL.
- Network access to S3-compatible object storage.
- Runtime environment variables injected securely at startup.
- Port `3000` exposed internally to the load balancer, unless overridden by `PORT`.

The application should be started with the production command defined in `package.json`:

```bash
yarn start
```

or via the production container entrypoint if a container image is used.

## Load Balancer Requirements

The load balancer should:

- Listen on `443` with a valid TLS certificate.
- Redirect `80` to `443` where appropriate.
- Forward traffic to application nodes on the application port, normally `3000`.
- If AI streaming, Telnyx STT streaming, or the hardphone bridge are used, also route the streaming WebSocket service. The app starts this on `STREAMING_WS_PORT`, or on `PORT + 1` when `STREAMING_WS_PORT` is unset, so the default is normally `3001`.
- Set `WS_BASE_URL` to the public `wss://` URL that reaches the streaming WebSocket service, either through the same load balancer with path-based routing or through a separate listener/target group for the streaming port. Path-based routing must send `/streaming/*` to the sidecar for AI/Telnyx streaming, and must also send both the exact `/hardphone-bridge` path and `/hardphone-bridge/*` subpaths plus `/api/hardphone-bridge/*` to the sidecar when hardphone bridge support is enabled.
- Use `/api/health` as the health check endpoint.
- Treat HTTP `200-399` as healthy.
- Use a health check timeout short enough to identify failed nodes quickly.
- Use a deregistration/drain delay during replacement to reduce dropped requests.

Recommended health check:

```text
Path: /api/health
Matcher: 200-399
Interval: 30 seconds
Timeout: 5 seconds
Healthy threshold: 2
Unhealthy threshold: 3
```

For Server-Sent Events, WebSocket-like long-lived sessions, or long polling, increase the load balancer idle timeout above the default. A value around 300 seconds is a practical baseline.

Cookie stickiness can be enabled when the deployment uses long-lived browser sessions or streaming connections and the application is not yet fully session-affinity-free.

## Database Requirements

The application requires PostgreSQL. For HA deployments, use a managed or clustered PostgreSQL option with automatic failover, such as:

- AWS RDS PostgreSQL Multi-AZ
- Google Cloud SQL HA
- Azure Database for PostgreSQL Flexible Server with zone-redundant HA
- A managed PostgreSQL provider with equivalent failover guarantees
- A self-managed PostgreSQL cluster with tested failover automation

Recommended properties:

- PostgreSQL 16+ or 17+ where supported.
- Encrypted storage.
- Automated backups.
- Private networking where possible.
- Connection limits sized for multiple app nodes.
- Credentials stored in a secret manager, not in source control.

The app initializes and verifies schema with:

```bash
yarn ensure:pg
```

The container startup process should ensure schema readiness before serving production traffic.

## Shared Object Storage

Use S3-compatible object storage for media, uploads, recordings, and generated files. The architecture should support the same application code across AWS S3, Google Cloud Storage interoperability, MinIO, Ceph RGW, or other S3-compatible systems.

Expected environment model:

```env
STORAGE_PROVIDER=s3
STORAGE_ENDPOINT=https://s3.<region>.amazonaws.com
STORAGE_BUCKET=<bucket-name>
STORAGE_REGION=<region>
STORAGE_FORCE_PATH_STYLE=false
```

For non-AWS providers or MinIO-style deployments, use provider-specific endpoint and credentials:

```env
STORAGE_ENDPOINT=https://minio.example.com
STORAGE_FORCE_PATH_STYLE=true
STORAGE_ACCESS_KEY=<access-key>
STORAGE_SECRET_KEY=<secret-key>
```

Object storage should have:

- Public access disabled by default.
- Server-side encryption enabled.
- Versioning enabled where supported.
- Lifecycle cleanup for incomplete multipart uploads.
- Presigned URL support for controlled upload/download flows.

## Secrets and Runtime Configuration

Do not bake secrets into the image. Do not commit secrets into source control. Runtime configuration should be loaded from a secret manager or equivalent secure store during deployment.

Typical secret sources:

- AWS Secrets Manager
- Google Secret Manager
- Azure Key Vault
- Kubernetes Secrets backed by external secret management
- Vault or another managed secret store

The application expects environment variables for database, authentication, Telnyx credentials, storage, and deployment-specific runtime configuration.

## HA Runtime Flags

The same container image supports both single-node and HA/multi-node deployments. Keep the defaults for local/single-node. Override only the flags needed for HA.

| Variable | Safe default | HA value / guidance |
|---|---:|---|
| `PROCESS_ROLE` | `all` | `web` for HTTP/API/SSE nodes, `streaming` for WebSocket-only nodes, `worker` for coordinator/background workers. `all` keeps legacy single-container behavior. |
| `EVENT_BUS` | `pg` | Use `pg`; PostgreSQL LISTEN/NOTIFY is the implemented cross-node adapter. |
| `SSE_FANOUT` | `false` | Set `true` so status/dashboard SSE broadcasts fan out across nodes. |
| `GLOBAL_PRESENCE` | `false` | Set `true` so `/api/user/status-stream` presence is tracked globally in Postgres. |
| `GLOBAL_PRESENCE_TTL_MS` | `90000` | TTL for presence rows; expired rows protect against crashed nodes. |
| `ROUTING_EVENT_DRIVEN` | `false` | Set `true` only when enabling the event-driven routing reactor. |
| `COORDINATOR_SINGLETON` | `false` | Set `true` only on runtimes allowed to run leader-gated coordinator work. |
| `OUTBOUND_POWER_PACING` | `false` | Set `true` only for WS5 power-campaign pacing tests; requires coordinator leadership so exactly one node dials. |
| `OUTBOUND_PREDICTIVE_PACING` | `false` | Set `true` only for WS6 predictive pacing tests; keep off for first HA deploy unless explicitly validating predictive. |
| `STORAGE_PROVIDER` | `local` / unset | Set `s3` in HA so media and uploads are shared across nodes. |
| `WS_BASE_URL` | auto-derived | In HA, set the public WebSocket URL explicitly, for example `wss://cc-ha-ws.demotelnyx.com`. |

Recommended HA split for this deployment model. The explicit role values are `PROCESS_ROLE=web`, `PROCESS_ROLE=streaming`, and `PROCESS_ROLE=worker`:

```env
# Web app nodes behind the HTTPS app target group on port 3000
PROCESS_ROLE=web
STORAGE_PROVIDER=s3
EVENT_BUS=pg
SSE_FANOUT=true
GLOBAL_PRESENCE=true
WS_BASE_URL=wss://cc-ha-ws.demotelnyx.com
STREAMING_WS_PORT=3001

# Optional dedicated streaming runtime behind the WebSocket target group on port 3001
PROCESS_ROLE=streaming
STREAMING_WS_PORT=3001
WS_BASE_URL=wss://cc-ha-ws.demotelnyx.com

# Optional dedicated worker/coordinator runtime
PROCESS_ROLE=worker
COORDINATOR_SINGLETON=true
ROUTING_EVENT_DRIVEN=true
EVENT_BUS=pg
# Enable only when intentionally validating outbound HA pacing:
OUTBOUND_POWER_PACING=false
OUTBOUND_PREDICTIVE_PACING=false
```

If using only app nodes without a separate streaming runtime, leave `PROCESS_ROLE=all` or route port `3001` from each app node to the WebSocket target group. If using dedicated streaming runtimes, set web nodes to `PROCESS_ROLE=web` so they do not also bind `STREAMING_WS_PORT`.

Dedicated streaming runtimes do not start the Next.js HTTP server on `PORT`. They expose a lightweight health listener on `STREAMING_WS_PORT`; configure the WebSocket target group health check to `GET /api/health` or `GET /health` on that streaming port. Keep the application target group health check on the web nodes' `/api/health` endpoint.

## Deployment Flow

A typical HA deployment flow is:

1. Build the application container image.
2. Push the image to a container registry.
3. Store runtime `.env` data in a secret manager.
4. Provision or update database and object storage.
5. Start or replace application nodes across at least two availability zones.
6. Pull the image on each node.
7. Inject runtime environment variables from the secret manager.
8. Start the application container.
9. Verify local health on each node.
10. Register nodes with the load balancer target group or service backend.
11. Verify load balancer health checks.
12. Verify public `/api/health` returns `healthy` and `database: connected`.

## Operational Verification

Minimum post-deployment checks:

```bash
curl -fsS https://<app-domain>/api/health
```

Expected response shape:

```json
{
  "status": "healthy",
  "database": "connected",
  "timestamp": "..."
}
```

Also verify:

- All load balancer targets are healthy.
- Each app node is running the expected image version.
- Database connections are succeeding.
- Object storage read/write paths work.
- Telnyx webhook URLs point at the load-balanced domain, not individual nodes.
- Logs are centralized or retrievable.
- Node replacement does not require manual database changes.

## Failure Behavior

With this topology:

- If one app node fails, the load balancer removes it after failed health checks and routes traffic to the remaining healthy node.
- If an app node is replaced, it pulls the same image and configuration, initializes schema idempotently, and rejoins the target group.
- If the primary database instance fails, the managed database service should fail over to a standby in another availability zone.
- DNS continues to point to the load balancer rather than individual nodes.

## Security Baseline

Recommended security practices:

- Restrict SSH access to approved admin CIDRs only, or prefer session manager / bastion access.
- Keep application nodes in private subnets where platform architecture allows it.
- Restrict application node inbound traffic to the load balancer on the application port.
- Restrict database inbound traffic to application nodes only.
- Use instance roles or workload identity instead of static cloud credentials on hosts.
- Store secrets in a secret manager and mount/inject them at runtime.
- Enforce TLS at the public edge.
- Disable public access to object storage.
- Encrypt database and object storage at rest.

## Portability Notes

The architecture is intentionally cloud-portable:

| Capability | AWS Example | Portable Equivalent |
|---|---|---|
| Load balancer | Application Load Balancer | Any HTTPS L7 load balancer |
| Compute | EC2 app nodes | VM scale set, managed instance group, Kubernetes nodes |
| Database | RDS PostgreSQL Multi-AZ | Cloud SQL HA, Azure PostgreSQL HA, managed PostgreSQL |
| Object storage | S3 | GCS interoperability, Azure Blob S3 gateway, MinIO, Ceph RGW |
| Secrets | Secrets Manager | Secret Manager, Key Vault, Vault, External Secrets |
| Registry | ECR | Artifact Registry, ACR, GHCR, Docker registry |

## Current Application Expectations

- The application health endpoint is `/api/health`.
- The default application port is `3000`.
- PostgreSQL schema setup is idempotent via `yarn ensure:pg`.
- Media/object storage should be S3-compatible.
- Telnyx webhook integrations should use the stable load-balanced public domain.

## Production Readiness Checklist

Before promoting an HA deployment to production, verify:

- [ ] Two or more app nodes across fault domains.
- [ ] Public domain points to the load balancer.
- [ ] TLS certificate is valid and auto-renewed.
- [ ] `/api/health` is green through the load balancer.
- [ ] All load balancer targets are healthy.
- [ ] PostgreSQL is HA-capable and backed up.
- [ ] Object storage is private, encrypted, and versioned where possible.
- [ ] Secrets are not present in Git, container images, Terraform outputs, or public docs.
- [ ] SSH/admin access is restricted.
- [ ] Logs and metrics are available during incidents.
- [ ] Restore/failover procedure has been tested.
- [ ] App node replacement has been tested.
