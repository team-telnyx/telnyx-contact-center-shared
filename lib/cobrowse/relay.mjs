import { getPostgresPool } from "../postgres.mjs";
import { appendEvent } from "../acd/events.mjs";
import {
  cobrowseRelayState, consumeCobrowseTicket, endCobrowseAfterReconnectTimeout,
  setCobrowseTransportState,
} from "./lifecycle.mjs";
import { matchStoredOrigin } from "./http.mjs";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const LEASE_MS = 120_000;
const RECONNECT_MS = 30_000;
const sessions = new Map();
const metrics = { sessions: 0, frames: 0, bytes: 0, drops: 0, errors: 0 };
const epochPattern = /^[A-Za-z0-9_-]{8,64}$/;

function close(ws, code, reason) {
  if (!ws) return;
  try { ws.close(code, reason); } catch { try { ws.terminate(); } catch { /* already gone */ } }
}

function send(ws, value) {
  if (!ws || ws.readyState !== ws.OPEN) return false;
  ws.send(JSON.stringify(value));
  return true;
}

function slot(sessionId) {
  let current = sessions.get(sessionId);
  if (!current) {
    current = { publisher: null, viewer: null, epoch: null, seq: 0, awaitingSnapshot: true,
      controlCommands: new Map(), lastControlCommandId: 0, reconnectTimer: null };
    sessions.set(sessionId, current);
    metrics.sessions = sessions.size;
  }
  return current;
}

function resync(current) {
  current.awaitingSnapshot = true;
  send(current.publisher?.ws, { v: 1, type: "resync" });
  send(current.viewer?.ws, { v: 1, type: "waiting_snapshot" });
}

function countMutationRecords(events) {
  let count = 0;
  for (const event of events) {
    if (!event || typeof event !== "object") return Infinity;
    if (event.type !== 3) continue;
    const data = event.data;
    if (data?.source === 0) count += (data.adds?.length || 0) + (data.removes?.length || 0)
      + (data.texts?.length || 0) + (data.attributes?.length || 0);
    if (count > 1000) return count;
  }
  return count;
}

function portalOriginAllowed(origin, host) {
  let browser;
  try { browser = new URL(origin); } catch { return false; }
  const configured = process.env.NEXTAUTH_URL || process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL;
  if (configured) {
    try { if (browser.origin === new URL(configured).origin) return true; } catch { /* fall through */ }
  }
  if (browser.host.toLowerCase() === String(host || "").toLowerCase()) return true;
  // Local development connects directly to the sidecar at appPort + 1.
  const sidecar = String(host || "").toLowerCase();
  return ["localhost", "127.0.0.1"].includes(browser.hostname)
    && sidecar === `${browser.hostname}:${Number(browser.port || 3000) + 1}`;
}

export function validateCaptureFrame(message) {
  if (!message || message.v !== 1 || !["snapshot", "events"].includes(message.type) ||
    !epochPattern.test(message.epoch || "") || !Number.isSafeInteger(message.seq) || message.seq < 1 ||
    !Array.isArray(message.events) || message.events.length < 1 || message.events.length > 100 ||
    countMutationRecords(message.events) > 1000) return false;
  if (message.type === "snapshot" && !message.events.some((event) => event.type === 2)) return false;
  if (message.type === "events" && message.events.some((event) => event.type === 2)) return false;
  return true;
}

export function validateControlFrame(message) {
  if (!message || message.v !== 1 || message.type !== "control" ||
    !epochPattern.test(message.epoch || "") || !Number.isSafeInteger(message.seq) || message.seq < 1 ||
    !Number.isSafeInteger(message.commandId) || message.commandId < 1 ||
    !["click", "scroll", "fill"].includes(message.action)) return false;
  if (message.action === "scroll") return Number.isInteger(message.deltaX) && Number.isInteger(message.deltaY) &&
    Math.abs(message.deltaX) <= 1000 && Math.abs(message.deltaY) <= 1000;
  if (message.action === "fill") return Number.isSafeInteger(message.selectionId) && message.selectionId > 0 &&
    typeof message.value === "string" && message.value.length <= 500;
  return Number.isSafeInteger(message.nodeId) && message.nodeId > 0;
}

export function relayMetrics() { return { ...metrics }; }

export function registerCobrowseConnection(ws, request) {
  const pool = getPostgresPool();
  if (!pool || Number(process.env.COBROWSE_RELAY_REPLICAS || 1) !== 1) return close(ws, 1013, "Co-browse unavailable");
  const browserOrigin = request.headers.origin;
  if (!browserOrigin || browserOrigin === "null") return close(ws, 1008, "Origin required");
  let participant = null;
  let sessionId = null;
  let current = null;
  let leaseUntil = 0;
  let controlWindow = 0;
  let controlCount = 0;
  const helloDeadline = setTimeout(() => { if (!participant) close(ws, 1008, "Hello timeout"); }, 5000);
  const leaseCheck = setInterval(async () => {
    if (!participant) return;
    if (Date.now() >= leaseUntil) return close(ws, 4003, "Lease expired");
    try {
      const state = await cobrowseRelayState(pool, sessionId);
      if (!state?.consentGranted || state.state === "ended" ||
        state.authGeneration !== participant.authGeneration) close(ws, 4003, "Session revoked");
    } catch { close(ws, 1011, "Authorization unavailable"); }
  }, 15_000);
  leaseCheck.unref?.();

  let processing = Promise.resolve();
  async function handleMessage(raw, binary) {
    try {
      if (binary || raw.length > MAX_FRAME_BYTES) return close(ws, 1009, "Frame too large");
      if (!participant && raw.length > 2048) return close(ws, 1009, "Hello too large");
      const message = JSON.parse(raw.toString("utf8"));
      if (!participant) {
        if (message?.v !== 1 || message.type !== "hello" || typeof message.ticket !== "string")
          return close(ws, 1008, "Hello required");
        const admitted = await consumeCobrowseTicket(pool, { ticket: message.ticket, origin: browserOrigin });
        if (admitted.role === "publisher" && !matchStoredOrigin(admitted.origin, browserOrigin))
          return close(ws, 1008, "Origin mismatch");
        if (admitted.role === "viewer") {
          if (!portalOriginAllowed(browserOrigin, request.headers.host)) return close(ws, 1008, "Portal origin mismatch");
        }
        sessionId = admitted.sessionId;
        current = slot(sessionId);
        if (current[admitted.role]) return close(ws, 1008, "Participant already connected");
        participant = { ...admitted, ws };
        current[admitted.role] = participant;
        if (admitted.role === "viewer") current.lastControlCommandId = 0;
        leaseUntil = Date.now() + LEASE_MS;
        clearTimeout(helloDeadline);
        if (admitted.role === "publisher" && current.reconnectTimer) {
          clearTimeout(current.reconnectTimer);
          current.reconnectTimer = null;
        }
        send(ws, { v: 1, type: "ready", role: admitted.role, leaseSeconds: LEASE_MS / 1000 });
        if (admitted.role === "viewer") resync(current);
        else if (current.viewer) resync(current);
        return;
      }
      if (message?.v !== 1) return close(ws, 1008, "Protocol version");
      if (message.type === "reauth") {
        const admitted = await consumeCobrowseTicket(pool, { ticket: message.ticket, origin: browserOrigin });
        if (admitted.sessionId !== sessionId || admitted.role !== participant.role ||
          admitted.authGeneration !== participant.authGeneration || admitted.agentId !== participant.agentId)
          return close(ws, 4003, "Reauthorization failed");
        leaseUntil = Date.now() + LEASE_MS;
        return send(ws, { v: 1, type: "reauthorized", leaseSeconds: LEASE_MS / 1000 });
      }
      if (participant.role === "viewer") {
        if (message.type === "resync") return resync(current);
        if (message.type === "control") {
          if (raw.length > 2048 || !validateControlFrame(message)) return close(ws, 1008, "Invalid control frame");
          if (message.commandId <= current.lastControlCommandId)
            return send(ws, { v: 1, type: "control_denied", commandId: message.commandId, reason: "duplicate" });
          current.lastControlCommandId = message.commandId;
          const now = Date.now();
          if (now - controlWindow >= 1000) { controlWindow = now; controlCount = 0; }
          if (++controlCount > 8) return send(ws, { v: 1, type: "control_denied", commandId: message.commandId, reason: "rate_limit" });
          const state = await cobrowseRelayState(pool, sessionId);
          if (state?.state !== "active" || state.controlLevel !== "assist" ||
            state.authGeneration !== participant.authGeneration || !current.publisher || current.awaitingSnapshot ||
            message.epoch !== current.epoch || message.seq > current.seq || message.seq < current.seq - 100)
            return send(ws, { v: 1, type: "control_denied", commandId: message.commandId, reason: "not_authorized_or_stale" });
          for (const [id, issued] of current.controlCommands) {
            if (now - issued.issuedAt > 10_000) current.controlCommands.delete(id);
          }
          await appendEvent(pool, { workItemId: participant.workItemId, agentId: participant.agentId,
            type: "cobrowse_control_action", actor: `agent:${participant.agentId}`,
            payload: { session_id: sessionId, action: message.action, result: "sent", command_id: message.commandId } });
          current.controlCommands.set(message.commandId, { action: message.action, issuedAt: now });
          return send(current.publisher.ws, message);
        }
        return close(ws, 1008, "Viewer is observe-only");
      }
      if (message.type === "control_result") {
        if (!Number.isSafeInteger(message.commandId) || message.commandId < 1 || typeof message.accepted !== "boolean" ||
          typeof message.fieldSelected !== "boolean")
          return close(ws, 1008, "Invalid control result");
        const issued = current.controlCommands.get(message.commandId);
        current.controlCommands.delete(message.commandId);
        if (!issued || Date.now() - issued.issuedAt > 10_000) return;
        await appendEvent(pool, { workItemId: participant.workItemId, agentId: participant.agentId,
          type: "cobrowse_control_action", actor: `agent:${participant.agentId}`,
          payload: { session_id: sessionId, action: issued.action,
            result: message.accepted ? "applied" : "blocked", command_id: message.commandId } });
        return send(current.viewer?.ws, { v: 1, type: "control_result", commandId: message.commandId,
          accepted: message.accepted, fieldSelected: message.fieldSelected });
      }
      if (!validateCaptureFrame(message)) return close(ws, 1008, "Invalid capture frame");
      if (message.type === "snapshot") {
        current.epoch = message.epoch;
        current.seq = message.seq;
        current.awaitingSnapshot = false;
        if (!(await setCobrowseTransportState(pool, { sessionId, state: "active" })))
          return close(ws, 4003, "Session revoked");
      } else if (current.awaitingSnapshot || current.epoch !== message.epoch || message.seq !== current.seq + 1) {
        metrics.drops += 1;
        return resync(current);
      } else current.seq = message.seq;
      metrics.frames += 1;
      metrics.bytes += raw.length;
      const viewer = current.viewer?.ws;
      if (!viewer) return;
      if (viewer.bufferedAmount > MAX_QUEUE_BYTES) {
        metrics.drops += 1;
        if (message.type === "events") return resync(current);
        return close(viewer, 1013, "Viewer queue full");
      }
      viewer.send(raw.toString("utf8"));
    } catch {
      metrics.errors += 1;
      close(ws, 1008, "Invalid or unauthorized frame");
    }
  }
  ws.on("message", (raw, binary) => {
    processing = processing.then(() => handleMessage(raw, binary));
  });

  ws.on("close", async () => {
    clearTimeout(helloDeadline);
    clearInterval(leaseCheck);
    if (!participant || !current || current[participant.role] !== participant) return;
    current[participant.role] = null;
    current.controlCommands.clear();
    if (participant.role === "publisher") {
      current.awaitingSnapshot = true;
      send(current.viewer?.ws, { v: 1, type: "reconnecting" });
      try { await setCobrowseTransportState(pool, { sessionId, state: "reconnecting" }); } catch { /* periodic reconciliation remains authoritative */ }
      current.reconnectTimer = setTimeout(async () => {
        current.reconnectTimer = null;
        if (current.publisher) return;
        try { await endCobrowseAfterReconnectTimeout(pool, sessionId); } catch { /* next API read reconciles */ }
        close(current.viewer?.ws, 4003, "Publisher disconnected");
        if (!current.publisher && !current.viewer) { sessions.delete(sessionId); metrics.sessions = sessions.size; }
      }, RECONNECT_MS);
      current.reconnectTimer.unref?.();
    }
    if (!current.publisher && !current.viewer && !current.reconnectTimer) {
      sessions.delete(sessionId);
      metrics.sessions = sessions.size;
    }
  });
}
