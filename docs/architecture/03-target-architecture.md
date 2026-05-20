# 03 — Target Distributed Architecture

> **Status:** Proposal. Builds on the gaps in [02](./02-production-gaps.md). Optimized for single-tenant-per-deployment so each customer gets their own stack via [04](./04-cdk-distribution.md).

## 1. Topology

```
                 ┌─ ALB ─┐
   Telnyx webhooks │       │  Browser (agents, supervisors, admins)
        │          ▼       ▼
        │      ┌────────────────┐    SSE / WebSocket
        └────► │ Webhook Receiver│ ◄──── via API Gateway WebSocket
               │    (Fargate)    │      OR sticky ALB to Next.js
               └────┬───────────┘
                    │ enqueue (event_id idempotency)
                    ▼
              ┌──────────┐         ┌────────────────────┐
              │   SQS    │ ──────► │ Flow Executor Workers│ ◄── Telnyx API
              │ (FIFO    │         │   (Fargate, N≥2)     │
              │  per     │         └────┬─────────────────┘
              │  call)   │              │
              └──────────┘              │ state ops
                    ▲                   ▼
                    │            ┌──────────────┐
              ┌─────┴──────┐     │  ElastiCache │  ◄── pub/sub for SSE
              │ EventBridge│     │   (Redis)    │
              │  Scheduler │ ──► │  - queues    │
              │ (cron jobs)│     │  - presence  │
              └────────────┘     │  - call legs │
                                 └──────┬───────┘
                                        │ snapshots / writes
                                        ▼
                                   ┌─────────┐
                                   │   RDS   │  ◄── historical, reporting
                                   │ Postgres│
                                   └─────────┘
   S3: recordings, form media, exports
   Secrets Manager: Telnyx/Google/Azure/Mailgun keys
   CloudWatch + X-Ray: observability
```

## 2. Component responsibilities

| Component | Responsibility | Service |
|-----------|----------------|---------|
| **Web tier** | Renders the UI; holds SSE/WebSocket connections to browsers; admin / agent API routes | ECS Fargate (Next.js, ≥2 tasks) |
| **Webhook receiver** | Verifies Telnyx signatures, dedupes by event ID, enqueues to SQS, returns 200 | ECS Fargate (small, autoscaled on request rate) |
| **Flow executor workers** | Consumes SQS, loads flow state from Redis, executes one node, calls Telnyx API, publishes state changes & SSE events | ECS Fargate (autoscaled on queue depth) |
| **Scheduled jobs** | Idle-time roll-up, ghost call cleanup, monitor cleanup, daily reports | Lambda + EventBridge Scheduler |
| **Real-time state store** | Queues, agent presence, in-flight interactions, call leg mappings, SSE channel pub/sub | ElastiCache (Redis cluster mode, Multi-AZ) |
| **System of record** | User accounts, queue/skill definitions, voice flows, interaction history, reporting | RDS Postgres (Multi-AZ) |
| **Object storage** | Recordings, form media uploads, exports | S3 (lifecycle-managed) |
| **Secret storage** | API keys (Telnyx, Azure, Google, Mailgun, ElevenLabs) | Secrets Manager |
| **Observability** | Traces, logs, metrics, alarms | CloudWatch + X-Ray (or OTEL → managed Prometheus/Grafana) |

## 3. Key design decisions

### 3.1 Tenancy: single-tenant-per-stack

**Decision:** do not add `org_id` to every table. Distribute one CDK stack per customer.

**Why:**
- The existing schema has zero tenant scoping. Retrofitting `org_id` across ~30 tables + every query + RLS policies is a multi-month project with high regression risk.
- Telnyx Voice API resources (Voice Apps, SIP connections, Call Control IDs) are already account-scoped. Multi-tenanting on top creates a credential-management problem that doesn't go away with RLS.
- Compliance customers want data isolation at the infrastructure boundary, not at the row level.
- CDK distribution makes per-customer stacks operationally cheap.

**Consequence:** the multi-tenant SaaS path is foreclosed by this decision. Re-opening it later requires the cross-cutting schema work this avoids.

### 3.2 SSE vs WebSocket

**Decision:** prefer **API Gateway WebSocket** for new client connections, but keep the existing SSE endpoints working during migration via Redis pub/sub.

**Why:**
- SSE behind an ALB requires sticky sessions, which break during rolling deploys.
- WebSocket via API Gateway makes the app tier truly stateless — connection state is managed by AWS.
- The existing `broadcastToKey(key, payload)` API can be re-implemented to publish to either backend with no caller changes.

**Migration:** ship Redis-backed SSE first (small patch to `lib/sse.js`), then incrementally migrate clients to WebSocket.

### 3.3 Workers: Fargate, not Lambda

**Decision:** webhook receivers and flow-executor workers run on **Fargate**, not Lambda. Cron-style work runs on **Lambda**.

**Why Fargate for the hot path:**
- Steady, predictable load — autoscaling is easy and cost is lower than Lambda at sustained volume.
- Warm connections to Telnyx, Redis, and Postgres avoid per-invocation handshake cost.
- Container-based deploy matches the existing Next.js image build (a `docker/` folder is already in the repo).
- Long-running SSE/WebSocket handlers don't fit Lambda's 15-minute ceiling cleanly anyway.

**Why Lambda for cron:**
- Single-instance fire semantics are exactly what scheduled cleanup wants.
- No need to keep a worker idle waiting for a 10-minute timer.

### 3.4 State partitioning in Redis

**Decision:** use Redis as the authoritative real-time store, with Postgres as the historical record. Treat Redis losses as recoverable (rebuild from Postgres + in-flight Telnyx state).

**Key shapes:**

| State | Redis primitive | Key |
|-------|-----------------|-----|
| Agent state | HASH | `agent:{user_id}` |
| Queue (sorted by enqueue time) | ZSET | `queue:{queue_id}` |
| Interaction state | HASH | `interaction:{interaction_id}` |
| WebRTC ↔ PSTN call leg | HASH | `callleg:{call_control_id}` |
| SSE pub/sub channel | Pub/Sub | `sse:{key}` |
| Distributed lock | SET NX EX | `lock:{task_name}` |
| Webhook idempotency | SET NX EX | `webhook:{event_id}` (TTL ~24h) |

### 3.5 Migrations

**Decision:** adopt **`node-pg-migrate`**, run migrations as a one-shot ECS task before deploying new app/worker images.

**Why this tool:** it's Node-native (no JVM), reversible by default (every migration has `up` and `down`), and integrates with the existing `pg` driver.

## 4. What stays from the current codebase

Most of it. The migration is mechanical, not a rewrite:

- **All Next.js pages and components** — UI is unaffected.
- **All admin API routes** — they read/write Postgres directly, which is fine.
- **All voice flow node implementations** — the flow engine moves into the worker fleet, but the node types and configs stay identical.
- **NextAuth setup** — Postgres-backed, works as-is.
- **Schema (after `org_id` decision is settled as "no")** — adopt as the initial migration in `node-pg-migrate`.

The work concentrates in:

- `lib/contact-center/state-manager.js` — re-implement against Redis
- `lib/sse.js` — re-implement against Redis pub/sub (or WebSocket gateway)
- `app/api/voice/webhook/*` — split into thin receiver + worker
- `lib/postgres-schema.mjs` — convert to migration files, delete the boot-time DDL
- `lib/outbound-dialer/runner.js` — run inside the worker fleet under a distributed lock
- Anywhere `writeFile()` touches local disk — point at S3

## 5. Recommended sequencing

Don't do all of this at once. The order that minimizes thrash:

1. **Migrations tool + S3 for media.** No architectural change. Removes future friction.
2. **Redis for shared state.** Move state-manager + SSE fan-out behind Redis. App still runs as one process but is now ready to scale.
3. **Run 2+ replicas** behind ALB with sticky sessions. Validate everything still works.
4. **Extract webhook receiver + SQS + worker fleet.** This is the largest change but it's bounded.
5. **CDK-ize.** Once 2–4 are stable, the topology is what CDK will encode.
6. **Multi-region / DR.** Phase 2 of CDK.

Each step delivers value independently and can be paused at without leaving the system in a worse place.

## 6. Open questions

- **WebRTC scale-out:** Telnyx WebRTC SDK connections from agent browsers go directly to Telnyx, not through the app, so the app tier doesn't bottleneck. But the call-leg-mapping in `lib/mobile-call-leg-store.js` does need to be Redis-backed for cross-replica lookups.
- **Recording storage cost:** at scale, S3 storage for recordings is non-trivial. Investigate Telnyx Cloud Storage integration as an alternative.
- **Agent assist streaming:** `app/api/voice/streaming/ws-handler.js` (audio relay to Google/OpenAI) is currently a test endpoint. Productionizing it likely means a dedicated audio-relay service, not the same Fargate cluster as flow execution.
- **Disaster recovery RTO/RPO:** Multi-AZ RDS and ElastiCache give ~minute-scale failover. Multi-region would require cross-region Postgres replication and DNS failover — significant complexity. What does the SLA require?
