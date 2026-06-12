#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
const DEFAULT_POLY_ADMIN_PASSWORD = process.env.DEFAULT_POLY_ADMIN_PASSWORD || "";
const DEFAULT_YEALINK_ADMIN_USER = process.env.DEFAULT_YEALINK_ADMIN_USER || "admin";
const DEFAULT_YEALINK_ADMIN_PASSWORD = process.env.DEFAULT_YEALINK_ADMIN_PASSWORD || "";

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

async function yealinkAction(host, command, { user = DEFAULT_YEALINK_ADMIN_USER, password = DEFAULT_YEALINK_ADMIN_PASSWORD } = {}) {
  const auth = user || password ? { authorization: "Basic " + Buffer.from(`${user}:${password}`).toString("base64") } : {};
  const result = await requestJson(yealinkUrl(host, command), { headers: auth });
  return { ok: result.ok, httpStatus: result.status, raw: result.raw?.slice(0, 500) || null };
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  return JSON.parse(raw);
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
    const body = req.method === "GET" ? {} : await readBody(req);
    if (vendor === "polycom") {
      const password = body.admin_password || body.password || "";
      if (action === "status" && req.method === "GET") return json(res, 200, await polyStatus(host, password));
      if (action === "dial" && req.method === "POST") return json(res, 200, await polyRequest(host, "/api/v1/callctrl/dial", { method: "POST", password, body: { data: { Dest: String(body.number || body.target || ""), Line: "1", Type: "SIP" } } }));
      if (["answer", "hangup", "hold", "resume"].includes(action) && req.method === "POST") {
        const ref = await activePolyCallRef(host, password);
        if (!ref) return json(res, 200, { ok: false, reason: "no_active_call" });
        const map = { answer: "answerCall", hangup: "endCall", hold: "holdCall", resume: "resumeCall" };
        return json(res, 200, await polyRequest(host, `/api/v1/callctrl/${map[action]}`, { method: "POST", password, body: { data: { Ref: ref } } }));
      }
      if (action === "reboot" && req.method === "POST") return json(res, 200, await polyRequest(host, "/api/v1/mgmt/safeReboot", { method: "POST", password }));
      if (action === "reprovision" && req.method === "POST") return json(res, 200, await polyRequest(host, "/api/v1/mgmt/updateConfiguration", { method: "POST", password }));
    }
    if (vendor === "yealink") {
      if (action === "dial" && req.method === "POST") return json(res, 200, await yealinkAction(host, `number=${body.number || body.target || ""}`));
      if (action === "answer" && req.method === "POST") return json(res, 200, await yealinkAction(host, "OK"));
      if (action === "hangup" && req.method === "POST") return json(res, 200, await yealinkAction(host, "CALLEND"));
      if (action === "hold" && req.method === "POST") return json(res, 200, await yealinkAction(host, "F_HOLD"));
      if (action === "reboot" && req.method === "POST") return json(res, 200, await yealinkAction(host, "Reboot"));
    }
    json(res, 400, { ok: false, reason: "unsupported_action" });
  } catch (err) {
    json(res, 500, { ok: false, reason: err?.message || "bridge_error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ ok: true, service: "hardphone-bridge", port: PORT }));
});
