import { NextResponse } from "next/server";
import crypto from "crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) return null;
  let user = null;
  if (id) user = await PgDb.findUserById(id);
  if (!user && email) user = await PgDb.findUserByUsername(email);
  if (!user) return null;
  if (!isAdmin(user)) return null;
  return user;
}

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

function ccWsUrl() {
  const base = process.env.NEXT_PUBLIC_BASE_URL || process.env.APP_BASE_URL || process.env.NEXTAUTH_URL || "https://<cc-host>";
  const wsPort = process.env.STREAMING_WS_PORT || "3001";
  try {
    const url = new URL(base);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    url.port = wsPort;
    url.pathname = "/hardphone-bridge";
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

export async function GET() {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
      return {
        ...b,
        online: Boolean(liveBridge?.online),
        live: liveBridge || null,
        status: liveBridge?.online ? "online" : b.status || "offline",
        last_seen_at: liveBridge?.last_seen_at || b.last_seen_at,
      };
    });
    return NextResponse.json({ ok: true, bridges, relay_url: relayBaseUrl() });
  } catch (err) {
    adminRuntimeLogger.error("hardphone_bridge_list_failed", runtimePayload({ error: err, operation: "hp_bridge_list" }));
    return NextResponse.json({ error: "Failed to load local bridges" }, { status: 500 });
  }
}

export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
