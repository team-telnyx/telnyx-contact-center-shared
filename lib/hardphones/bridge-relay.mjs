import crypto from "node:crypto";
import { createDiagnosticLogger } from "../diagnostic-logger.mjs";

const relayLogger = createDiagnosticLogger("contact-center.hardphone-cti");
const DEFAULT_COMMAND_TIMEOUT_MS = 15000;
const bridges = new Map();
const pendingCommands = new Map();

async function postgresPool() {
  try {
    const { getPostgresPool } = await import("../postgres.mjs");
    return getPostgresPool();
  } catch {
    return null;
  }
}

async function updateBridgePresence(bridge_id, patch = {}) {
  const pool = await postgresPool();
  if (!pool || !bridge_id) return;
  try {
    await pool.query(
      `UPDATE hp_local_bridges SET status = $2, last_seen_at = COALESCE($3, last_seen_at), metadata = metadata || $4::jsonb, updated_at = NOW() WHERE bridge_id = $1`,
      [bridge_id, patch.status || "online", patch.last_seen_at || new Date().toISOString(), JSON.stringify(patch.metadata || {})],
    );
  } catch (err) {
    relayLogger.debug?.("hardphone_bridge_presence_update_failed", { bridgeId: bridge_id, error: err?.message || String(err) });
  }
}

async function recordObservedPhone(bridge_id, message = {}) {
  const pool = await postgresPool();
  const mac = String(message.mac || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  const ip = String(message.ip || message.discovered_ip || "").trim();
  const phoneId = message.phone_id || null;
  if (!pool || !ip || (mac.length !== 12 && !phoneId)) return;
  try {
    const where = phoneId
      ? `id = $1`
      : `replace(replace(lower(mac), ':', ''), '-', '') = $1`;
    const key = phoneId || mac;
    await pool.query(
      `UPDATE hp_phones
       SET last_ip = $2,
           ip_address = COALESCE(NULLIF(ip_address, ''), $2),
           local_bridge_id = COALESCE(local_bridge_id, $3),
           last_seen_at = NOW(),
           updated_at = NOW()
       WHERE ${where}`,
      [key, ip, bridge_id],
    );
    await pool.query(
      `INSERT INTO hp_provisioning_events (phone_id, mac, event_type, detail)
       SELECT id, mac, 'bridge_phone_observed', $3::jsonb
       FROM hp_phones WHERE ${where}`,
      [key, ip, JSON.stringify({ bridge_id, detected_ip: ip, source: message.source || "bridge" })],
    );
  } catch (err) {
    relayLogger.debug?.("hardphone_bridge_phone_observed_failed", { bridgeId: bridge_id, error: err?.message || String(err) });
  }
}

async function insertCommandAudit(command) {
  const pool = await postgresPool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO hp_local_bridge_commands (bridge_id, phone_id, vendor, phone_host, action, status, request)
       VALUES ($1, $2, $3, $4, $5, 'queued', $6)
       RETURNING id`,
      [command.bridge_id, command.phone_id || null, command.vendor || null, command.host || null, command.action, JSON.stringify(command.payload || {})],
    );
    return rows[0]?.id || null;
  } catch (err) {
    relayLogger.debug?.("hardphone_bridge_command_audit_insert_failed", { bridgeId: command.bridge_id, error: err?.message || String(err) });
    return null;
  }
}

async function finishCommandAudit(id, outcome) {
  const pool = await postgresPool();
  if (!pool || !id) return;
  try {
    await pool.query(
      `UPDATE hp_local_bridge_commands SET status = $2, result = $3, completed_at = NOW() WHERE id = $1`,
      [id, outcome?.ok === false ? "failed" : "completed", JSON.stringify(outcome || {})],
    );
  } catch (err) {
    relayLogger.debug?.("hardphone_bridge_command_audit_finish_failed", { commandAuditId: id, error: err?.message || String(err) });
  }
}


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

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

async function bridgeTokenAuthorized(bridge_id, token) {
  if (!bridge_id || !token) return false;

  const expectedToken = process.env.HARDPHONE_BRIDGE_TOKEN || process.env.BRIDGE_TOKEN || "";
  if (expectedToken && tokenMatches(token, expectedToken)) return true;

  const pool = await postgresPool();
  if (!pool) return false;

  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM hp_local_bridges WHERE bridge_id = $1 AND token_hash = $2 LIMIT 1`,
      [bridge_id, tokenHash(token)],
    );
    return Boolean(rows[0]);
  } catch (err) {
    relayLogger.warn("hardphone_bridge_token_lookup_failed", { bridgeId: bridge_id, error: err?.message || String(err) });
    return false;
  }
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

export async function registerBridgeConnection(ws, request) {
  const url = new URL(request.url || "/", "http://localhost");
  const bridge_id = url.searchParams.get("bridge_id") || `bridge_${crypto.randomUUID()}`;
  const token = url.searchParams.get("token") || url.searchParams.get("secret") || "";

  if (!(await bridgeTokenAuthorized(bridge_id, token))) {
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
  updateBridgePresence(bridge_id, { status: "online", last_seen_at: now, metadata: { site: entry.site, connected_at: now } });
  relayLogger.info("hardphone_bridge_connected", { bridgeId: bridge_id, site: entry.site });

  ws.on("message", (raw) => {
    const message = parseJsonMessage(raw);
    if (!message) return;
    entry.last_seen_at = new Date().toISOString();
    if (message.type === "hello") {
      entry.site = message.site || entry.site;
      entry.capabilities = message.capabilities || entry.capabilities || {};
      updateBridgePresence(bridge_id, { status: "online", last_seen_at: entry.last_seen_at, metadata: { site: entry.site, capabilities: entry.capabilities } });
      safeSend(ws, { type: "hello_ack", bridge_id, timestamp: entry.last_seen_at });
      return;
    }
    if (message.type === "heartbeat") {
      updateBridgePresence(bridge_id, { status: "online", last_seen_at: entry.last_seen_at });
      safeSend(ws, { type: "heartbeat_ack", bridge_id, timestamp: entry.last_seen_at });
      return;
    }
    if (message.type === "phone_observed") {
      recordObservedPhone(bridge_id, message);
      return;
    }
    if (message.type === "command_result") {
      const command = pendingCommands.get(message.command_id);
      if (command?.ws === ws) {
        pendingCommands.delete(message.command_id);
        clearTimeout(command.timer);
        const result = message.result ?? null;
        const discoveredIp = result?.discovered_ip || result?.detected_ip || null;
        if (discoveredIp && command.phone_id) {
          recordObservedPhone(bridge_id, { phone_id: command.phone_id, ip: discoveredIp, source: "bridge_command_result" });
        }
        command.resolve({ ok: message.ok !== false, command_id: message.command_id, result, error: message.error || null, bridge_id });
      }
    }
  });

  ws.on("close", () => {
    if (bridges.get(bridge_id)?.ws === ws) bridges.delete(bridge_id);
    for (const [commandId, pending] of pendingCommands.entries()) {
      if (pending.bridge_id === bridge_id && pending.ws === ws) {
        pendingCommands.delete(commandId);
        clearTimeout(pending.timer);
        pending.resolve({ ok: false, command_id: commandId, bridge_id, error: "bridge_disconnected" });
      }
    }
    updateBridgePresence(bridge_id, { status: "offline", metadata: { disconnected_at: new Date().toISOString() } });
    relayLogger.info("hardphone_bridge_disconnected", { bridgeId: bridge_id });
  });

  return entry;
}

export async function sendBridgeCommand({ bridge_id, phone_id = null, vendor, host, action, payload = {}, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS }) {
  const auditId = await insertCommandAudit({ bridge_id, phone_id, vendor, host, action, payload });
  const bridge = bridges.get(bridge_id);
  if (!bridge || !isOpen(bridge.ws)) {
    const outcome = { ok: false, bridge_id, error: "bridge_offline" };
    await finishCommandAudit(auditId, outcome);
    return outcome;
  }
  const command_id = crypto.randomUUID();
  return new Promise((resolve) => {
    const finish = (outcome) => {
      finishCommandAudit(auditId, outcome);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      pendingCommands.delete(command_id);
      finish({ ok: false, command_id, bridge_id, error: "result_timeout" });
    }, timeoutMs);
    timer.unref?.();
    pendingCommands.set(command_id, { bridge_id, ws: bridge.ws, resolve: finish, timer });
    const sent = safeSend(bridge.ws, { type: "command", command_id, vendor, host, action, payload });
    if (!sent) {
      clearTimeout(timer);
      pendingCommands.delete(command_id);
      finish({ ok: false, command_id, bridge_id, error: "send_failed" });
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
