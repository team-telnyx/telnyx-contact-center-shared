# 02 — Production-Readiness Gaps

> **Status:** Categorical blockers preventing horizontal scale-out. References target the codebase as inventoried in [01](./01-current-architecture.md).

## Summary

The codebase is well-structured enough to evolve into a production, distributed system — but it is **not** a "swap-in a load balancer" job. There are six categorical blockers that have to be solved (roughly in this order) before the app can run as more than one replica.

| # | Blocker | Why it blocks scale-out | Target solution |
|---|---------|-------------------------|-----------------|
| 1 | In-memory `globalThis` state | Replica A can't see Replica B's queue/agent state — routing, presence, and metrics diverge | Redis / ElastiCache as the authoritative real-time store; Postgres becomes the historical record |
| 2 | In-process SSE fan-out | A webhook on node A can't push events to a subscriber connected to node B | Redis Pub/Sub behind the existing `broadcastToKey` API, **or** move clients to API Gateway WebSocket / AppSync subscriptions |
| 3 | Synchronous webhook handlers calling Telnyx API inline | Slow Telnyx calls saturate the Next.js thread pool; no retry, no idempotency | Receiver does signature-verify + enqueue only → SQS / EventBridge → worker fleet handles flow execution. Idempotency key = Telnyx event ID |
| 4 | Per-process timers (5 of them) | N replicas = N× duplicate work, racing each other against Postgres | EventBridge Scheduler → Lambda (or ECS scheduled tasks) with a Redis-based distributed lock; or designate one "leader" via Redlock |
| 5 | Filesystem for recordings + uploads | Local `/public/uploads` and `TELNYX_RECORDING_PATH` are not shared across replicas | S3 with presigned URLs |
| 6 | Ensure-script migrations on every boot | Race conditions, no rollback, can't manage breaking schema changes safely | A real migration tool (`node-pg-migrate`, Flyway), run as a one-shot job |

The rest of this doc expands each gap with specific file references and rationale.

---

## Gap 1 — In-memory `globalThis` state

**Where it is:**
- `lib/contact-center/state-manager.js:94` — queues, agents, interactions
- `lib/sse.js:3` — SSE client registry
- `lib/call-monitor-store.js:8` — flow execution events
- `lib/mobile-call-leg-store.js:8` — WebRTC ↔ PSTN call leg mappings
- `lib/incoming-call-store.js:7` — caller metadata
- `lib/azure-speech-handler.mjs:6` — live speech sessions
- `lib/outbound-dialer/runner.js:4` — campaign timers

**Why it blocks scale-out:** if a webhook lands on replica A and updates `stateCache.agents`, no other replica sees that change until the 5-second `syncStateToDatabase()` flush — and even then, the other replicas don't reload from DB. Routing decisions made on replica B will use stale state.

**Target:** Redis / ElastiCache becomes the source of truth. The DB sync moves to a write-behind pattern (Redis → DB) rather than the current in-memory → DB scheme. Postgres holds the historical record and reporting data only.

**Migration shape:** the `state-manager.js` module's exported function surface (`enqueueCall`, `assignCallToAgent`, `getQueueState`, etc.) is a natural seam. Each function gets re-implemented against Redis primitives (HSET for agent state, ZSET for queues sorted by enqueue time, pub/sub for change notifications).

---

## Gap 2 — In-process SSE fan-out

**Where it is:** `lib/sse.js:41` (`broadcastToKey`) walks `globalThis.__sse_clients[key]` and writes to each `WritableStreamDefaultWriter` in-process.

**Why it blocks scale-out:** if an agent's browser connects to replica A and a webhook lands on replica B, the broadcast never reaches the agent. Sticky sessions via ALB partially solve this for the agent's own events, but cross-cutting broadcasts (`broadcastToAllAgents` at `lib/sse.js:67`) are broken either way.

**Two viable targets:**

1. **Minimal change:** keep SSE in Next.js, but replace `broadcastToKey` with publish-to-Redis-channel. Every replica subscribes to relevant channels and pushes to its locally-connected clients. Requires sticky sessions on the ALB. Implementation is roughly a 100-line patch to `lib/sse.js`.
2. **Bigger change, better outcome:** move clients to **API Gateway WebSocket** or **AppSync subscriptions**. The app tier becomes truly stateless — no more sticky sessions, deploys don't drop connections, and connection scale becomes someone else's problem.

The second option is recommended for production.

---

## Gap 3 — Synchronous webhook handlers

**Where it is:**
- `app/api/voice/webhook/route.js` — calls Telnyx API inline (`dial`, `bridge`)
- `app/api/voice/webhook/incoming/[flowId]/route.js` — runs the entire flow step inline
- `app/api/webhooks/telnyx/conversation-insights/route.js`

**Why it blocks scale-out:**

- A slow Telnyx response holds the request handler, eventually saturating the Node thread pool.
- There is no retry on Telnyx 5xx — webhook delivery is at-least-once from Telnyx, but the handler treats it as exactly-once.
- There is no idempotency key — replaying a webhook causes double-dials.

**Target:**

```
Telnyx webhook → API Gateway / ALB → Receiver service
                                       │
                                       ├── verify signature
                                       ├── dedupe by event_id (Redis SETNX)
                                       └── enqueue to SQS → ack 200

SQS → Flow Executor workers (Fargate, autoscaled)
        │
        ├── load flow state from Redis
        ├── execute node (call Telnyx API, with retries + circuit breaker)
        └── publish state changes / SSE events to Redis pub/sub
```

Telnyx event ID becomes the idempotency key. SQS DLQ catches anything the worker can't process.

---

## Gap 4 — Per-process timers

**Where it is:** five `setInterval` loops, all in `lib/contact-center/state-manager.js:290-329`, plus the outbound-dialer per-campaign `setTimeout` in `lib/outbound-dialer/runner.js:71`.

**Why it blocks scale-out:** with N replicas, every timer fires N times. The 10-second routing re-evaluation queries Postgres on every replica concurrently; the 5-second state sync flushes every replica's stale view of the world over each other.

**Target:**

- **Cron-style tasks** (cleanup, idle-time roll-up, ghost-call cleanup) → **EventBridge Scheduler** invoking Lambdas. Single instance per fire, no coordination needed.
- **Continuous tasks** (routing re-eval, outbound campaign tick) → run inside the flow-executor worker fleet, gated by a **Redis distributed lock** (Redlock-style). Only the lock-holder actually does the work; others no-op.
- **State sync** disappears entirely — state lives in Redis and is written through to Postgres asynchronously by a write-behind worker.

---

## Gap 5 — Filesystem storage

**Where it is:**
- `TELNYX_RECORDING_PATH` env var (defaults `./recordings/`) — local disk
- `app/api/admin/forms/media/route.js` — `writeFile()` to a local upload dir
- `app/api/admin/forms/media/pexels/route.js` — same

**Why it blocks scale-out:** uploads to replica A aren't visible to replica B. Telnyx recording downloads (if `TELNYX_RECORDING_PATH` is local) are similarly stranded on whichever node fetched them.

**Target:** **S3** with presigned URLs for client access. The recent media-route refactor (PRs #239–#242) is actually the right shape — it just needs to point at S3 instead of disk. Lifecycle rules handle retention (e.g., recordings 365d, form media indefinite).

---

## Gap 6 — Ensure-script migrations

**Where it is:** `lib/postgres-schema.mjs` runs DDL on every server boot via `CREATE TABLE IF NOT EXISTS` and ad-hoc `ALTER TABLE` statements.

**Why it blocks scale-out:**

- N replicas booting at once race to apply DDL.
- No way to roll back a bad migration.
- Breaking changes (column type changes, NOT NULL additions, index rebuilds on large tables) can't be staged safely.
- No version pinning between app code and schema — a rolled-back deploy may leave the schema ahead of the code.

**Target:** **`node-pg-migrate`** (or Flyway). Migrations live in a `migrations/` folder as versioned `.sql` (or `.js`) files. A one-shot ECS task runs migrations before any web/worker tasks come up. App boot no longer touches DDL.

---

## Secondary work (necessary but not hard blockers)

These don't prevent multi-node operation but should land before "production":

- **Observability** — OpenTelemetry traces, structured JSON logging, CloudWatch dashboards, alarms on queue depth / DLQ size / p99 latency. The existing `lib/contact-center/call-timeline-tracker.js` is the natural foundation for distributed tracing.
- **Secrets management** — AWS Secrets Manager (or Parameter Store) instead of `.env`. The existing `lib/telnyx-credentials.js` vault pattern is the right idea but the master key lives in env.
- **Circuit breakers** — wrap Telnyx / Azure / Google / Mailgun calls with retries + circuit breakers. A single slow upstream should not cascade into worker exhaustion.
- **Test suite** — there's a `tests/` folder with 40+ test files but no test runner configured in `package.json`. Wire up a runner and run on CI.
- **Schema versioning** — once on a real migration tool, tag schema versions and refuse to boot app code against a schema older/newer than expected.
