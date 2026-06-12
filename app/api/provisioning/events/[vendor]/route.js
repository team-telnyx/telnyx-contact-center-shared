import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { normalizeMac } from "@/lib/hardphones/config-generators.mjs";

export const dynamic = "force-dynamic";

const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

function isPrivatePhoneIp(value) {
  const parts = String(value || "").split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function firstPrivateIp(values) {
  for (const value of values) {
    const candidates = String(value || "").match(IPV4_RE) || [];
    for (const candidate of candidates) {
      if (isPrivatePhoneIp(candidate)) return candidate;
    }
  }
  return null;
}

function extractPhoneIp({ request, queryParams, body }) {
  const fwd = request.headers.get("x-forwarded-for") || "";
  const headerIp = fwd.split(",")[0].trim() || request.headers.get("x-real-ip") || "";
  return firstPrivateIp([
    queryParams.ip,
    queryParams.phone_ip,
    queryParams.local_ip,
    queryParams.ip_address,
    body,
    headerIp,
  ]) || headerIp || null;
}

function registrationStatusFromEvent({ vendor, queryParams, body }) {
  const event = String(queryParams.event || "").toLowerCase();
  if (["registered", "register", "registration"].includes(event)) return "registered";
  if (["unregistered", "unregister", "registration_failed"].includes(event)) return "not_registered";
  const text = `${vendor || ""} ${body || ""} ${JSON.stringify(queryParams || {})}`.toLowerCase();
  if (/registrationstatus[^a-z0-9]+registered/.test(text) || /\bregistered\b/.test(text)) return "registered";
  if (/registrationstatus[^a-z0-9]+(?:notregistered|not registered|failed|unregistered)/.test(text) || /\bunregistered\b/.test(text)) return "not_registered";
  return null;
}

// Phone-originated event sink (Phase 1: log only; Phase 2 feeds the CTI
// event stream). Polycom posts XML (apps.telNotification.URL), Yealink fires
// GET action_url hits with query params. Both carry ?mac= for correlation.
async function handleEvent(request, vendor) {
  const pool = getPostgresPool();
  if (!pool) return new NextResponse("Server not ready", { status: 500 });

  const url = new URL(request.url);
  const mac = normalizeMac(url.searchParams.get("mac"));
  const queryParams = Object.fromEntries(url.searchParams.entries());
  let body = null;
  if (request.method === "POST") {
    body = (await request.text().catch(() => "")).slice(0, 4000);
  }

  if (!mac) return NextResponse.json({ error: "Valid MAC address is required" }, { status: 400 });

  const { rows } = await pool.query(`SELECT id FROM hp_phones WHERE mac = $1`, [mac]);
  const phoneId = rows[0]?.id || null;
  if (!phoneId) return NextResponse.json({ error: "Phone not found" }, { status: 404 });

  const ip = extractPhoneIp({ request, queryParams, body });
  const registrationStatus = registrationStatusFromEvent({ vendor, queryParams, body });
  await pool.query(`UPDATE hp_phones SET last_seen_at = NOW(), last_ip = COALESCE($2, last_ip) WHERE id = $1`, [phoneId, ip]);
  const eventType = registrationStatus ? "registration_status_event" : `phone_event_${vendor}`;
  try {
    await pool.query(
      `INSERT INTO hp_provisioning_events (phone_id, mac, event_type, detail) VALUES ($1, $2, $3, $4)`,
      [phoneId, mac, eventType, JSON.stringify({ query: queryParams, body, detected_ip: ip, registration_status: registrationStatus })],
    );
  } catch {}
  return NextResponse.json({ ok: true });
}

export async function GET(request, { params }) {
  const { vendor } = await params;
  return handleEvent(request, String(vendor || "unknown"));
}

export async function POST(request, { params }) {
  const { vendor } = await params;
  return handleEvent(request, String(vendor || "unknown"));
}
