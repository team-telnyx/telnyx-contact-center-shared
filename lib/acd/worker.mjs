import { applyOutboundVoiceEvent } from "./outbound-intake.mjs";
import { tickOutboundMessaging, tickOutboundVoice } from "./outbound-runtime.mjs";
import { sweepDueSagas, sweepStalledSagas } from "./saga-engine.mjs";
// ACD router worker (the internal documentation §5.2, Phase B task #13).
// NOTIFY-driven with a periodic tick fallback. Multi-node safe by
// construction: routeOne claims work items with FOR UPDATE SKIP LOCKED, so
// concurrent drains cannot double-route; running the worker on every node is
// correct, just occasionally redundant.

import pg from "pg";
import { runInboxWorkerOnce, INBOX_CORRELATION_WINDOW_MS } from "./inbox.mjs";
import { applyClaimedAcdVoiceEvent, routeAndConnect } from "./live-intake.mjs";
import { routeOne } from "./router.mjs";
import { sweepTextInactivity, sweepTextWrapups } from "./text-lifecycle.mjs";
import { publishCommittedOutbox } from "./stream.mjs";
import { replayVoiceEffects } from "./replay-effects.mjs";
import { applyDirectCapacityEventWithRejection } from "./direct-capacity.mjs";
import { applyAcdArtifactEvent } from "./artifacts.mjs";
import "./sagas/index.mjs";
import "../email/store.mjs";
import { emailProvider, emailRequest } from "../email/provider.mjs";
import { syncEmailMailbox, syncEmailDeliveries, applyEmailInboxEvent, routePendingEmail } from "../email/ingest.mjs";
import "../sms/store.mjs";
import { smsProvider, smsRequest } from "../sms/provider.mjs";
import { syncMessagingDeliveries } from "../outbound-dialer/messaging/execution.mjs";
import { applySmsInboxEvent, routePendingSms, syncSmsDeliveries } from "../sms/ingest.mjs";
import "../whatsapp/store.mjs";
import { whatsappProvider, whatsappRequest } from "../whatsapp/provider.mjs";
import { applyWhatsAppInboxEvent, routePendingWhatsApp, stageWhatsAppMedia, syncWhatsAppDeliveries } from "../whatsapp/ingest.mjs";
import { NATIVE_LIFECYCLE_CHANNELS } from "./channel-registry.mjs";

export const WORKER_TICK_MS = 1_000;
const DRAIN_DEBOUNCE_MS = 100;
const DRAIN_BATCH = 20;
const WAKE_EVENT_TYPES = new Set([
  "work_item_queued",
  "work_item_requeued",
  "work_item_queue_transferred",
  "reservation_released",
  "agent_workflow_changed",
  "agent_queue_membership_changed",
  "inbox_received",
]);

function voiceEventFromInboxRow(row) {
  return {
    eventId: row.event_id,
    provider: row.provider,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    payload: row.payload || {},
    sourceRoute: row.source_route || null,
    sourceFlowId: row.source_flow_id || null,
  };
}

/** Drain durable webhook rows before routing any work items they create. */
export async function drainInboxOnce(
  pool,
  provider,
  { node = "inbox-worker", limit = DRAIN_BATCH } = {},
) {
  return runInboxWorkerOnce(pool, {
    node,
    limit,
    handler: async (row) => {
      if (row.provider === "telnyx-email") return applyEmailInboxEvent(pool, row);
      if (row.provider === "telnyx-sms") return applySmsInboxEvent(pool, row);
      if (row.provider === "telnyx-whatsapp") return applyWhatsAppInboxEvent(pool, row);
      const event = voiceEventFromInboxRow(row);
      const artifact = await applyAcdArtifactEvent(pool, event);
      const live = artifact?.handled
        ? artifact
        : await applyOutboundVoiceEvent(pool, provider, event, { node })
          || await applyDirectCapacityEventWithRejection(pool, event, { provider })
          || await applyClaimedAcdVoiceEvent(pool, provider, event, { node });
      if (!live.handled) {
        throw new Error(`Core inbox event ${row.event_id} could not be matched`);
      }
      // A correlated event replays shared flow/media effects immediately. A
      // Core-hinted event gets the correlation window before adapter replay.
      const correlationExpired = row.received_at
        && Date.now() - new Date(row.received_at).getTime() >= INBOX_CORRELATION_WINDOW_MS;
      if (live.outcome !== "unmatched" || correlationExpired) {
        await replayVoiceEffects(row, live);
      }
      return ["applied", "noop", "unmatched"].includes(live.outcome)
        ? live.outcome
        : "noop";
    },
  });
}

export async function drainQueuedOnce(pool, provider, { node = "worker", limit = DRAIN_BATCH } = {}) {
  const queued = await pool.query(
    `SELECT q.id,q.channel FROM unnest($2::text[]) AS c(channel)
      CROSS JOIN LATERAL (
        SELECT id,channel,priority,enqueued_at,created_at FROM acd_work_items
        WHERE state='queued' AND channel=c.channel
        ORDER BY priority DESC,enqueued_at ASC NULLS LAST,created_at ASC,id
        LIMIT $1
      ) q
      ORDER BY q.channel,q.priority DESC,q.enqueued_at ASC NULLS LAST,q.created_at ASC,q.id`,
    [limit, ["voice", ...NATIVE_LIFECYCLE_CHANNELS]],
  );
  const results = [];
  for (const row of queued.rows) {
    try {
      results.push(row.channel !== "voice" ? await routeOne(pool, row.id) : await routeAndConnect(pool, provider, row.id, { node }));
    } catch (error) {
      results.push({ routed: false, error: String(error?.message || error) });
    }
  }
  return results;
}

/**
 * Start the worker loop on this node. Uses a dedicated pg client for LISTEN
 * (auto-reconnect with backoff); the interval tick covers missed NOTIFYs and
 * agents becoming available without an event.
 */
export function startAcdWorker(pool, {
  provider,
  node = "worker",
  tickMs = WORKER_TICK_MS,
  connectionConfig = null,
  onDrain,
  onListener,
} = {}) {
  provider = whatsappProvider(smsProvider(emailProvider(provider)));
  let stopped = false;
  let listenClient = null;
  let drainTimer = null;
  let reconnectDelay = 1_000;
  let draining = false;
  let emailRunning = false;
  const emailTick = setInterval(async () => {
    if (stopped || emailRunning) return;
    emailRunning = true;
    try {
      for (const sync of [syncEmailMailbox, syncEmailDeliveries]) {
        try { await sync(pool); }
        catch (error) { onDrain?.([{ channel:"email", error:String(error.message).slice(0,300) }]); }
      }
      for (let n=0; n<20 && !stopped; n++) if (!await routePendingEmail(pool)) break;
    } catch (error) { onDrain?.([{ channel:"email", error:String(error.message).slice(0,300) }]); }
    finally { emailRunning = false; }
  }, 2000);
  emailTick.unref?.();
  let smsRunning = false;
  const smsTick = setInterval(async () => {
    if (stopped || smsRunning) return;
    smsRunning = true;
    try {
      for (let n=0; n<20 && !stopped; n++) if (!await routePendingSms(pool)) break;
      try { await syncSmsDeliveries(pool); }
      catch (error) { onDrain?.([{ channel:"sms", error:String(error.message).slice(0,300) }]); }
      // Campaign messages keep their own reconciliation queue on the attempt ledger.
      try { for (let n=0; n<5 && !stopped; n++) if (!await syncMessagingDeliveries(pool, { requests: { sms: smsRequest, whatsapp: whatsappRequest, email: emailRequest } })) break; }
      catch (error) { onDrain?.([{ channel:"messaging", error:String(error.message).slice(0,300) }]); }
    } catch (error) { onDrain?.([{ channel:"sms", error:String(error.message).slice(0,300) }]); }
    finally { smsRunning = false; }
  }, 2000);
  smsTick.unref?.();
  let whatsappRunning = false;
  const whatsappTick = setInterval(async () => {
    if (stopped || whatsappRunning) return;
    whatsappRunning = true;
    try {
      // Media downloads run outside the routing lock; routing copies the staged bytes.
      for (let n=0; n<5 && !stopped; n++) if (!await stageWhatsAppMedia(pool)) break;
      for (let n=0; n<20 && !stopped; n++) if (!await routePendingWhatsApp(pool)) break;
      try { await syncWhatsAppDeliveries(pool); }
      catch (error) { onDrain?.([{ channel:"whatsapp", error:String(error.message).slice(0,300) }]); }
    } catch (error) { onDrain?.([{ channel:"whatsapp", error:String(error.message).slice(0,300) }]); }
    finally { whatsappRunning = false; }
  }, 2000);
  whatsappTick.unref?.();

  const scheduleDrain = () => {
    if (stopped || drainTimer || draining) return;
    drainTimer = setTimeout(async () => {
      drainTimer = null;
      draining = true;
      try {
        await drainInboxOnce(pool, provider, { node: `${node}:inbox` });
        const outbound = await tickOutboundVoice(pool, provider, { node });
        const messaging = await tickOutboundMessaging(pool, provider, { node });
        const results = await drainQueuedOnce(pool, provider, { node });
        await sweepTextInactivity(pool);
        await sweepTextWrapups(pool);
        await sweepDueSagas(pool, { provider, node: `${node}:deadlines`, limit: 100 });
        await sweepStalledSagas(pool, { provider, node, limit: 100 });
        await publishCommittedOutbox(pool);
        if (results.length > 0 || outbound.length > 0 || messaging.length > 0) onDrain?.([...results,...outbound,...messaging]);
      } catch (error) {
        onDrain?.([{ routed: false, error: String(error?.message || error) }]);
      } finally { draining = false; }
    }, DRAIN_DEBOUNCE_MS);
    drainTimer.unref?.();
  };

  const connectListener = async () => {
    if (stopped) return;
    try {
      listenClient = connectionConfig ? new pg.Client(connectionConfig) : new pg.Client();
      await listenClient.connect();
      await listenClient.query("LISTEN acd_events");
      reconnectDelay = 1_000;
      onListener?.({ status: "listening", node });
      listenClient.on("notification", (msg) => {
        try {
          const parsed = JSON.parse(msg.payload || "{}");
          if (!parsed.type || WAKE_EVENT_TYPES.has(parsed.type)) scheduleDrain();
        } catch {
          scheduleDrain();
        }
      });
      listenClient.on("error", (error) => {
        onListener?.({
          status: "error",
          node,
          error: String(error?.message || error),
        });
        listenClient?.end().catch(() => {});
        listenClient = null;
        if (!stopped) setTimeout(connectListener, (reconnectDelay = Math.min(reconnectDelay * 2, 30_000))).unref?.();
      });
    } catch (error) {
      onListener?.({
        status: "error",
        node,
        error: String(error?.message || error),
      });
      listenClient = null;
      if (!stopped) setTimeout(connectListener, (reconnectDelay = Math.min(reconnectDelay * 2, 30_000))).unref?.();
    }
  };

  connectListener();
  const tick = setInterval(scheduleDrain, tickMs);
  tick.unref?.();
  scheduleDrain();

  return {
    async stop() {
      stopped = true;
      clearInterval(tick);
      clearInterval(emailTick);
      clearInterval(smsTick);
      clearInterval(whatsappTick);
      if (drainTimer) clearTimeout(drainTimer);
      await listenClient?.end().catch(() => {});
      listenClient = null;
    },
  };
}
