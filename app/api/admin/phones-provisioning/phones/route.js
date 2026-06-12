import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { normalizeMac, SUPPORTED_VENDORS } from "@/lib/hardphones/config-generators.mjs";
import { createPhoneCredential, deletePhoneCredential } from "@/lib/hardphones/credentials.mjs";
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

const PHONE_COLUMNS = `id, mac, vendor, model, label, agent_id, telnyx_credential_id, sip_username,
  admin_password, settings, provisioning_state, ip_address, last_ip, local_bridge_id, last_seen_at, last_user_agent, created_at, updated_at`;

export async function GET() {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const { rows } = await pool.query(`SELECT ${PHONE_COLUMNS} FROM hp_phones ORDER BY created_at DESC LIMIT 500`);
    const { rows: eventRows } = await pool.query(
      `SELECT phone_id, MAX(created_at) AS last_event_at, COUNT(*)::int AS events
       FROM hp_provisioning_events WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY phone_id`,
    );
    const { rows: registrationRows } = await pool.query(
      `SELECT DISTINCT ON (phone_id) phone_id, detail->>'registration_status' AS sip_registration_status, created_at AS registration_status_at
       FROM hp_provisioning_events
       WHERE event_type = 'registration_status_event'
       ORDER BY phone_id, created_at DESC`,
    );
    const eventsByPhone = Object.fromEntries(eventRows.map((r) => [r.phone_id, r]));
    const registrationByPhone = Object.fromEntries(registrationRows.map((r) => [r.phone_id, r]));
    return NextResponse.json({ phones: rows.map((p) => ({
      ...p,
      recent_events: eventsByPhone[p.id]?.events || 0,
      sip_registration_status: registrationByPhone[p.id]?.sip_registration_status || "unknown",
      sip_registration_status_at: registrationByPhone[p.id]?.registration_status_at || null,
    })) });
  } catch (err) {
    adminRuntimeLogger.error("hardphone_list_failed", runtimePayload({ error: err, operation: "hp_list" }));
    return NextResponse.json({ error: "Failed to load phones" }, { status: 500 });
  }
}

export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const body = await request.json();
    const mac = normalizeMac(body?.mac);
    const vendor = String(body?.vendor || "").toLowerCase();
    if (!mac) return NextResponse.json({ error: "Valid 12-hex-digit MAC address is required" }, { status: 400 });
    if (!SUPPORTED_VENDORS.includes(vendor)) {
      return NextResponse.json({ error: `Vendor must be one of: ${SUPPORTED_VENDORS.join(", ")}` }, { status: 400 });
    }
    const { rows: existing } = await pool.query(`SELECT id FROM hp_phones WHERE mac = $1`, [mac]);
    if (existing.length) return NextResponse.json({ error: "A phone with this MAC already exists" }, { status: 409 });

    const label = String(body?.label || "").trim() || null;
    let credential = { id: null, sip_username: null, sip_password: null };
    try {
      credential = await createPhoneCredential({ label, mac });
    } catch (err) {
      adminRuntimeLogger.error("hardphone_credential_failed", runtimePayload({ error: err, operation: "hp_credential_create" }));
      return NextResponse.json({ error: err.message }, { status: 502 });
    }

    let client = null;
    let commitStarted = false;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      const adminPassword = String(body?.admin_password || "").trim() || randomUUID().slice(0, 12);
      const ipAddress = String(body?.ip_address || body?.settings?.ip_address || "").trim() || null;
      const { rows } = await client.query(
        `INSERT INTO hp_phones (mac, vendor, model, label, agent_id, telnyx_credential_id, sip_username, sip_password, admin_password, settings, ip_address, local_bridge_id, provisioning_state, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13)
         RETURNING ${PHONE_COLUMNS}`,
        [
          mac,
          vendor,
          String(body?.model || "").trim() || null,
          label,
          String(body?.agent_id || "").trim() || null,
          credential.id,
          credential.sip_username,
          credential.sip_password,
          adminPassword,
          JSON.stringify(body?.settings && typeof body.settings === "object" ? body.settings : {}),
          ipAddress,
          String(body?.local_bridge_id || body?.settings?.local_bridge_id || "").trim() || null,
          user.id || user.email || null,
        ],
      );
      await client.query(
        `INSERT INTO hp_provisioning_events (phone_id, mac, event_type, detail) VALUES ($1, $2, 'created', $3)`,
        [rows[0].id, mac, JSON.stringify({ vendor, credential_id: credential.id })],
      );
      commitStarted = true;
      await client.query("COMMIT");
      return NextResponse.json({ phone: rows[0] }, { status: 201 });
    } catch (err) {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackErr) {
          adminRuntimeLogger.error("hardphone_create_rollback_failed", runtimePayload({ error: rollbackErr, operation: "hp_create_rollback" }));
        }
      }
      if (credential.id && !commitStarted) {
        try {
          await deletePhoneCredential(credential.id);
        } catch (cleanupErr) {
          adminRuntimeLogger.error(
            "hardphone_credential_cleanup_failed",
            runtimePayload({ error: cleanupErr, operation: "hp_credential_cleanup", credential_id: credential.id }),
          );
        }
      }
      throw err;
    } finally {
      if (client) client.release();
    }
  } catch (err) {
    adminRuntimeLogger.error("hardphone_create_failed", runtimePayload({ error: err, operation: "hp_create" }));
    return NextResponse.json({ error: "Failed to create phone" }, { status: 500 });
  }
}
