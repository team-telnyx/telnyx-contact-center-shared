import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const routingEnginePath = new URL(
  "../lib/contact-center/routing-engine.js",
  import.meta.url,
);
const queuedRouterPath = new URL(
  "../lib/contact-center/queued-call-router.js",
  import.meta.url,
);

async function source(path) {
  return readFile(path, "utf8");
}

test("WS2 routeCall reserves the selected agent before returning a routable assignment", async () => {
  const src = await source(routingEnginePath);

  assert.match(src, /reservation-manager\.js/);
  assert.match(src, /reserveAgent/);
  assert.match(src, /reservationId/);

  const reservationIndex = src.indexOf("await reserveAgent");
  const successIndex = src.indexOf("success: true");
  assert.ok(
    reservationIndex > -1,
    "routeCall must attempt a DB-backed reservation before success",
  );
  assert.ok(
    reservationIndex < successIndex,
    "reservation must happen before the successful routing result is returned",
  );

  assert.match(src, /interactionId:\s*callData\.interactionId/);
  assert.match(src, /queueId/);
  assert.match(src, /channel:\s*"inbound"/);
  assert.match(src, /reason:\s*"agent_reservation_failed"/);
  assert.match(src, /callData\.reserve\s*!==\s*false/);
});

test("WS2 reservation guard preserves zero-call agent capacity", async () => {
  const src = await source(
    new URL("../lib/contact-center/reservation-manager.js", import.meta.url),
  );

  assert.match(src, /max_concurrent_calls\s*\?\?\s*1/);
  assert.doesNotMatch(
    src,
    /Number\(lockedAgent\.max_concurrent_calls\)\s*\|\|\s*1/,
    "reservation capacity must not coerce max_concurrent_calls=0 to 1",
  );
});

test("WS2 reservation helpers do not reconnect an already-connected pg client", async () => {
  const src = await source(
    new URL("../lib/contact-center/reservation-manager.js", import.meta.url),
  );

  assert.match(src, /function isConnectedPgClient/);
  assert.match(src, /typeof value\.release === "function"/);
  assert.match(src, /value\.constructor\?\.name === "Client"/);
  assert.match(src, /if \(isConnectedPgClient\(poolOrClient\)\) \{/);

  const reconnectGuardIndex = src.indexOf("if (isConnectedPgClient(poolOrClient)) {");
  const poolConnectIndex = src.indexOf("await pool.connect()");
  assert.ok(
    reconnectGuardIndex > -1 && reconnectGuardIndex < poolConnectIndex,
    "already-connected pg clients must be used directly before falling back to pool.connect()",
  );
});

test("WS2 expired reservation restore delegates lifecycle status through the central handler", async () => {
  const reservationSrc = await source(
    new URL("../lib/contact-center/reservation-manager.js", import.meta.url),
  );

  assert.match(reservationSrc, /restoreAgentAfterExpiredReservation\(agentId, \{ client: db \}\)/);
  assert.match(reservationSrc, /handleAgentCallLifecycleStatus\([\s\S]*event:\s*"no-answer"/);
  assert.doesNotMatch(reservationSrc, /restoreAgentAvailableAfterFailedRinging/);
});

test("WS2 waiting reason re-evaluation uses routeCall in read-only mode", async () => {
  const src = await source(
    new URL("../lib/contact-center/waiting-reason-re-evaluator.js", import.meta.url),
  );

  assert.match(src, /routeCall\(interaction\.queue_id,\s*{[\s\S]*reserve:\s*false/);
});

test("WS2 queued-call-router reserves inside assignment and releases reservation on bridge failure", async () => {
  const src = await source(queuedRouterPath);

  assert.match(src, /reservation-manager\.js/);
  assert.match(src, /reserveAgent/);
  assert.match(src, /promoteReservation/);
  assert.match(src, /releaseReservation/);

  const beginIndex = src.indexOf('client.query("BEGIN")');
  const reserveIndex = src.indexOf("await reserveAgent");
  const updateIndex = src.indexOf("UPDATE cc_interactions");
  assert.ok(beginIndex > -1, "assignment must remain transactional");
  assert.ok(reserveIndex > beginIndex, "reservation must be made inside the assignment transaction");
  assert.ok(reserveIndex < updateIndex, "agent must be reserved before interaction state changes to ringing");

  assert.match(src, /routing_metadata = \$4::jsonb/);
  assert.match(src, /reservationId/);
  assert.match(src, /await promoteReservation\(reservationId,\s*"ringing"/);
  assert.match(src, /await releaseReservation\(reservationId/);
  assert.match(src, /reason:\s*"bridge_failed"/);
});

test("WS4 queued-call-router offer path uses DB-backed queued call and capacity lookups", async () => {
  const src = await source(queuedRouterPath);

  assert.match(src, /getQueuedInteractionsForQueuesFromDatabase/);
  assert.doesNotMatch(
    src,
    /getQueuedInteractionsForQueues[,\s}]/,
    "offer path must not depend on process-local queued interaction cache",
  );
  assert.doesNotMatch(
    src,
    /getRealtimeAgentMetrics/,
    "agent capacity in offer path must not depend on process-local interaction cache",
  );
  assert.match(src, /FROM cc_agent_reservations/);
  assert.match(src, /lease_expires_at > now\(\)/);
});
