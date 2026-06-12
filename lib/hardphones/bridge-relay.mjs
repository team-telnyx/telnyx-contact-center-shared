import crypto from "node:crypto";
import { createDiagnosticLogger } from "../diagnostic-logger.mjs";

const relayLogger = createDiagnosticLogger("contact-center.hardphone-cti");
const DEFAULT_COMMAND_TIMEOUT_MS = 15000;
const bridges = new Map();
const pendingCommands = new Map();

function isOpen(ws) {
  return ws && ws.readyState === (ws.OPEN ?? ws.constructor?.OPEN ?? 1);
}

function safeSend(ws, payload) {
  if (!isOpen(ws)) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    relayLogger.warn("hardphone_bridge_send_failed", { error: err?.message || String(err) });
    return false;
  }
}

function parseJsonMessage(raw) {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function tokenMatches(got, expected) {
  if (!expected) return true;
  const a = Buffer.from(String(got || ""));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bridgeSnapshot(entry) {
  return {
    bridge_id: entry.bridge_id,
    site: entry.site || null,
    online: isOpen(entry.ws),
    connected_at: entry.connected_at,
    last_seen_at: entry.last_seen_at,
    capabilities: entry.capabilities || {},
  };
}

export function listHardphoneBridges() {
  return Array.from(bridges.values()).map(bridgeSnapshot);
}

export function registerBridgeConnection(ws, request) {
  const url = new URL(request.url || "/", "http://localhost");
  const bridge_id = url.searchParams.get("bridge_id") || `bridge_${crypto.randomUUID()}`;
  const token = url.searchParams.get("token") || url.searchParams.get("secret") || "";
  const expectedToken = process.env.HARDPHONE_BRIDGE_TOKEN || process.env.BRIDGE_TOKEN || "";

  if (!tokenMatches(token, expectedToken)) {
    safeSend(ws, { type: "error", error: "unauthorized" });
    ws.close(4001, "Unauthorized");
    return null;
  }

  const now = new Date().toISOString();
  const previous = bridges.get(bridge_id);
  if (previous?.ws && previous.ws !== ws) {
    try { previous.ws.close(4000, "Replaced by a newer bridge connection"); } catch {}
  }

  const entry = {
    bridge_id,
    ws,
    site: url.searchParams.get("site") || null,
    connected_at: now,
    last_seen_at: now,
    capabilities: {},
  };
  bridges.set(bridge_id, entry);
  safeSend(ws, { type: "registered", bridge_id, timestamp: now });
  relayLogger.info("hardphone_bridge_connected", { bridgeId: bridge_id, site: entry.site });

  ws.on("message", (raw) => {
    const message = parseJsonMessage(raw);
    if (!message) return;
    entry.last_seen_at = new Date().toISOString();
    if (message.type === "hello") {
      entry.site = message.site || entry.site;
      entry.capabilities = message.capabilities || entry.capabilities || {};
      safeSend(ws, { type: "hello_ack", bridge_id, timestamp: entry.last_seen_at });
      return;
    }
    if (message.type === "heartbeat") {
      safeSend(ws, { type: "heartbeat_ack", bridge_id, timestamp: entry.last_seen_at });
      return;
    }
    if (message.type === "command_result") {
      const command = pendingCommands.get(message.command_id);
      if (command) {
        pendingCommands.delete(message.command_id);
        clearTimeout(command.timer);
        command.resolve({ ok: message.ok !== false, command_id: message.command_id, result: message.result ?? null, error: message.error || null, bridge_id });
      }
    }
  });

  ws.on("close", () => {
    if (bridges.get(bridge_id)?.ws === ws) bridges.delete(bridge_id);
    for (const [commandId, pending] of pendingCommands.entries()) {
      if (pending.bridge_id === bridge_id) {
        pendingCommands.delete(commandId);
        clearTimeout(pending.timer);
        pending.resolve({ ok: false, command_id: commandId, bridge_id, error: "bridge_disconnected" });
      }
    }
    relayLogger.info("hardphone_bridge_disconnected", { bridgeId: bridge_id });
  });

  return entry;
}

export function sendBridgeCommand({ bridge_id, vendor, host, action, payload = {}, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS }) {
  const bridge = bridges.get(bridge_id);
  if (!bridge || !isOpen(bridge.ws)) {
    return Promise.resolve({ ok: false, bridge_id, error: "bridge_offline" });
  }
  const command_id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(command_id);
      resolve({ ok: false, command_id, bridge_id, error: "result_timeout" });
    }, timeoutMs);
    timer.unref?.();
    pendingCommands.set(command_id, { bridge_id, resolve, timer });
    const sent = safeSend(bridge.ws, { type: "command", command_id, vendor, host, action, payload });
    if (!sent) {
      clearTimeout(timer);
      pendingCommands.delete(command_id);
      resolve({ ok: false, command_id, bridge_id, error: "send_failed" });
    }
  });
}

export async function readJsonRequest(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  return JSON.parse(raw);
}

export function writeJsonResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function requireBridgeAdminToken(req, res) {
  const expected = process.env.HARDPHONE_BRIDGE_ADMIN_TOKEN || process.env.HARDPHONE_BRIDGE_TOKEN || "";
  if (!expected) return true;
  const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || req.headers["x-bridge-token"] || "";
  if (tokenMatches(got, expected)) return true;
  writeJsonResponse(res, 401, { ok: false, error: "unauthorized" });
  return false;
}
