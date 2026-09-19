import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { executeCtiAction } from "@/lib/hardphones/cti.mjs";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";


function resolveBaseUrl(request) {
  const candidates = [process.env.TELNYX_WEBHOOK_BASE_URL, process.env.NEXTAUTH_URL, process.env.APP_BASE_URL];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) return value.replace(/\/$/, "");
  }
  try {
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

function validHostOverride(value) {
  const host = String(value || "").trim();
  if (!host) return "";
  return /^([a-z0-9.-]+|\d{1,3}(\.\d{1,3}){3})$/i.test(host) ? host : null;
}

async function POST_handler(request, _context, authz) {
  const user = authz.user;
  // Hardphone provisioning is an experimental feature enabled per user.
  if (user.experimental_features !== true) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const body = await request.json().catch(() => ({}));
    const requestedIds = Array.isArray(body?.phone_ids) ? body.phone_ids.map((id) => String(id)).filter(Boolean) : [];
    const hostOverrides = body?.host_overrides && typeof body.host_overrides === "object" && !Array.isArray(body.host_overrides) ? body.host_overrides : {};
    const all = body?.all === true;
    if (!all && !requestedIds.length) return NextResponse.json({ error: "phone_ids or all=true is required" }, { status: 400 });

    const { rows: phones } = all
      ? await pool.query(`SELECT * FROM hp_phones WHERE provisioning_state <> 'disabled' ORDER BY created_at DESC LIMIT 500`)
      : await pool.query(`SELECT * FROM hp_phones WHERE id = ANY($1::uuid[]) AND provisioning_state <> 'disabled' ORDER BY created_at DESC LIMIT 500`, [requestedIds]);

    const results = [];
    for (const phone of phones) {
      const hostOverride = validHostOverride(hostOverrides[phone.id] || "");
      if (hostOverride === null) {
        results.push({ id: phone.id, mac: phone.mac, vendor: phone.vendor, model: phone.model, ok: false, reason: "Invalid phone IP/host override" });
        continue;
      }
      const targetPhone = hostOverride ? { ...phone, last_ip: hostOverride, ip_address: hostOverride } : phone;
      const result = await executeCtiAction(targetPhone, "reboot", {}, { pool, baseUrl: resolveBaseUrl(request) });
      results.push({ id: phone.id, mac: phone.mac, vendor: phone.vendor, model: phone.model, ok: Boolean(result.ok), reason: result.reason || null });
      await pool.query(
        `INSERT INTO hp_provisioning_events (phone_id, mac, event_type, detail) VALUES ($1, $2, 'cti_reboot', $3)`,
        [phone.id, phone.mac, JSON.stringify({ ok: Boolean(result.ok), reason: result.reason || null, by: user.email || user.id || null })],
      );
    }

    const okCount = results.filter((r) => r.ok).length;
    return NextResponse.json({ ok: okCount > 0, requested: all ? "all" : requestedIds.length, results });
  } catch (err) {
    adminRuntimeLogger.error("hardphone_bulk_reboot_failed", runtimePayload({ error: err, operation: "hp_bulk_reboot" }));
    return NextResponse.json({ error: "Failed to request phone reboot" }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("phones:create", POST_handler, { route: "/api/admin/phones-provisioning/phones/reboot" });
