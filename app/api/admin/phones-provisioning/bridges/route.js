import { NextResponse } from "next/server";
import crypto from "crypto";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";


function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function bridgeIdFromLabel(label) {
  const base = String(label || "local-bridge").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "local-bridge";
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

function relayBaseUrl() {
  return (process.env.HARDPHONE_BRIDGE_RELAY_URL || `http://127.0.0.1:${process.env.STREAMING_WS_PORT || 3001}`).replace(/\/$/, "");
}

function relayAdminToken() {
  return process.env.HARDPHONE_BRIDGE_ADMIN_TOKEN || process.env.HARDPHONE_BRIDGE_TOKEN || process.env.BRIDGE_TOKEN || "";
}

function appendUrlPath(basePath, routePath) {
  const normalizedBase = String(basePath || "").replace(/\/+$/, "");
  const normalizedRoute = String(routePath || "").replace(/^\/+/, "");
  return `/${[normalizedBase.replace(/^\/+/, ""), normalizedRoute].filter(Boolean).join("/")}`;
}

function ccWsUrl() {
  const explicitWsBase = process.env.WS_BASE_URL || process.env.STREAMING_WS_URL;
  const appBase = process.env.NEXT_PUBLIC_BASE_URL || process.env.APP_BASE_URL || process.env.NEXTAUTH_URL || "https://<cc-host>";
  const wsPort = process.env.STREAMING_WS_PORT || "3001";
  try {
    const url = new URL(explicitWsBase || appBase);
    url.protocol = url.protocol === "http:" ? "ws:" : url.protocol === "https:" ? "wss:" : url.protocol;
    if (!explicitWsBase) url.port = wsPort;
    url.pathname = appendUrlPath(explicitWsBase ? url.pathname : "", "/hardphone-bridge");
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return `wss://<cc-host>:${wsPort}/hardphone-bridge`;
  }
}

async function liveBridges() {
  const headers = {};
  const token = relayAdminToken();
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${relayBaseUrl()}/api/hardphone-bridge/bridges`, { headers, cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data.bridges) ? data.bridges : [];
  } catch {
    return [];
  }
}

async function GET_handler(_request, _context, authz) {
  const user = authz.user;
  // Hardphone provisioning is an experimental feature enabled per user.
  if (user.experimental_features !== true) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const [{ rows }, live] = await Promise.all([
      pool.query(`SELECT id, bridge_id, label, site, status, last_seen_at, metadata, created_at, updated_at FROM hp_local_bridges ORDER BY created_at DESC LIMIT 200`),
      liveBridges(),
    ]);
    const liveById = new Map(live.map((b) => [b.bridge_id, b]));
    const bridges = rows.map((b) => {
      const liveBridge = liveById.get(b.bridge_id);
      const status = liveBridge?.online ? "online" : "offline";
      return {
        ...b,
        online: Boolean(liveBridge?.online),
        live: liveBridge || null,
        status,
        last_seen_at: liveBridge?.last_seen_at || b.last_seen_at,
      };
    });
    return NextResponse.json({ ok: true, bridges, relay_url: relayBaseUrl() });
  } catch (err) {
    adminRuntimeLogger.error("hardphone_bridge_list_failed", runtimePayload({ error: err, operation: "hp_bridge_list" }));
    return NextResponse.json({ error: "Failed to load local bridges" }, { status: 500 });
  }
}

async function POST_handler(request, _context, authz) {
  const user = authz.user;
  // Hardphone provisioning is an experimental feature enabled per user.
  if (user.experimental_features !== true) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const body = await request.json().catch(() => ({}));
    const label = String(body?.label || "Local bridge").trim();
    const site = String(body?.site || "").trim() || null;
    const bridgeId = String(body?.bridge_id || "").trim() || bridgeIdFromLabel(label);
    const token = crypto.randomBytes(32).toString("hex");
    const { rows } = await pool.query(
      `INSERT INTO hp_local_bridges (bridge_id, label, site, token_hash, status, metadata, created_by)
       VALUES ($1, $2, $3, $4, 'offline', $5, $6)
       RETURNING id, bridge_id, label, site, status, last_seen_at, metadata, created_at, updated_at`,
      [bridgeId, label, site, tokenHash(token), JSON.stringify({ relay_url: relayBaseUrl() }), user.id || user.email || null],
    );
    const bridgeEnvBlock = `BRIDGE_ID=${bridgeId}\nBRIDGE_TOKEN=${token}\nCC_WS_URL=${ccWsUrl()}`;
    return NextResponse.json({ ok: true, bridge: rows[0], enrollment: { bridge_id: bridgeId, token, cc_ws_url: ccWsUrl(), env: bridgeEnvBlock, cc_ws_path: "/hardphone-bridge" } }, { status: 201 });
  } catch (err) {
    adminRuntimeLogger.error("hardphone_bridge_create_failed", runtimePayload({ error: err, operation: "hp_bridge_create" }));
    return NextResponse.json({ error: "Failed to create local bridge" }, { status: 500 });
  }
}

async function PATCH_handler(request, _context, authz) {
  const user = authz.user;
  // Hardphone provisioning is an experimental feature enabled per user.
  if (user.experimental_features !== true) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const body = await request.json().catch(() => ({}));
    const bridgeId = String(body?.bridge_id || "").trim();
    if (!bridgeId) return NextResponse.json({ error: "bridge_id is required" }, { status: 400 });
    const label = String(body?.label || "").trim();
    const site = String(body?.site || body?.location || "").trim() || null;
    if (!label) return NextResponse.json({ error: "Bridge label is required" }, { status: 400 });
    const { rows } = await pool.query(
      `UPDATE hp_local_bridges
          SET label = $2, site = $3, updated_at = NOW()
        WHERE bridge_id = $1
        RETURNING id, bridge_id, label, site, status, last_seen_at, metadata, created_at, updated_at`,
      [bridgeId, label, site],
    );
    if (!rows.length) return NextResponse.json({ error: "Bridge not found" }, { status: 404 });
    return NextResponse.json({ ok: true, bridge: rows[0] });
  } catch (err) {
    adminRuntimeLogger.error("hardphone_bridge_update_failed", runtimePayload({ error: err, operation: "hp_bridge_update" }));
    return NextResponse.json({ error: "Failed to update local bridge" }, { status: 500 });
  }
}

async function DELETE_handler(request, _context, authz) {
  const user = authz.user;
  // Hardphone provisioning is an experimental feature enabled per user.
  if (user.experimental_features !== true) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const { searchParams } = new URL(request.url);
    const body = request.headers.get("content-type")?.includes("application/json") ? await request.json().catch(() => ({})) : {};
    const bridgeId = String(searchParams.get("bridge_id") || body?.bridge_id || "").trim();
    if (!bridgeId) return NextResponse.json({ error: "bridge_id is required" }, { status: 400 });

    const assigned = await pool.query(
      `SELECT id FROM hp_phones
        WHERE local_bridge_id = $1 OR settings->>'local_bridge_id' = $1
        LIMIT 1`,
      [bridgeId],
    );
    if (assigned.rows.length) {
      return NextResponse.json({ error: "Remove all phones from this bridge before deleting it" }, { status: 409 });
    }

    const { rows } = await pool.query(
      `DELETE FROM hp_local_bridges
        WHERE bridge_id = $1
        RETURNING id, bridge_id, label, site, status, last_seen_at, metadata, created_at, updated_at`,
      [bridgeId],
    );
    if (!rows.length) return NextResponse.json({ error: "Bridge not found" }, { status: 404 });
    return NextResponse.json({ ok: true, bridge: rows[0] });
  } catch (err) {
    adminRuntimeLogger.error("hardphone_bridge_delete_failed", runtimePayload({ error: err, operation: "hp_bridge_delete" }));
    return NextResponse.json({ error: "Failed to delete local bridge" }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("phones:read", GET_handler, { route: "/api/admin/phones-provisioning/bridges" });
export const POST = withPermission("phones:create", POST_handler, { route: "/api/admin/phones-provisioning/bridges" });
export const PATCH = withPermission("phones:update", PATCH_handler, { route: "/api/admin/phones-provisioning/bridges" });
export const DELETE = withPermission("phones:delete", DELETE_handler, { route: "/api/admin/phones-provisioning/bridges" });
