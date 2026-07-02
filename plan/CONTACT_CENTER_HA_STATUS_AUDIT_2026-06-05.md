# Contact Center HA / DB-Authoritative Status Audit — 2026-06-05

**Scope:** audit of the current `master` implementation after PR #700 and PR #701 against `Contact-Center-Routing-Outbound-HA-Implementation-Plan.pdf`.

**Repository:** `/Users/leszek/Documents/dev/telnyx-contact-center`

**Audit intent:** confirm what is already aligned with the HA plan, identify remaining multi-node / DB-authoritative blockers, and answer whether current status tracking is enough for exact agent work reports.

---

## Executive summary

The implementation is now materially closer to the HA plan than the original baseline described in the PDF:

- `users.status` and `users.agent_status` are no longer present in the live DEV database and are dropped by `ensurePostgresSchema()`.
- `cc_agent_state.agent_status` is the Contact Center status authority for status API, routing, state manager, supervisor stats, and queue-agent lookup.
- Agent reservation primitives exist in `cc_agent_reservations`, and core inbound routing paths call `reserveAgent()` before assignment.
- DB-backed webhook idempotency exists through `cc_processed_events` and `alreadyProcessed()`.
- DB-backed coordinator leases exist through `cc_coordinator_leases`; periodic routing re-evaluation and answer-timeout sweeps are lease-gated.
- Server-authoritative Wrapup recovery was added in PR #701: `status_changed: Wrapup` in SSE triggers the global wrapup sheet, with a 5s polling safety net.

However, the system is **not yet fully multi-node HA-ready**. The biggest remaining blockers are:

1. **SSE fan-out is still node-local.** `lib/sse.js` keeps connected clients in `globalThis.__sse_clients`. This works per process, but a status event produced on node A will not reach a browser connected to node B unless there is sticky routing or a cross-node event bus.
2. **Some flow/webhook dedupe state is still in memory.** Contact Center lifecycle events use DB-backed idempotency, but the voice flow route still has `executedTransitions` and `completedFlows` as process-local `Map`s.
3. **`cc_user_time_tracking` is not sufficient as the source of truth for exact per-status reports.** It is an hourly aggregate with fixed status buckets. Exact reporting must use an immutable transition ledger (`cc_agent_status_history` / `cc_user_activity_log`) plus current open interval from `cc_agent_state`.
4. **Status history exists but needs hardening before relying on it for production-grade exact reports.** Current schema stores `agent_username`, not `user_id`; `created_at` is the transition/end timestamp; `duration_seconds` represents the previous status duration; current open status interval must be calculated separately from `cc_agent_state.last_status_change`.
5. **DB-authoritative read model is improved, but in-memory/cache surfaces still exist.** They should be treated as read models only, never as the routing/status source of truth.

---

## Requirements re-read from the HA PDF

The PDF plan requires the following invariants and primitives:

### Required invariants

- Agent must never be assigned more concurrent calls than `max_concurrent_calls`.
- Agent in `Wrapup`, `Agent Not Answering`, break, or `Offline` must never be offered a call.
- One call must never be delivered to two agents.
- After an answered call ends, the observable path should be `Busy -> Wrapup`; there must be no visible `Available` gap in between.
- Outbound / blended routing must build on the same reservation primitive rather than a separate capacity mechanism.

### Required architecture primitives

- `cc_agent_state.agent_status` as the authoritative status field.
- A single status transition writer/state machine.
- Atomic reservation and capacity claim through `cc_agent_reservations`.
- DB-backed idempotency for webhooks/internal transition events.
- Leader/coordinator lease for singleton background jobs.
- Event bus abstraction: `LISTEN/NOTIFY` or equivalent now, Redis/event bus later.
- Cross-node fan-out for agent UI / supervisor UI SSE streams.
- Read-only caches are allowed, but routing correctness must not depend on node-local memory.

---

## Live DEV database verification

Read-only checks against the configured DEV Postgres database returned:

- Database: `contact_center`
- `users.status`: **does not exist**
- `users.agent_status`: **does not exist**
- `cc_agent_state` includes: `agent_status`, `last_status_change`, `available_since`, `wrapup_expires_at`, `status_reason`, `active_channel`
- `cc_agent_reservations`: exists
- `cc_processed_events`: exists
- `cc_coordinator_leases`: exists
- `cc_agent_status_history`: exists, currently 0 rows in DEV
- `cc_user_time_tracking`: exists, currently 0 rows in DEV

This confirms the legacy user status columns are removed in DEV and cannot accidentally be queried there.

---

## Current implementation inventory

### Schema / ensure scripts

Relevant files:

- `lib/postgres-schema.mjs`
- `lib/postgres.mjs`

Current state:

- `ensurePostgresSchema()` drops `users.status` and `users.agent_status` idempotently.
- `cc_agent_state` is created/maintained with `agent_status`, `current_calls_count`, `last_status_change`, `available_since`, `wrapup_expires_at`, `status_reason`, `active_channel`.
- `cc_agent_reservations` exists with active indexes for `(agent_id)` where state is `reserved/ringing/active`.
- `cc_processed_events` exists for DB-backed idempotency.
- `cc_coordinator_leases` exists for HA-safe singleton periodic work.
- `cc_agent_status_history` exists as a transition ledger.
- `cc_user_time_tracking` exists as hourly aggregate reporting data.

Assessment: **mostly aligned** with WS0–WS4 foundations from the PDF.

### Status writer / state authority

Relevant files:

- `lib/contact-center/user-status.js`
- `lib/contact-center/agent-status-transition.js`
- `lib/contact-center/agent-call-lifecycle-status.js`
- `app/api/contact-center/agent/status/route.js`
- `app/api/user/status-stream/route.js`

Current state:

- `setUserStatus()` persists into `cc_agent_state` under row lock (`FOR UPDATE`).
- `setUserStatus()` reads back persisted status after `offerQueuedCallForAgent()` so the API/SSE does not blindly broadcast stale `Available` when routing immediately marks the agent `Busy`.
- Lifecycle handler uses `handleAgentCallLifecycleStatus()` to drive call-related status transitions.
- `markAgentBusyForRinging()` now requires live DB evidence in reservations/interactions before forcing `Busy`, avoiding ghost `current_calls_count`.
- Status broadcasts include `status_changed` events for agent/user/supervisor channels.

Assessment: **aligned for DB-authoritative status**, with one reporting caveat: the status-history insert uses the requested `status`, while user-facing broadcast uses `broadcastStatus`. If auto-offer changes the persisted state immediately after `Available`, history must be audited to ensure it records the actual effective transition sequence, not only the requested state.

### Routing and capacity

Relevant files:

- `lib/contact-center/reservation-manager.js`
- `lib/contact-center/queued-call-router.js`
- `lib/contact-center/routing-engine.js`
- `lib/contact-center/stats-aggregator.js`
- `lib/contact-center/agent-answer-timeout.js`

Current state:

- `reserveAgent()` locks the agent row and inserts guarded reservation rows.
- `queued-call-router.js` and `routing-engine.js` both call `reserveAgent()` before assigning/offering.
- `queued-call-router.js` uses `cc_agent_state.agent_status` and live reservation/interaction evidence for capacity checks.
- `stats-aggregator.js` no longer depends on stale in-memory counters for active calls; active calls are counted from live interactions.
- Answer timeout handling now covers pre-answer ringing/queued states and clears/requeues through lifecycle helpers.

Assessment: **substantially aligned** with WS2, but still keep an eye on divergent routing behavior between `routing-engine.js` and `queued-call-router.js`. They now share reservations, but selection/scoring is still split.

### SSE and real-time UI cache

Relevant files:

- `lib/sse.js`
- `app/api/user/status-stream/route.js`
- `components/site-header.jsx`
- `components/contact-center/AgentDesktop.jsx`
- `components/contact-center/GlobalWrapupSheet.jsx`

Current state:

- Status events are delivered through `status_changed` SSE.
- Agent Desktop, site header, and Global Wrapup Sheet listen for `status_changed`.
- PR #701 added Wrapup recovery: when UI observes `Wrapup`, it reloads interactions and opens the disposition sheet if needed.
- There is a 5s polling safety net while in Wrapup.
- `lib/sse.js` stores clients in `globalThis.__sse_clients`.

Assessment: **good single-node behavior**, but **multi-node blocker remains** because SSE fan-out is process-local.

### In-memory stores / caches

Relevant files:

- `lib/contact-center/state-manager.js`
- `lib/contact-center/webhook-handler.js`
- `app/api/voice/webhook/incoming/[flowId]/route.js`
- `lib/agent-assist-transcription-router.mjs`
- `lib/telnyx-stt-handler.mjs`

Current state:

- `state-manager.js` keeps `stateCache` in `globalThis`, clears it at startup to avoid stale ghost calls, and syncs to DB every 5s.
- Routing-critical periodic workers are DB-lease-gated.
- Contact Center webhook lifecycle processing uses DB-backed idempotency via `cc_processed_events`.
- The incoming flow webhook route still has process-local `executedTransitions` and `completedFlows` maps.
- STT / Agent Assist stream session maps are process-local, which is acceptable for per-connection media/stream state if traffic is sticky per call/session, but should not be used as a routing authority.

Assessment: **partially aligned**. Routing-critical state is now much safer; cross-node flow dedupe and event distribution still need work.

---

## Status tracking / reporting assessment

### Is `cc_user_time_tracking` enough?

No — not by itself.

`cc_user_time_tracking` is an hourly aggregate table. It stores counters like:

- `status_available_seconds`
- `status_busy_seconds`
- `status_away_seconds`
- `status_on_queue_seconds`
- `status_off_queue_seconds`
- `call_seconds`
- `queue_active_seconds`
- counts for login/status/queue/calls

Limitations:

- It only has fixed columns for selected statuses.
- It does not preserve an exact transition timeline.
- It cannot accurately represent arbitrary custom statuses without schema changes.
- It is updated asynchronously from activity logging, so it is a summary/read model, not the source of truth.
- It is awkward for queries like “exactly how long was agent X in every status between 09:13 and 14:37?” because hourly buckets need boundary handling and do not retain all transitions.

### What should be used as source of truth for exact status reports?

Use the transition ledger plus current state:

- `cc_agent_status_history` — transition records written by the current status-change implementation; not yet a completed-interval source until the hardening below adds explicit interval fields and clarified semantics.
- `cc_user_activity_log` — currently logs `status_change` with `started_at`, `ended_at`, and `duration_seconds`.
- `cc_agent_state` — current open interval via `agent_status` and `last_status_change`.

Until `cc_agent_status_history` stores explicit completed intervals, exact reports should derive closed intervals from `cc_user_activity_log` and use `cc_agent_state` only for the current open interval.

The exact-report query pattern should be:

1. Take all closed status intervals from the ledger/activity log within the requested reporting window.
2. Clip each interval to the requested `[from, to]` window.
3. Add the current open interval from `cc_agent_state.last_status_change` to report end time.
4. Group by `user_id` and status.

### Current hardening needed before production reporting

Recommended changes:

- Add `user_id` to `cc_agent_status_history`; keep `agent_username` only as denormalized display data.
- Store explicit `started_at` and `ended_at` on `cc_agent_status_history`, not only `created_at + duration_seconds`.
- Store `status` as the status whose interval just ended, and `next_status` or `transition_to` separately. The current insert shape (`status`, `previous_status`, `duration_seconds`) is easy to misread.
- Ensure history is written inside the same transaction as `cc_agent_state` transition or by a reliable DB/event pipeline; do not rely on best-effort async logging for exact compliance reports.
- Expand aggregate generation to dynamic per-status summaries or keep aggregates as a pure optimization over the canonical ledger.

---

## Comparison to HA plan workstreams

### WS0 — Foundations

Status: **mostly complete**

Implemented:

- Routing foundation columns on `cc_agent_state`.
- `cc_agent_reservations` table and indexes.
- `cc_processed_events` table.
- `cc_coordinator_leases` table.
- Contract/regression tests covering DB-authoritative status and reservations.

Remaining:

- A real event bus abstraction is still missing. `lib/sse.js` is direct process-local broadcasting.

### WS1 — Status authority and server-authoritative Wrapup

Status: **mostly complete**

Implemented:

- `users.status` and `users.agent_status` removed.
- `cc_agent_state.agent_status` is authoritative.
- Wrapup recovery is server/status driven.
- UI listens for `Wrapup` and opens disposition sheet.

Remaining:

- Harden status history semantics for exact reporting.
- Continue verifying no non-status modules write `cc_agent_state.agent_status` directly.

### WS2 — Atomic reservation and unified routing

Status: **partially complete / good foundation**

Implemented:

- `reserveAgent()` primitive.
- Guarded reservations in inbound/queued routing.
- Live DB evidence for `Busy` transitions.
- Active calls stats read from interactions rather than stale memory.

Remaining:

- Fully unify `routing-engine.js` and `queued-call-router.js` selection logic or clearly define one as selector and one as offer/promotion layer.
- Add end-to-end race tests under concurrent offers across multiple simulated nodes/processes.

### WS3 — Event-driven re-evaluation and singleton workers

Status: **partial**

Implemented:

- Periodic re-evaluation and answer timeout checks are DB-lease-gated.

Remaining:

- Routing is still interval-driven, not fully event-driven from DB notifications/event bus.
- `syncStateToDatabase()` still runs per node; it should remain harmless/read-model-only or be replaced with DB/event-driven refresh.

### WS4 — Idempotency and cross-node fan-out

Status: **partial; this is the main HA blocker**

Implemented:

- Contact Center webhook idempotency through `cc_processed_events`.

Remaining:

- Cross-node SSE fan-out.
- DB-backed idempotency for voice flow transition dedupe currently held in process-local maps.
- Pruning job for processed events should be explicit and lease-gated if not already wired elsewhere.

---

## Recommended next steps

### P0 — close production correctness/reporting gaps

1. Harden `cc_agent_status_history`:
   - add `user_id`, `started_at`, `ended_at`, `from_status`, `to_status`, `reason`, `interaction_id`, `source_event_id`;
   - write it transactionally with `cc_agent_state` updates.
2. Add report query/API for exact status durations over arbitrary windows:
   - source from ledger + current `cc_agent_state` open interval;
   - use `cc_user_time_tracking` only as optimization/summary.
3. Audit `setUserStatus()` history behavior when `Available` immediately triggers auto-offer and effective status becomes `Busy`.

### P1 — close multi-node HA blockers

1. Introduce an event bus layer:
   - short term: Postgres `LISTEN/NOTIFY` channel for `status_changed`, `queue_changed`, `interaction_changed`;
   - longer term: Redis/pubsub or managed event bus.
2. Change `lib/sse.js` to subscribe to the bus and fan out to local clients on every node.
3. Move process-local flow dedupe (`executedTransitions`, `completedFlows`) to DB-backed processed events / transition ledger.
4. Add multi-node simulation tests: two app instances, shared DB, clients attached to different nodes.

### P2 — clean architecture/read-model work

1. Make state-manager cache explicitly read-only for UI metrics, never a write authority for status/capacity.
2. Collapse duplicate routing decision logic into one selector + one reservation/promotion path.
3. Add observability dashboards/queries for:
   - reservation conflicts,
   - duplicate webhook drops,
   - coordinator lease owner changes,
   - status transition durations,
   - orphan reservations/interactions.

---

## Acceptance checklist for “HA-ready enough to scale horizontally”

- [x] `users.status` removed from schema and DEV DB.
- [x] `users.agent_status` removed from schema and DEV DB.
- [x] Status API reads/writes `cc_agent_state.agent_status`.
- [x] Inbound routing uses DB reservations.
- [x] Active-call stats are derived from live interactions, not stale memory.
- [x] Wrapup sheet can recover from DB-authoritative `Wrapup` status.
- [x] Background routing/timeout jobs are lease-gated.
- [x] Contact Center lifecycle webhook idempotency is DB-backed.
- [ ] SSE events are cross-node fan-out capable.
- [ ] Voice flow transition dedupe is DB-backed.
- [ ] Exact status reporting has canonical intervals with `user_id`, `started_at`, `ended_at`.
- [ ] Status history is transactionally coupled to `cc_agent_state` transitions.
- [ ] Multi-node race/load tests pass.

---

## Bottom line

For the specific `users.status` concern: the live DEV database confirms the column is gone, and the schema ensure script keeps it gone. The codebase has tests asserting Contact Center status must not read/write the legacy user status columns.

For agent status reporting: there is a foundation, but `cc_user_time_tracking` alone is not sufficient. Use it as a summary table. The canonical source for exact “time spent in status” reports should be a hardened transition ledger plus the current open interval from `cc_agent_state`.
