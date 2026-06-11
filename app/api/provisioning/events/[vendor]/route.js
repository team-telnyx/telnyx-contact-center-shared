import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { normalizeMac } from "@/lib/hardphones/config-generators.mjs";

export const dynamic = "force-dynamic";

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

  let phoneId = null;
  if (mac) {
    const { rows } = await pool.query(`SELECT id FROM hp_phones WHERE mac = $1`, [mac]);
    phoneId = rows[0]?.id || null;
    if (phoneId) await pool.query(`UPDATE hp_phones SET last_seen_at = NOW() WHERE id = $1`, [phoneId]);
  }
  try {
    await pool.query(
      `INSERT INTO hp_provisioning_events (phone_id, mac, event_type, detail) VALUES ($1, $2, $3, $4)`,
      [phoneId, mac, `phone_event_${vendor}`, JSON.stringify({ query: queryParams, body })],
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
