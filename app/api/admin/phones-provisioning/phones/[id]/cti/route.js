import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { executeCtiAction, CTI_ACTIONS } from "@/lib/hardphones/cti.mjs";
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

function registrationStatusFromCtiResult(result) {
  const direct = String(result?.registration || result?.registration_status || result?.data?.registration_status || "").toLowerCase();
  if (direct === "registered") return "registered";
  if (direct && !["unknown", "null", "n/a"].includes(direct)) return "not_registered";
  const lines = Array.isArray(result?.line) ? result.line : result?.line ? [result.line] : [];
  for (const line of lines) {
    const value = String(line?.RegistrationStatus || line?.registration_status || line?.SipStatus || "").toLowerCase();
    if (value === "registered") return "registered";
    if (value && value !== "registered") return "not_registered";
  }
  return null;
}

// POST { action, number?, digits? } — execute a CTI action on a phone.
// Driver is resolved per vendor: Polycom REST, Yealink Action URI, or the
// Telnyx fallback (AudioCodes / settings.cti_mode = "telnyx").
export async function POST(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || "");
    if (!CTI_ACTIONS.includes(action)) {
      return NextResponse.json({ error: `Unknown action — expected one of: ${CTI_ACTIONS.join(", ")}` }, { status: 400 });
    }
    const { rows } = await pool.query(`SELECT * FROM hp_phones WHERE id = $1`, [id]);
    const phone = rows[0];
    if (!phone) return NextResponse.json({ error: "Phone not found" }, { status: 404 });
    if (phone.provisioning_state === "disabled") {
      return NextResponse.json({ error: "Phone provisioning is disabled" }, { status: 409 });
    }

    const result = await executeCtiAction(phone, action, { number: body?.number, digits: body?.digits }, {
      pool,
      baseUrl: resolveBaseUrl(request),
    });

    const registrationStatus = action === "status" ? registrationStatusFromCtiResult(result) : null;
    const discoveredIp = String(result?.discovered_ip || result?.result?.discovered_ip || "").trim();
    if (discoveredIp) {
      await pool.query(`UPDATE hp_phones SET last_ip = $2, last_seen_at = NOW(), updated_at = NOW() WHERE id = $1`, [phone.id, discoveredIp]);
    }
    if (!(action === "status" && body?.silent)) {
      await pool.query(
        `INSERT INTO hp_provisioning_events (phone_id, mac, event_type, detail) VALUES ($1, $2, $3, $4)`,
        [phone.id, phone.mac, action === "status" && registrationStatus ? "registration_status_event" : `cti_${action}`, JSON.stringify({ ok: result.ok, reason: result.reason || null, registration_status: registrationStatus, detected_ip: discoveredIp || null, by: user.email || user.id || null })],
      );
    }

    if (!result.ok) {
      return NextResponse.json({ error: result.reason || "CTI action failed", result }, { status: 502 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    adminRuntimeLogger.error("hardphone_cti_failed", runtimePayload({ error: err, operation: "hp_cti_action" }));
    return NextResponse.json({ error: "Failed to execute CTI action" }, { status: 500 });
  }
}
