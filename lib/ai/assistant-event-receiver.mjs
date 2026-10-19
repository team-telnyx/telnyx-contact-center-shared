import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { getPostgresPool } from "../postgres.mjs";
import { assistantEventConfig, authorizeAssistantEvents } from "./assistant-event-config.mjs";
import { bindAssistantConversation, acceptAssistantEvents, disconnectAssistantEvents } from "../acd/assistant-event-store.mjs";
import { contactCenterRuntimeLogger as logger } from "../runtime-logging.mjs";

export function createAssistantEventReceiver({ getPool = getPostgresPool, config = () => assistantEventConfig(), bind = bindAssistantConversation, accept = acceptAssistantEvents, disconnect = disconnectAssistantEvents } = {}) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  let closing = false;
  server.on("connection", socket => {
    const connectionId = randomUUID();
    let inviteId, pool, queued = [], queuedBytes = 0, chain = Promise.resolve(), flushTimer;
    let alive = true, binding = false, pendingBatches = 0, failed = false;
    const deadline = setTimeout(() => socket.close(1008, "Session required"), 15000);
    const fail = () => { failed = true; logger.warn("assistant_event_receiver_failed", { inviteId, connectionId }); socket.close(1011, "Event receiver unavailable"); };
    const flush = () => {
      clearTimeout(flushTimer); flushTimer = null;
      const events = queued; queued = []; queuedBytes = 0;
      if (!events.length) return;
      if (++pendingBatches > 32) { socket.close(1013, "Receiver busy"); return; }
      chain = chain.then(async () => {
        if (failed) return;
        if (!inviteId) throw new Error("No session");
        await accept(pool, inviteId, connectionId, events);
      }).catch(fail).finally(() => { pendingBatches--; });
    };
    socket.on("pong", () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false; socket.ping();
      if (inviteId) { queued.push({ type: "heartbeat" }); flush(); }
    }, 20000);
    heartbeat.unref?.(); deadline.unref?.();
    socket.on("message", (bytes, binary) => {
      if (failed || socket.readyState !== socket.OPEN) return;
      let event;
      try { if (binary) throw new Error(); event = JSON.parse(bytes.toString()); if (!event || typeof event.type !== "string") throw new Error(); }
      catch { socket.close(1008, "Invalid event"); return; }
      if (!binding) {
        if (event.type !== "session.created") return socket.close(1008, "Session required");
        binding = true;
        chain = chain.then(async () => {
          pool = getPool(); if (!pool) throw new Error("Database unavailable");
          inviteId = await bind(pool, event.session, connectionId);
          clearTimeout(deadline);
          logger.info("assistant_event_connected", { inviteId, connectionId });
        }).catch(fail);
        return;
      }
      if (event.type === "session.created") return socket.close(1008, "Session already bound");
      event.receivedAt = new Date().toISOString();
      queued.push(event); queuedBytes += bytes.length;
      if (queued.length > 256 || queuedBytes > 1024 * 1024) return socket.close(1009, "Event buffer full");
      if (!flushTimer) flushTimer = setTimeout(flush, 100);
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(deadline); clearInterval(heartbeat); flush();
      chain.then(() => inviteId && disconnect(pool, inviteId, connectionId)).catch(() => logger.warn("assistant_event_disconnect_failed", { inviteId }));
    });
  });
  return {
    upgrade(request, socket, head) {
      let authorized = false;
      try { authorized = !closing && authorizeAssistantEvents(request.headers.authorization, config()); } catch { /* Fail closed when not configured. */ }
      if (!authorized) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return; }
      server.handleUpgrade(request, socket, head, client => server.emit("connection", client));
    },
    close() {
      closing = true;
      for (const client of server.clients) {
        client.close(1001, "Server shutting down");
        const timeout = setTimeout(() => client.terminate(), 500); timeout.unref?.();
        client.once("close", () => clearTimeout(timeout));
      }
      server.close();
    },
  };
}
