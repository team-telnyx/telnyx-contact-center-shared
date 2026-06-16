/**
 * WS0-T2 — PG LISTEN/NOTIFY event bus adapter.
 *
 * Uses one dedicated pg.Client (NOT from the shared pool) running
 * `LISTEN cc_events`. Incoming notifications are routed to subscribers by
 * topic. publish() issues `SELECT pg_notify('cc_events', $1)` through the
 * shared pool, so publishing works even before any subscriber exists.
 *
 * Reconnect: on connection error/end the listener client is re-created with
 * exponential backoff. Payloads must stay < 7KB (NOTIFY ~8KB hard limit).
 * The bus is best-effort signaling; the DB remains the source of truth.
 */

import { Client } from "pg";
import { getPostgresPool } from "../postgres.mjs";
import { createDiagnosticLogger } from "../diagnostic-logger.mjs";
import { readPostgresSslConfig } from "../postgres-ssl.mjs";

const CHANNEL = "cc_events";
const MAX_PAYLOAD_BYTES = 7 * 1024;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

const busLogger = createDiagnosticLogger("platform.event-bus", {
  config: {
    globalLevel: process.env.LOG_LEVEL || "info",
    topicLevels: { "platform.event-bus": process.env.LOG_EVENT_BUS_LEVEL || "info" },
  },
});

function readClientConfigFromEnv() {
  const host = process.env.POSTGRES_HOST || "";
  const port = Number(process.env.POSTGRES_PORT || 5432);
  const database = process.env.POSTGRES_DB || "";
  const user = process.env.POSTGRES_USER || "";
  const password = process.env.POSTGRES_PASSWORD || "";
  const configured = Boolean(host && database && user);
  return {
    configured,
    config: {
      host,
      port,
      database,
      user,
      password,
      ssl: readPostgresSslConfig(),
      application_name:
        (process.env.POSTGRES_APPLICATION_NAME || "telnyx-contact-center") +
        ":event-bus",
    },
  };
}

function topicMatches(pattern, topic) {
  if (pattern === topic) return true;
  if (pattern.endsWith("*")) {
    return topic.startsWith(pattern.slice(0, -1));
  }
  return false;
}

export function createPgNotifyAdapter() {
  /** Map<pattern, Set<handler>> */
  const subscriptions = new Map();
  let listenerClient = null;
  let connecting = null;
  let closed = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;

  function dispatch(rawPayload) {
    let parsed;
    try {
      parsed = JSON.parse(rawPayload);
    } catch {
      busLogger.warn("event_bus_unparseable_payload", {
        size: rawPayload?.length || 0,
      });
      return;
    }
    const topic = parsed?.topic;
    if (!topic || typeof topic !== "string") return;
    const payload = parsed?.payload ?? {};

    for (const [pattern, handlers] of subscriptions.entries()) {
      if (!topicMatches(pattern, topic)) continue;
      for (const handler of handlers) {
        Promise.resolve()
          .then(() => handler(payload, { topic }))
          .catch((err) => {
            busLogger.error("event_bus_handler_error", {
              topic,
              pattern,
              error: err?.message || String(err),
            });
          });
      }
    }
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    reconnectAttempt += 1;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempt, 5),
    );
    busLogger.warn("event_bus_listener_reconnect_scheduled", {
      attempt: reconnectAttempt,
      delayMs: delay,
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensureListener().catch(() => scheduleReconnect());
    }, delay);
    if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
  }

  async function ensureListener() {
    if (closed) throw new Error("event bus is closed");
    if (listenerClient) return listenerClient;
    if (connecting) return connecting;

    const { configured, config } = readClientConfigFromEnv();
    if (!configured) {
      throw new Error(
        "Postgres is not configured (POSTGRES_HOST/POSTGRES_DB/POSTGRES_USER)",
      );
    }

    connecting = (async () => {
      const client = new Client(config);
      client.on("notification", (msg) => {
        if (msg?.channel === CHANNEL) dispatch(msg.payload || "");
      });
      client.on("error", (err) => {
        busLogger.error("event_bus_listener_error", {
          error: err?.message || String(err),
        });
        teardownListener(client);
        scheduleReconnect();
      });
      client.on("end", () => {
        teardownListener(client);
        if (!closed) scheduleReconnect();
      });

      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      listenerClient = client;
      reconnectAttempt = 0;
      busLogger.info("event_bus_listener_connected", { channel: CHANNEL });
      return client;
    })();

    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  function teardownListener(client) {
    if (listenerClient === client) listenerClient = null;
    try {
      client.removeAllListeners("notification");
      client.end().catch(() => {});
    } catch {
      /* already gone */
    }
  }

  return {
    async publish(topic, payload = {}) {
      if (!topic || typeof topic !== "string") {
        throw new Error("topic is required");
      }
      const message = JSON.stringify({ topic, payload });
      if (Buffer.byteLength(message, "utf8") > MAX_PAYLOAD_BYTES) {
        throw new Error(
          `event payload too large for pg_notify (> ${MAX_PAYLOAD_BYTES} bytes); publish a reference (id) instead`,
        );
      }
      const pool = getPostgresPool();
      if (!pool) throw new Error("Postgres pool is not available");
      await pool.query("SELECT pg_notify($1, $2)", [CHANNEL, message]);
    },

    async subscribe(topic, handler) {
      if (!topic || typeof topic !== "string") {
        throw new Error("topic is required");
      }
      if (typeof handler !== "function") {
        throw new Error("handler must be a function");
      }
      await ensureListener();
      let handlers = subscriptions.get(topic);
      if (!handlers) {
        handlers = new Set();
        subscriptions.set(topic, handlers);
      }
      handlers.add(handler);
      return () => {
        const set = subscriptions.get(topic);
        if (set) {
          set.delete(handler);
          if (set.size === 0) subscriptions.delete(topic);
        }
      };
    },

    async close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      subscriptions.clear();
      const client = listenerClient;
      listenerClient = null;
      if (client) {
        try {
          await client.end();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
