#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
const CC_WS_URL = process.env.CC_WS_URL || "";
const BRIDGE_ID = process.env.BRIDGE_ID || `local-${crypto.randomUUID()}`;
const BRIDGE_SITE = process.env.BRIDGE_SITE || process.env.SITE_NAME || "local";
const RECONNECT_MS = Number(process.env.RECONNECT_MS || 5000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 25000);
const DEFAULT_POLY_ADMIN_PASSWORD = process.env.DEFAULT_POLY_ADMIN_PASSWORD || "";
const DEFAULT_YEALINK_ADMIN_USER = process.env.DEFAULT_YEALINK_ADMIN_USER || "admin";
const DEFAULT_YEALINK_ADMIN_PASSWORD = process.env.DEFAULT_YEALINK_ADMIN_PASSWORD || "";
const DEFAULT_AUDIOCODES_ADMIN_USER = process.env.DEFAULT_AUDIOCODES_ADMIN_USER || "admin";
const DEFAULT_AUDIOCODES_ADMIN_PASSWORD = process.env.DEFAULT_AUDIOCODES_ADMIN_PASSWORD || "";
const PHONE_MAC_IP_MAP = process.env.PHONE_MAC_IP_MAP || "";

const POLY_USER = "Polycom";
const POLY_ERRORS = {
  4000: "Invalid parameters",
  4001: "Device busy",
  4002: "Line not registered",
  4003: "Operation not allowed",
  4004: "Operation not supported",
  4005: "Line does not exist",
  4007: "Call does not exist",
  4009: "Input size exceeded",
  4010: "Default admin password must be changed",
  5000: "Internal phone failure",
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function requestJson(url, { method = "GET", headers = {}, body = null, timeoutMs = 6000 } = {}) {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers: payload ? { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : headers,
      timeout: timeoutMs,
      rejectUnauthorized: false,
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode || 0, ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, data, raw });
      });
    });
    req.on("timeout", () => req.destroy(new Error("request_timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestText(url, { method = "GET", headers = {}, body = null, timeoutMs = 6000 } = {}) {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  const payload = body == null ? null : String(body);
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers: payload ? { ...headers, "content-length": Buffer.byteLength(payload) } : headers,
      timeout: timeoutMs,
      rejectUnauthorized: false,
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode || 0, ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, raw, headers: res.headers || {} }));
    });
    req.on("timeout", () => req.destroy(new Error("request_timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function polyHeaders(password) {
  return { authorization: "Basic " + Buffer.from(`${POLY_USER}:${password || DEFAULT_POLY_ADMIN_PASSWORD}`).toString("base64") };
}

function normalizePoly(result) {
  if (result.status === 401 || result.status === 403) return { ok: false, reason: "auth_failed", httpStatus: result.status };
  const status = String(result.data?.Status || "");
  if (result.ok && status === "2000") return { ok: true, data: result.data };
  return { ok: false, reason: POLY_ERRORS[Number(status)] || `HTTP ${result.status}`, polyStatus: status || null, httpStatus: result.status, data: result.data || undefined };
}

async function polyRequest(host, path, { method = "GET", body = null, password = "" } = {}) {
  let first;
  try {
    first = await requestJson(`https://${host}${path}`, { method, headers: polyHeaders(password), body });
    const status = String(first.data?.Status || "");
    if (first.status !== 404 && first.status !== 405 && first.status !== 501 || status || first.status === 401 || first.status === 403) {
      return normalizePoly(first);
    }
  } catch (err) {
    first = { error: err };
  }
  try {
    const fallback = await requestJson(`http://${host}${path}`, { method, headers: polyHeaders(password), body });
    return normalizePoly(fallback);
  } catch (err) {
    return { ok: false, reason: "phone_unreachable", error: err?.message || first?.error?.message || String(err) };
  }
}

async function polyStatus(host, password) {
  const [callStatus, lineInfo] = await Promise.all([
    polyRequest(host, "/api/v1/webCallControl/callStatus", { password }),
    polyRequest(host, "/api/v1/mgmt/lineInfo", { password }),
  ]);
  return { ok: callStatus.ok || lineInfo.ok, reachable: callStatus.ok || lineInfo.ok, call: callStatus.ok ? callStatus.data?.data ?? null : null, line: lineInfo.ok ? lineInfo.data?.data ?? null : null, reason: callStatus.ok || lineInfo.ok ? undefined : callStatus.reason };
}

async function activePolyCallRef(host, password) {
  const result = await polyRequest(host, "/api/v1/webCallControl/callStatus", { password });
  if (!result.ok) return null;
  const payload = result.data?.data;
  const calls = Array.isArray(payload) ? payload : payload ? [payload] : [];
  const call = calls.find((c) => c?.Ref || c?.CallHandle) || null;
  return call ? (call.Ref || call.CallHandle) : null;
}

function yealinkUrl(host, command) {
  return `http://${host}/servlet?key=${encodeURIComponent(command)}`;
}

function normalizeMac(raw) {
  const mac = String(raw || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return mac.length === 12 ? mac : "";
}

function macPairs() {
  return PHONE_MAC_IP_MAP.split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const sep = entry.indexOf("=");
      if (sep <= 0) return null;
      const mac = entry.slice(0, sep);
      const ip = entry.slice(sep + 1);
      const normalizedMac = normalizeMac(mac);
      const host = String(ip || "").trim();
      return normalizedMac && host ? { mac: normalizedMac, ip: host } : null;
    })
    .filter(Boolean);
}

function mappedIpForMac(mac) {
  const normalized = normalizeMac(mac);
  return macPairs().find((entry) => entry.mac === normalized)?.ip || "";
}

function observedPhones() {
  return macPairs().map((entry) => ({ mac: entry.mac, ip: entry.ip, source: "PHONE_MAC_IP_MAP" }));
}

async function yealinkAction(host, command, { user = DEFAULT_YEALINK_ADMIN_USER, password = DEFAULT_YEALINK_ADMIN_PASSWORD } = {}) {
  const auth = user || password ? { authorization: "Basic " + Buffer.from(`${user}:${password}`).toString("base64") } : {};
  const result = await requestJson(yealinkUrl(host, command), { headers: auth });
  return { ok: result.ok, httpStatus: result.status, raw: result.raw?.slice(0, 500) || null };
}

function parseAudioCodesVoipStatus(raw) {
  const xml = String(raw || "");
  const lineMatches = [...xml.matchAll(/<Line\b[^>]*>([\s\S]*?)<\/Line>/gi)];
  const lines = lineMatches.map((match) => {
    const lineXml = match[1] || "";
    const get = (tag) => lineXml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1]?.trim() || "";
    return {
      PhoneState: get("PhoneState"),
      RegistrationStatus: get("SipStatus"),
      SipRegSrv: get("SipRegSrv"),
      Dnd: get("Dnd"),
      Mute: get("Mute"),
      ForwardState: get("ForwardState"),
    };
  });
  const primary = lines.find((line) => line.PhoneState && line.PhoneState.toLowerCase() !== "disabled") || lines[0] || null;
  const registration = primary?.RegistrationStatus || null;
  return { line: lines, registration: registration ? registration.toLowerCase() : null };
}

async function audiocodesSessionCookie(host, { user = DEFAULT_AUDIOCODES_ADMIN_USER, password = DEFAULT_AUDIOCODES_ADMIN_PASSWORD } = {}) {
  if (!password) return "";
  const form = new URLSearchParams({ user: user || "admin", psw: Buffer.from(String(password)).toString("base64") }).toString();
  const response = await requestText(`http://${host}/login.cgi`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    timeoutMs: 5000,
  });
  const setCookie = response.headers?.["set-cookie"] || [];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  return cookies.map((cookie) => String(cookie).split(";", 1)[0]).filter(Boolean).join("; ");
}

async function audiocodesStatus(host, { user = DEFAULT_AUDIOCODES_ADMIN_USER, password = DEFAULT_AUDIOCODES_ADMIN_PASSWORD } = {}) {
  try {
    let cookie = "";
    try { cookie = await audiocodesSessionCookie(host, { user, password }); } catch {}
    const headers = cookie ? { cookie } : {};
    const voipStatus = await requestText(`http://${host}/voip_status.cgi`, { headers, timeoutMs: 5000 });
    if (voipStatus.ok && /<Status[\s>]/i.test(voipStatus.raw || "")) {
      const parsed = parseAudioCodesVoipStatus(voipStatus.raw);
      return {
        ok: true,
        reachable: true,
        httpStatus: voipStatus.status,
        vendor: "audiocodes",
        registration: parsed.registration,
        line: parsed.line,
      };
    }
    const result = await requestJson(`http://${host}/`, { timeoutMs: 5000 });
    return { ok: result.ok, reachable: result.ok, httpStatus: result.status, vendor: "audiocodes", registration: null };
  } catch (err) {
    return { ok: false, reachable: false, reason: "phone_unreachable", error: err?.message || String(err) };
  }
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  return JSON.parse(raw);
}

async function readRequestPayload(req, url) {
  const queryPayload = Object.fromEntries(url.searchParams.entries());
  const hasBody = Number(req.headers["content-length"] || 0) > 0 || /json/i.test(String(req.headers["content-type"] || ""));
  if (!hasBody) return queryPayload;
  return { ...queryPayload, ...await readBody(req) };
}

function requireToken(req, res) {
  if (!BRIDGE_TOKEN) return true;
  const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || req.headers["x-bridge-token"] || "";
  const a = Buffer.from(String(got));
  const b = Buffer.from(BRIDGE_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    json(res, 401, { ok: false, reason: "unauthorized" });
    return false;
  }
  return true;
}

function hostFromPath(parts) {
  const host = parts[2];
  if (!/^([a-z0-9.-]+|\d{1,3}(\.\d{1,3}){3})$/i.test(host || "")) throw new Error("invalid_host");
  return host;
}

async function executeCommand({ vendor, host, action = "status", payload = {} }) {
  host = host || mappedIpForMac(payload.mac || payload.phone_mac || "");
  if (!host) return { ok: false, reason: "missing_host" };
  if (vendor === "polycom") {
    const password = payload.admin_password || payload.password || "";
    if (action === "status") return polyStatus(host, password);
    if (action === "dial") return polyRequest(host, "/api/v1/callctrl/dial", { method: "POST", password, body: { data: { Dest: String(payload.number || payload.target || ""), Line: "1", Type: "SIP" } } });
    if (["answer", "hangup", "hold", "resume"].includes(action)) {
      const ref = await activePolyCallRef(host, password);
      if (!ref) return { ok: false, reason: "no_active_call" };
      const map = { answer: "answerCall", hangup: "endCall", hold: "holdCall", resume: "resumeCall" };
      return polyRequest(host, `/api/v1/callctrl/${map[action]}`, { method: "POST", password, body: { data: { Ref: ref } } });
    }
    if (action === "reboot") return polyRequest(host, "/api/v1/mgmt/safeReboot", { method: "POST", password });
    if (action === "reprovision") return polyRequest(host, "/api/v1/mgmt/updateConfiguration", { method: "POST", password });
  }
  if (vendor === "yealink") {
    if (action === "dial") return yealinkAction(host, `number=${payload.number || payload.target || ""}`);
    if (action === "answer") return yealinkAction(host, "OK");
    if (action === "hangup") return yealinkAction(host, "CALLEND");
    if (action === "hold") return yealinkAction(host, "F_HOLD");
    if (action === "reboot") return yealinkAction(host, "Reboot");
  }
  if (vendor === "audiocodes") {
    if (action === "status") {
      const user = payload.admin_user || payload.user || DEFAULT_AUDIOCODES_ADMIN_USER;
      const password = payload.admin_password || payload.password || DEFAULT_AUDIOCODES_ADMIN_PASSWORD;
      return { ...(await audiocodesStatus(host, { user, password })), discovered_ip: host };
    }
  }
  return { ok: false, reason: "unsupported_action" };
}

function buildCcWsUrl() {
  if (!CC_WS_URL) return "";
  const url = new URL(CC_WS_URL);
  url.searchParams.set("bridge_id", BRIDGE_ID);
  url.searchParams.set("site", BRIDGE_SITE);
  if (BRIDGE_TOKEN) url.searchParams.set("token", BRIDGE_TOKEN);
  return url.toString();
}

function startOutboundConnection() {
  const target = buildCcWsUrl();
  if (!target) return;
  if (typeof WebSocket === "undefined") {
    console.error(JSON.stringify({ ok: false, event: "websocket_unavailable" }));
    return;
  }
  let heartbeat = null;
  let closed = false;
  const ws = new WebSocket(target);
  const send = (message) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  ws.addEventListener("open", () => {
    console.log(JSON.stringify({ ok: true, event: "cc_ws_connected", bridge_id: BRIDGE_ID }));
    send({ type: "hello", bridge_id: BRIDGE_ID, site: BRIDGE_SITE, version: "0.1.0", capabilities: { vendors: ["polycom", "yealink", "audiocodes"], actions: ["status", "dial", "answer", "hangup", "hold", "resume", "reboot", "reprovision"], discovery: ["PHONE_MAC_IP_MAP"] } });
    for (const phone of observedPhones()) send({ type: "phone_observed", bridge_id: BRIDGE_ID, ...phone });
    heartbeat = setInterval(() => send({ type: "heartbeat", bridge_id: BRIDGE_ID, timestamp: new Date().toISOString() }), HEARTBEAT_MS);
  });
  ws.addEventListener("message", async (event) => {
    let message = null;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.type !== "command") return;
    try {
      const result = await executeCommand({ vendor: message.vendor, host: message.host, action: message.action, payload: message.payload || {} });
      send({ type: "command_result", command_id: message.command_id, ok: result.ok !== false, result });
    } catch (err) {
      send({ type: "command_result", command_id: message.command_id, ok: false, error: err?.message || String(err) });
    }
  });
  const scheduleReconnect = (event, error = null) => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    console.log(JSON.stringify({ ok: false, event, error, reconnect_ms: RECONNECT_MS }));
    setTimeout(startOutboundConnection, RECONNECT_MS).unref?.();
  };
  ws.addEventListener("close", () => scheduleReconnect("cc_ws_closed"));
  ws.addEventListener("error", () => scheduleReconnect("cc_ws_error"));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, service: "hardphone-bridge", timestamp: new Date().toISOString() });
    if (!requireToken(req, res)) return;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v1") return json(res, 404, { ok: false, reason: "not_found" });
    const vendor = parts[1];
    const host = hostFromPath(parts);
    const action = parts[3] || "status";
    const body = await readRequestPayload(req, url);
    if (vendor === "polycom" || vendor === "yealink" || vendor === "audiocodes") {
      const result = await executeCommand({ vendor, host, action, payload: body });
      return json(res, result.ok === false ? 502 : 200, result);
    }
    json(res, 400, { ok: false, reason: "unsupported_action" });
  } catch (err) {
    json(res, 500, { ok: false, reason: err?.message || "bridge_error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ ok: true, service: "hardphone-bridge", port: PORT, bridge_id: BRIDGE_ID, outbound_enabled: Boolean(CC_WS_URL) }));
  startOutboundConnection();
});
