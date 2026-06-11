/**
 * WS3-T1 — Routing reactor (flag-gated, inert by default).
 *
 * Subscribes to `agent.available` and `call.enqueued` on the WS0 event bus
 * and triggers targeted routing re-evaluation, replacing latency of the
 * periodic poll with ~event-time reaction. Enabled only when
 * ROUTING_EVENT_DRIVEN=true.
 *
 * Safety properties:
 * - The reactor only calls offerQueuedCallForAgent / routeCall — the same
 *   entry points the periodic re-eval already uses; reservation atomicity
 *   (WS2) makes double-routing impossible even if an event fires while the
 *   periodic safety tick runs.
 * - Per-agent in-flight guard avoids piling up offers for one agent on a
 *   burst of events.
 * - The periodic safety re-eval stays on (cluster-wide, lease-gated) as the
 *   backstop for missed notifications.
 */

import { createDiagnosticLogger } from "../diagnostic-logger.mjs";
import { isEventDrivenRoutingEnabled } from "./routing-events.js";

const reactorLogger = createDiagnosticLogger("cc.routing-reactor", {
  config: {
    globalLevel: process.env.LOG_LEVEL || "info",
    topicLevels: { "cc.routing-reactor": process.env.LOG_ROUTING_REACTOR_LEVEL || "info" },
  },
});

const runtime = (globalThis.__cc_routing_reactor ||= {
  started: false,
  unsubscribes: [],
  inFlightAgents: new Set(),
});

async function handleAgentAvailable(payload) {
  const userId = payload?.userId ? String(payload.userId) : null;
  if (!userId) return;
  if (runtime.inFlightAgents.has(userId)) return; // coalesce bursts
  runtime.inFlightAgents.add(userId);
  try {
    const { offerQueuedCallForAgent } = await import("./queued-call-router.js");
    const result = await offerQueuedCallForAgent({ userId });
    reactorLogger.debug("routing_reactor_agent_available_handled", {
      agentUserId: userId,
      reason: payload?.reason || null,
      offerSuccess: result?.success,
      offerReason: result?.reason,
    });
  } catch (err) {
    reactorLogger.warn("routing_reactor_agent_available_error", {
      agentUserId: userId,
      error: err?.message || String(err),
    });
  } finally {
    runtime.inFlightAgents.delete(userId);
  }
}

async function handleCallEnqueued(payload) {
  const queueId = payload?.queueId ? String(payload.queueId) : null;
  if (!queueId) return;
  try {
    const { routeCall } = await import("./routing-engine.js");
    const result = await routeCall(queueId, {
      callControlId: payload?.callControlId || undefined,
      trigger: "event:call.enqueued",
    });
    reactorLogger.debug("routing_reactor_call_enqueued_handled", {
      queueId,
      callControlId: payload?.callControlId || null,
      routed: result?.success,
      reason: result?.reason,
    });
  } catch (err) {
    reactorLogger.warn("routing_reactor_call_enqueued_error", {
      queueId,
      error: err?.message || String(err),
    });
  }
}

/** Start the reactor (idempotent). No-op unless ROUTING_EVENT_DRIVEN=true. */
export async function startRoutingReactor() {
  if (!isEventDrivenRoutingEnabled()) return false;
  if (runtime.started) return true;
  runtime.started = true;
  try {
    const { subscribe } = await import("../events/event-bus.js");
    runtime.unsubscribes.push(
      await subscribe("agent.available", handleAgentAvailable),
    );
    runtime.unsubscribes.push(
      await subscribe("call.enqueued", handleCallEnqueued),
    );
    reactorLogger.info("routing_reactor_started", {});
    return true;
  } catch (err) {
    runtime.started = false;
    reactorLogger.error("routing_reactor_start_failed", {
      error: err?.message || String(err),
    });
    return false;
  }
}

/** Stop the reactor and release subscriptions (tests/shutdown). */
export async function stopRoutingReactor() {
  for (const unsubscribe of runtime.unsubscribes.splice(0)) {
    try {
      unsubscribe();
    } catch {
      /* already gone */
    }
  }
  runtime.started = false;
  runtime.inFlightAgents.clear();
}

export function isRoutingReactorStarted() {
  return runtime.started;
}
