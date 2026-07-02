# 01 — Current Architecture

> **Status:** Description of the system as it exists on `master` today. File and line references are accurate as of the assessment.

## 1. Runtime shape

A **Next.js 15 monolith** running as a single Node process. Postgres is the only out-of-process dependency required for the system to function. Everything that matters in real-time lives inside that one Node process.

```
┌──────────────────────────────────────────────┐
│           Single Next.js process             │
│                                              │
│  HTTP handlers  ──┐                          │
│  SSE streams    ──┤                          │
│  Webhook intake ──┼──► globalThis.* state    │
│  Background     ──┤    (Maps, Sets, timers)  │
│  intervals      ──┘                          │
│                                              │
└──────────────┬───────────────────────────────┘
               │
               ▼
        ┌──────────────┐
        │  PostgreSQL  │  ← durable storage,
        └──────────────┘    schema upgraded on each boot
```

External integrations (Telnyx, Azure Speech, Google GenAI, ElevenLabs, Mailgun) are called inline from request handlers using `fetch` or vendor SDKs — no connection pooling, retry queues, or circuit breakers.

## 2. In-memory state inventory

All authoritative real-time state is stored on `globalThis.*` (to survive Next.js HMR in dev). None of it survives a process restart, and none of it is visible to another replica.

| Subsystem | File | Mechanism |
|-----------|------|-----------|
| Agent / queue / interaction state | `lib/contact-center/state-manager.js:94` | `globalThis.__cc_state_manager_runtime` → Maps of queues, agents, interactions |
| SSE client registry | `lib/sse.js:3` | `globalThis.__sse_clients` → `Map<key, Set<WritableStreamDefaultWriter>>` |
| Call monitor events | `lib/call-monitor-store.js:8` | Three Maps (webhooks/commands, flow-by-runId, execution events), 1-hour TTL |
| WebRTC ↔ PSTN call leg mappings | `lib/mobile-call-leg-store.js:8` | Three Maps keyed by session / callControlId / leg |
| Incoming call metadata | `lib/incoming-call-store.js:7` | Module-level Map, no TTL |
| Azure speech sessions | `lib/azure-speech-handler.mjs:6` | `globalThis.__azureTelnyxSessions` keyed by callControlId |
| Outbound dialer campaign runners | `lib/outbound-dialer/runner.js:4` | `globalThis.__outboundAgentlessRunners` with per-campaign `setTimeout` chains |
| Postgres pool | `lib/postgres.mjs:4` | `global.__pg_pool`, default `max: 5` connections per process |

## 3. Background work (per-process timers)

All triggered by `setInterval` inside the web tier:

| Task | Where | Interval |
|------|-------|----------|
| State sync to DB | `lib/contact-center/state-manager.js:290` | 5 s |
| Routing re-evaluation for available agents | `lib/contact-center/state-manager.js:296` | 10 s |
| Agent answer-timeout check | `lib/contact-center/state-manager.js:309` | 5 s |
| Call monitor cleanup (>1h old) | `lib/call-monitor-store.js:263` | 10 min |
| Outbound dialer campaign tick | `lib/outbound-dialer/runner.js:71` | 250 ms – 5 s, dynamic |
| Ghost call cleanup | `lib/ghost-call-cleanup.mjs` | One-shot on boot |

There is no distributed lock or leader election — every replica that boots will run every timer.

## 4. Webhook intake

| Endpoint | File | Verifies signature | Writes DB | Emits SSE | Calls Telnyx API |
|----------|------|--------------------|-----------|-----------|------------------|
| Primary voice webhook | `app/api/voice/webhook/route.js` | Yes | Yes (`cc_interactions` upsert + `webhook-handler.js`) | Yes (agent/queue) | Yes (dial / bridge inline) |
| Flow-scoped webhook | `app/api/voice/webhook/incoming/[flowId]/route.js` | Yes | Yes (interaction + flow execution) | Yes (flow execution events) | Conditional |
| Conversation insights | `app/api/webhooks/telnyx/conversation-insights/route.js` | Custom header check | Yes (AI insights) | Conditional | No |

Webhook handlers do everything inline: verify signature → write DB → call Telnyx → broadcast SSE. There is no queue between intake and execution and no idempotency keying on the Telnyx event ID.

## 5. Real-time channels (SSE)

| Channel | Endpoint | Subscriber key |
|---------|----------|----------------|
| Agent status | `/api/contact-center/agent/stream` | `contact-center:agent:{username}` |
| Queue / supervisor monitor | `/api/contact-center/monitor/stream` | `monitors:{supervisor_id}` |
| Outbound live calls | `/api/contact-center/outbound-dialer/live-calls/stream` | Campaign-scoped |
| Flow monitor | `/api/voice/flows/[id]/monitor-stream` | Flow-scoped |
| User status broadcast | `/api/user/status-stream` | All agents (queries users table per event) |

All fan-out goes through `broadcastToKey()` in `lib/sse.js:41`, which walks the in-process `__sse_clients` Set. A second replica will never see clients connected to the first replica.

There is also a WebSocket handler at `app/api/voice/streaming/ws-handler.js` for streaming AI audio relay, but it is marked as a test endpoint and has no auth.

## 6. Database layer

- **Pool:** single `pg.Pool` per process (`lib/postgres.mjs:4`), default `max: 5`, override via `POSTGRES_POOL_MAX`.
- **Schema:** single shared schema for all data. No `tenant_id` / `org_id` / `account_id` column anywhere. Multi-user only.
- **Migrations:** `lib/postgres-schema.mjs` runs `CREATE TABLE IF NOT EXISTS` + ad-hoc `ALTER TABLE` statements on every server boot. No versioning, no rollback, no separate migration tool.
- **Deadlock handling:** retry-with-jitter exists only inside `syncStateToDatabase()` (`state-manager.js:561`); all other queries fail immediately on deadlock.

## 7. Auth & tenancy

- **NextAuth.js** with a custom Postgres adapter (`lib/nextauth-pg-adapter.js`).
- Local auth (PBKDF2) + optional Google OAuth.
- Roles stored as a TEXT[] array on `users.roles` (`agent`, `supervisor`, `admin`).
- **No tenant concept.** All authenticated users share the same queues/agents/skills/flows. Role-based filtering happens in application code, not at the DB layer (no RLS).

## 8. Filesystem usage

| Use case | Location |
|----------|----------|
| Call recordings | Path from `TELNYX_RECORDING_PATH` env (defaults `./recordings/`) |
| Form media uploads | `app/api/admin/forms/media/route.js` writes via `writeFile(fullPath, buffer)` to a configured upload dir |
| Pexels media cache | `app/api/admin/forms/media/pexels/route.js` writes to the same upload dir |

Recent commits (#239–#242) reshape media serving through a route handler, but the storage backend is still local disk. Multi-node deployments would require either a shared volume or an S3 migration.

## 9. External integrations

All called synchronously from request handlers:

| Provider | Used for | Auth |
|----------|----------|------|
| Telnyx Voice API | Dial / bridge / hangup / transfer / hold / resume | `TELNYX_API_KEY` |
| Telnyx WebRTC | Agent softphone | Same key |
| Azure Cognitive Services Speech | Real-time STT / TTS streaming | API key (env) |
| Google Generative AI | Agent assist | `@google/genai` SDK |
| ElevenLabs | Queue TTS announcements | Vault-encrypted key |
| Mailgun | Transactional email | `EMAIL_API_KEY` |

No retries, rate-limit awareness, or circuit breakers. A slow Telnyx response blocks the Next.js request handler that called it.

## 10. Config & secrets

Loaded from `.env` (see `.env.example` and `sample.env`). Categories:

- App: `NEXTAUTH_SECRET`, `SECRETS_ENCRYPTION_KEY`, `NEXTAUTH_URL`, `NEXT_PUBLIC_BASE_URL`, `APP_BASE_URL`
- Database: `POSTGRES_*`
- Telnyx: `TELNYX_API_KEY`, `TELNYX_WEBHOOK_SECRET`, `TELNYX_AI_API_KEY`, `TELNYX_BASE_PATH`, `TELNYX_CALL_CONTROL_ID`, `TELNYX_OUTBOUND_VOICE_PROFILE`, `TELNYX_SIP_CONNECTION_ID`, `TELNYX_RECORDING_PATH`, `TELNYX_MAIN_FROM_NUMBER`, `TELNYX_SUPERVISOR_FROM_NUMBER`
- Email: `EMAIL_API_KEY`, `EMAIL_DOMAIN`, `EMAIL_FROM`
- OAuth: `GOOGLE_ID`, `GOOGLE_SECRET`
- AI: ElevenLabs/Azure keys (some via vault references in DB)
- Optional: `ALLOWED_EMAIL_DOMAINS`

Single API key per provider — no rotation, sharding, or per-region keys.
