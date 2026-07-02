/**
 * WS0-T3 — Leadership helper (pg advisory locks).
 *
 * withLeadership(name, fn): acquire pg_try_advisory_lock on a DEDICATED
 * connection; if acquired, run fn (the loop) and hold the lock until the
 * process exits or releaseLeadership() is called. If not acquired, retry on
 * an interval. On connection loss the advisory lock auto-releases server-side
 * and another node can take over; this node then re-enters the retry loop.
 *
 * This complements (does not replace) the existing cc_coordinator_leases
 * lease table used by runWithCoordinatorLease(); existing callers are
 * untouched. New singleton loops (WS3-T2 coordinator, WS5 pacing) should use
 * withLeadership for process-lifetime leadership with instant failover.
 */

import { createHash } from "crypto";
import { Client } from "pg";
import { readPostgresSslConfig } from "../postgres-ssl.mjs";
import { createDiagnosticLogger } from "../diagnostic-logger.mjs";

const RETRY_INTERVAL_MS = 5_000;
const KEEPALIVE_INTERVAL_MS = 15_000;

const leaderLogger = createDiagnosticLogger("platform.leadership", {
  config: {
    globalLevel: process.env.LOG_LEVEL || "info",
    topicLevels: { "platform.leadership": process.env.LOG_LEADERSHIP_LEVEL || "info" },
  },
});

const runtime = (globalThis.__cc_leadership_runtime ||= {
  /** Map<name, {isLeader: boolean, stop: () => Promise<void>}> */
  loops: new Map(),
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
        ":leadership",
    },
  };
}

/** Stable 64-bit advisory lock key derived from the leadership name. */
export function advisoryKeyForName(name) {
  const digest = createHash("sha256").update(`cc-leadership:${name}`).digest();
  // Use the first 8 bytes as a signed 64-bit integer (pg advisory key space).
  return BigInt.asIntN(64, digest.readBigUInt64BE(0)).toString();
}

/** True when this process currently holds leadership for `name`. */
export function isLeader(name) {
  return Boolean(runtime.loops.get(name)?.isLeader);
}

/**
 * Run `fn` only while this process holds the advisory lock for `name`.
 *
 * @param {string} name leadership scope, e.g. "cc-coordinator"
 * @param {(ctx: {signal: AbortSignal}) => Promise<void>} fn long-running loop;
 *   should resolve/abort promptly when ctx.signal fires (leadership lost/stop).
 * @param {object} [opts]
 * @param {number} [opts.retryIntervalMs]
 * @returns {{stop: () => Promise<void>}}
 */
export function withLeadership(name, fn, opts = {}) {
  if (!name) throw new Error("name is required");
  if (typeof fn !== "function") throw new Error("fn must be a function");
  if (runtime.loops.has(name)) {
    // Same process asking twice: return existing controller (idempotent).
    return { stop: runtime.loops.get(name).stop };
  }

  const retryIntervalMs = Number.isFinite(Number(opts.retryIntervalMs))
    ? Math.max(250, Number(opts.retryIntervalMs))
    : RETRY_INTERVAL_MS;
  const lockKey = advisoryKeyForName(name);

  let stopped = false;
  let client = null;
  let keepaliveTimer = null;
  let abortController = null;
  let wakeUp = null;

  const state = { isLeader: false, stop: null };

  async function releaseClient() {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    const current = client;
    client = null;
    if (current) {
      try {
        await current.end();
      } catch {
        /* connection already gone; advisory lock auto-released */
      }
    }
  }

  function onLeadershipLost(reason) {
    if (!state.isLeader) return;
    state.isLeader = false;
    leaderLogger.warn("leadership_lost", { name, reason });
    if (abortController) abortController.abort();
  }

  async function tryAcquireOnce() {
    const { configured, config } = readClientConfigFromEnv();
    if (!configured) throw new Error("Postgres is not configured");

    const candidate = new Client(config);
    candidate.on("error", () => onLeadershipLost("connection_error"));
    candidate.on("end", () => onLeadershipLost("connection_end"));
    await candidate.connect();
    const result = await candidate.query(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [lockKey],
    );
    if (!result.rows?.[0]?.acquired) {
      await candidate.end().catch(() => {});
      return false;
    }
    client = candidate;
    // Keep the dedicated connection alive; if this fails, leadership is lost.
    keepaliveTimer = setInterval(() => {
      candidate.query("SELECT 1").catch(() => onLeadershipLost("keepalive_failed"));
    }, KEEPALIVE_INTERVAL_MS);
    if (typeof keepaliveTimer.unref === "function") keepaliveTimer.unref();
    return true;
  }

  async function loop() {
    while (!stopped) {
      let acquired = false;
      try {
        acquired = await tryAcquireOnce();
      } catch (err) {
        leaderLogger.warn("leadership_acquire_error", {
          name,
          error: err?.message || String(err),
        });
      }

      if (acquired && !stopped) {
        state.isLeader = true;
        abortController = new AbortController();
        leaderLogger.info("leadership_acquired", { name });
        try {
          await fn({ signal: abortController.signal });
        } catch (err) {
          leaderLogger.error("leadership_loop_error", {
            name,
            error: err?.message || String(err),
          });
        }
        state.isLeader = false;
        abortController = null;
        await releaseClient();
        leaderLogger.info("leadership_released", { name });
      }

      if (stopped) break;
      await new Promise((resolve) => {
        wakeUp = resolve;
        const t = setTimeout(resolve, retryIntervalMs);
        if (typeof t.unref === "function") t.unref();
      });
      wakeUp = null;
    }
  }

  state.stop = async () => {
    stopped = true;
    if (abortController) abortController.abort();
    if (wakeUp) wakeUp();
    await releaseClient();
    runtime.loops.delete(name);
  };

  runtime.loops.set(name, state);
  loop().catch((err) => {
    leaderLogger.error("leadership_fatal", {
      name,
      error: err?.message || String(err),
    });
    runtime.loops.delete(name);
  });

  return { stop: state.stop };
}
