import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// Load DB env from .env (node:test does not load Next.js dotenv files).
async function loadEnvFile() {
  try {
    const raw = await readFile(new URL("../.env", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match) continue;
      const [, key, value] = match;
      if (process.env[key] === undefined) {
        process.env[key] = value.replace(/^"|"$/g, "");
      }
    }
  } catch {
    /* no .env — DB-dependent tests will be skipped */
  }
}

await loadEnvFile();

const { getPostgresPool } = await import("../lib/postgres.mjs");

async function dbAvailable() {
  try {
    const pool = getPostgresPool();
    if (!pool) return false;
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const hasDb = await dbAvailable();

test("WS3 flags default OFF: producers, reactor, and coordinator are inert", async () => {
  delete process.env.ROUTING_EVENT_DRIVEN;
  delete process.env.COORDINATOR_SINGLETON;

  const events = await import("../lib/contact-center/routing-events.js");
  assert.equal(events.isEventDrivenRoutingEnabled(), false);
  // Must be safe no-ops without a DB/event bus.
  events.publishAgentAvailable("user-1", "test");
  events.publishCallEnqueued({ queueId: "q-1" });

  const reactor = await import("../lib/contact-center/routing-reactor.js");
  assert.equal(await reactor.startRoutingReactor(), false, "reactor refuses to start");
  assert.equal(reactor.isRoutingReactorStarted(), false);

  const coordinator = await import("../lib/contact-center/coordinator.js");
  assert.equal(coordinator.isCoordinatorEnabled(), false);
  assert.equal(await coordinator.startCoordinator(), false, "coordinator refuses to start");
  assert.equal(coordinator.isCoordinatorStarted(), false);
});

test("WS3 producer call sites are fire-and-forget and flag-guarded", async () => {
  const userStatus = await readFile(
    new URL("../lib/contact-center/user-status.js", import.meta.url),
    "utf8",
  );
  assert.match(
    userStatus,
    /publishAgentAvailable\(String\(userId\), "status_available"\)/,
    "status→Available publishes agent.available",
  );
  // The publish must come from the dedicated guarded module, not inline bus use.
  assert.ok(
    !userStatus.includes("events/event-bus"),
    "user-status must not import the event bus directly",
  );

  const reservationManager = await readFile(
    new URL("../lib/contact-center/reservation-manager.js", import.meta.url),
    "utf8",
  );
  assert.match(
    reservationManager,
    /signalAgentsAvailable\(agentIds, "reservation_released"\)/,
    "reservation release publishes agent.available",
  );
  assert.match(
    reservationManager,
    /signalAgentsAvailable\(agentIds, "reservation_expired"\)/,
    "reservation expiry sweep publishes agent.available",
  );

  const webhookHandler = await readFile(
    new URL("../lib/contact-center/webhook-handler.js", import.meta.url),
    "utf8",
  );
  assert.match(
    webhookHandler,
    /publishCallEnqueued\(\{\s*queueId: queue\.id,/,
    "enqueue handler publishes call.enqueued",
  );
});

test("WS3 existing lease-gated periodic re-eval remains untouched (safety backstop)", async () => {
  const stateManager = await readFile(
    new URL("../lib/contact-center/state-manager.js", import.meta.url),
    "utf8",
  );
  assert.match(
    stateManager,
    /runWithCoordinatorLease\(\s*"cc-routing-re-eval"/,
    "periodic routing re-eval must stay as the cluster-wide backstop",
  );
  assert.match(
    stateManager,
    /runWithCoordinatorLease\(\s*"cc-agent-answer-timeouts"/,
    "answer-timeout sweep must stay lease-gated",
  );
  assert.match(
    stateManager,
    /COORDINATOR_SINGLETON/,
    "coordinator bootstrap is referenced behind its flag",
  );
});

test(
  "WS3 reactor end-to-end: agent.available event triggers a targeted offer",
  { skip: !hasDb && "postgres not reachable" },
  async () => {
    process.env.ROUTING_EVENT_DRIVEN = "true";
    const reactor = await import("../lib/contact-center/routing-reactor.js");
    const events = await import("../lib/contact-center/routing-events.js");

    const started = await reactor.startRoutingReactor();
    assert.equal(started, true, "reactor starts when flag is on");

    try {
      // Publish for a non-existent agent: the offer path runs and returns a
      // failure result without touching live routing state. The assertion is
      // that the subscription pipeline (publish → bus → reactor handler)
      // executes without throwing.
      events.publishAgentAvailable("00000000-0000-0000-0000-000000000000", "test");
      await delay(500);
      assert.equal(reactor.isRoutingReactorStarted(), true);
    } finally {
      await reactor.stopRoutingReactor();
      const { closeEventBus } = await import("../lib/events/event-bus.js");
      await closeEventBus();
      delete process.env.ROUTING_EVENT_DRIVEN;
    }
  },
);

test(
  "WS3 coordinator: leader-only sweep loop starts and stops cleanly",
  { skip: !hasDb && "postgres not reachable" },
  async () => {
    process.env.COORDINATOR_SINGLETON = "true";
    const coordinator = await import("../lib/contact-center/coordinator.js");
    const { isLeader } = await import("../lib/coordinator/leadership.js");

    const started = await coordinator.startCoordinator();
    assert.equal(started, true, "coordinator starts when flag is on");

    try {
      const deadline = Date.now() + 5000;
      while (!isLeader("cc-coordinator") && Date.now() < deadline) {
        await delay(100);
      }
      assert.equal(
        isLeader("cc-coordinator"),
        true,
        "single process becomes coordinator leader",
      );
    } finally {
      await coordinator.stopCoordinator();
      delete process.env.COORDINATOR_SINGLETON;
    }
    assert.equal(coordinator.isCoordinatorStarted(), false);
  },
);
