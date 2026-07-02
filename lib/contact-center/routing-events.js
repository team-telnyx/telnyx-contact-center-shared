/**
 * WS3 — Routing event producers (flag-gated, inert by default).
 *
 * Thin wrappers that publish routing signals on the WS0 event bus. Every
 * function is a no-op unless ROUTING_EVENT_DRIVEN=true, and every publish is
 * fire-and-forget (best-effort): a bus failure can never affect the calling
 * routing/status code path. The DB remains the source of truth; the
 * coordinator's periodic safety re-eval catches anything the bus misses.
 */

import { createDiagnosticLogger } from "../diagnostic-logger.mjs";

const eventsLogger = createDiagnosticLogger("cc.routing-events", {
  config: {
    globalLevel: process.env.LOG_LEVEL || "info",
    topicLevels: { "cc.routing-events": process.env.LOG_ROUTING_EVENTS_LEVEL || "warn" },
  },
});

export function isEventDrivenRoutingEnabled() {
  return (
    String(process.env.ROUTING_EVENT_DRIVEN || "false").toLowerCase() === "true"
  );
}

function firePublish(topic, payload) {
  // Dynamic import keeps the event bus fully out of module graphs (and out
  // of test doubles) when the flag is off.
  import("../events/event-bus.js")
    .then(({ publish }) => publish(topic, payload))
    .catch((err) => {
      eventsLogger.warn("routing_event_publish_failed", {
        topic,
        error: err?.message || String(err),
      });
    });
}

/** Signal that an agent may have routable capacity again. */
export function publishAgentAvailable(userId, reason = "status_change") {
  if (!isEventDrivenRoutingEnabled() || !userId) return;
  firePublish("agent.available", { userId: String(userId), reason });
}

/** Signal that a call was enqueued and is awaiting an agent. */
export function publishCallEnqueued({ queueId, queueName, callControlId } = {}) {
  if (!isEventDrivenRoutingEnabled()) return;
  firePublish("call.enqueued", {
    queueId: queueId ? String(queueId) : null,
    queueName: queueName || null,
    callControlId: callControlId || null,
  });
}
