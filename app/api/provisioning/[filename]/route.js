import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import {
  resolveProvisioningRequest,
  buildConfigForPhone,
  yealinkCommonConfig,
  vendorFromUserAgent,
} from "@/lib/hardphones/config-generators.mjs";
import { voiceRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";

export const dynamic = "force-dynamic";

function resolveBaseUrl(request) {
  const candidates = [
    process.env.TELNYX_WEBHOOK_BASE_URL,
    process.env.NEXTAUTH_URL,
    process.env.APP_BASE_URL,
    process.env.NEXT_PUBLIC_BASE_URL,
  ];
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

function requestIp(request) {
  const fwd = request.headers.get("x-forwarded-for") || "";
  const ip = fwd.split(",")[0].trim() || request.headers.get("x-real-ip") || "";
  return ip || null;
}

async function logEvent(pool, { phoneId = null, mac = null, eventType, detail = {} }) {
  try {
    await pool.query(
      `INSERT INTO hp_provisioning_events (phone_id, mac, event_type, detail) VALUES ($1, $2, $3, $4)`,
      [phoneId, mac, eventType, JSON.stringify(detail)],
    );
  } catch {}
}

// GET /api/provisioning/[filename] — public zero-touch provisioning endpoint.
// Phones fetch their config files here at boot (DHCP option 66/160 or vendor
// redirect service points at https://<host>/api/provisioning/). Unknown MACs
// get 404 and are logged — only inventoried phones are served credentials.
export async function GET(request, { params }) {
  const pool = getPostgresPool();
  if (!pool) return new NextResponse("Server not ready", { status: 500 });

  const { filename } = await params;
  const resolved = resolveProvisioningRequest(filename);
  const userAgent = request.headers.get("user-agent") || "";
  const uaVendor = vendorFromUserAgent(userAgent);

  if (!resolved) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Yealink common config — static fleet defaults, no credentials inside.
  if (resolved.kind === "common") {
    const baseUrl = resolveBaseUrl(request);
    await logEvent(pool, { eventType: "common_config_fetch", detail: { filename, userAgent } });
    return new NextResponse(yealinkCommonConfig({ baseUrl }), {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // Polycom default master config — intentionally not served (unknown phones
  // must be added to inventory first).
  if (resolved.kind === "default-master") {
    await logEvent(pool, { eventType: "unknown_phone_request", detail: { filename, userAgent } });
    return new NextResponse("Not found", { status: 404 });
  }

  const mac = resolved.mac;
  const { rows } = await pool.query(
    `SELECT id, mac, vendor, model, label, sip_username, sip_password, admin_password, settings, provisioning_state
     FROM hp_phones WHERE mac = $1`,
    [mac],
  );
  const phone = rows[0];

  if (!phone) {
    await logEvent(pool, { mac, eventType: "unknown_phone_request", detail: { filename, userAgent, uaVendor } });
    return new NextResponse("Not found", { status: 404 });
  }
  if (phone.provisioning_state === "disabled") {
    await logEvent(pool, { phoneId: phone.id, mac, eventType: "disabled_phone_request", detail: { filename } });
    return new NextResponse("Not found", { status: 404 });
  }

  // Polycom requests two files: <mac>.cfg (master) then <mac>-reg.cfg.
  const kind = resolved.kind === "registration" ? "registration" : "mac-config";
  const baseUrl = resolveBaseUrl(request);
  const config = buildConfigForPhone(phone, kind, { baseUrl });
  if (!config) {
    voiceRuntimeLogger.warn("hardphone_config_generation_failed", runtimePayload({ operation: "hp_serve", detail: { vendor: phone.vendor, kind } }));
    return new NextResponse("Not found", { status: 404 });
  }

  await pool.query(
    `UPDATE hp_phones SET last_seen_at = NOW(), last_user_agent = $2, last_ip = COALESCE($3, last_ip),
       provisioning_state = CASE WHEN provisioning_state = 'pending' THEN 'provisioned' ELSE provisioning_state END
     WHERE id = $1`,
    [phone.id, userAgent.slice(0, 300) || null, requestIp(request)],
  );
  await logEvent(pool, {
    phoneId: phone.id,
    mac,
    eventType: "config_served",
    detail: { filename, kind, vendor: phone.vendor, userAgent, uaVendorMismatch: Boolean(uaVendor && uaVendor !== phone.vendor) },
  });

  return new NextResponse(config.body, {
    status: 200,
    headers: { "Content-Type": `${config.contentType}; charset=utf-8`, "Cache-Control": "no-store" },
  });
}
