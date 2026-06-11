/**
 * WS3-T2 — Singleton coordinator (flag-gated, inert by default).
 *
 * Runs cluster-wide maintenance exactly once across all nodes using the
 * WS0 advisory-lock leadership helper. Enabled only when
 * COORDINATOR_SINGLETON=true.
 *
 * Responsibilities (leader only):
 * - sweepExpiredReservations() — releases stale agent reservations
 *   (previously had no caller; expiry was only corrected opportunistically)
 * - pruneProcessedEvents() — GC for the cc_processed_events idempotency table
 * - startRoutingReactor() — event-driven re-evaluation (WS3-T1) when
 *   ROUTING_EVENT_DRIVEN is also enabled
 * - low-frequency safety re-eval backstop hook (provided by state-manager's
 *   existing lease-gated tick; the coordinator does not duplicate it)
 *
 * Existing per-node intervals in state-manager.js are NOT removed: they are
 * already lease-gated (cc-routing-re-eval, cc-agent-answer-timeouts) and act
 * as the safety backstop the plan requires. This coordinator adds the
 * missing sweeps and the reactor without touching live routing code paths.
 */

import { createDiagnosticLogger } from "../diagnostic-logger.mjs";

const TICK_INTERVAL_MS = 15_000;
const IDEMPOTENCY_GC_EVERY_TICKS = 240; // ~1h at 15s ticks

const coordinatorLogger = createDiagnosticLogger("cc.coordinator", {
  config: {
    globalLevel: process.env.LOG_LEVEL || "info",
    topicLevels: { "cc.coordinator": process.env.LOG_COORDINATOR_LEVEL || "info" },
  },
});

const runtime = (globalThis.__cc_coordinator ||= {
  started: false,
  controller: null,
});

export function isCoordinatorEnabled() {
  return (
    String(process.env.COORDINATOR_SINGLETON || "false").toLowerCase() === "true"
  );
}

async function runLeaderLoop({ signal }) {
  const { sweepExpiredReservations } = await import("./reservation-manager.js");
  const { pruneProcessedEvents } = await import("../events/idempotency.js");
  const { startRoutingReactor, stopRoutingReactor } = await import(
    "./routing-reactor.js"
  );

  await startRoutingReactor();

  let tick = 0;
  while (!signal.aborted) {
    tick += 1;
    try {
      const released = await sweepExpiredReservations();
      if (released && released.length > 0) {
        coordinatorLogger.info("coordinator_reservation_sweep", {
          releasedCount: released.length,
        });
      }
    } catch (err) {
      coordinatorLogger.warn("coordinator_reservation_sweep_failed", {
        error: err?.message || String(err),
      });
    }

    if (tick % IDEMPOTENCY_GC_EVERY_TICKS === 0) {
      try {
        const pruned = await pruneProcessedEvents({ olderThanHours: 24 });
        coordinatorLogger.info("coordinator_idempotency_gc", { pruned });
      } catch (err) {
        coordinatorLogger.warn("coordinator_idempotency_gc_failed", {
          error: err?.message || String(err),
        });
      }
    }

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, TICK_INTERVAL_MS);
      if (typeof timer.unref === "function") timer.unref();
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  await stopRoutingReactor();
}

/** Start the coordinator (idempotent). No-op unless COORDINATOR_SINGLETON=true. */
export async function startCoordinator() {
  if (!isCoordinatorEnabled()) return false;
  if (runtime.started) return true;
  runtime.started = true;
  const { withLeadership } = await import("../coordinator/leadership.js");
  runtime.controller = withLeadership("cc-coordinator", runLeaderLoop);
  coordinatorLogger.info("coordinator_started", {});
  return true;
}

/** Stop the coordinator (tests/shutdown). */
export async function stopCoordinator() {
  if (runtime.controller) {
    await runtime.controller.stop();
    runtime.controller = null;
  }
  runtime.started = false;
}

export function isCoordinatorStarted() {
  return runtime.started;
}
