import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { normalizeMac, SUPPORTED_VENDORS } from "@/lib/hardphones/config-generators.mjs";
import { assignPhoneNumberToConnection, createPhoneSipConnection, deletePhoneSipConnection, listUnassignedPhoneNumbers, updatePhoneSipConnectionCallerId } from "@/lib/hardphones/credentials.mjs";
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

const PHONE_COLUMNS = `id, phone_name, mac, vendor, model, label, agent_id, telnyx_credential_id, telnyx_connection_id, telnyx_connection_name,
  assigned_phone_number_id, assigned_phone_number, sip_username, admin_password, settings, provisioning_state, ip_address, last_ip,
  local_bridge_id, last_seen_at, last_user_agent, created_at, updated_at`;

function hardphoneConfigStatus(user = {}) {
  return {
    phoneAdminPasswordConfigured: Boolean(process.env.TELNYX_PHONE_ADMIN_PASSWORD),
    outboundVoiceProfileConfigured: Boolean(process.env.TELNYX_OUTBOUND_VOICE_PROFILE),
    userTimezone: user.timezone || "UTC",
  };
}

export async function GET(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const includeAvailablePhoneNumbers = new URL(request.url).searchParams.get("includeAvailablePhoneNumbers") === "1";
    const [{ rows }, { rows: eventRows }, { rows: registrationRows }, availablePhoneNumbers] = await Promise.all([
      pool.query(`SELECT ${PHONE_COLUMNS} FROM hp_phones ORDER BY created_at DESC LIMIT 500`),
      pool.query(
        `SELECT phone_id, MAX(created_at) AS last_event_at, COUNT(*)::int AS events
         FROM hp_provisioning_events WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY phone_id`,
      ),
      pool.query(
        `SELECT DISTINCT ON (phone_id) phone_id, detail->>'registration_status' AS sip_registration_status, created_at AS registration_status_at
         FROM hp_provisioning_events
         WHERE event_type = 'registration_status_event'
         ORDER BY phone_id, created_at DESC`,
      ),
      includeAvailablePhoneNumbers ? listUnassignedPhoneNumbers().catch((err) => {
        adminRuntimeLogger.warn("hardphone_number_inventory_failed", runtimePayload({ error: err, operation: "hp_number_inventory" }));
        return [];
      }) : Promise.resolve([]),
    ]);
    const eventsByPhone = Object.fromEntries(eventRows.map((r) => [r.phone_id, r]));
    const registrationByPhone = Object.fromEntries(registrationRows.map((r) => [r.phone_id, r]));
    return NextResponse.json({
      phones: rows.map((p) => ({
        ...p,
        recent_events: eventsByPhone[p.id]?.events || 0,
        sip_registration_status: registrationByPhone[p.id]?.sip_registration_status || "unknown",
        sip_registration_status_at: registrationByPhone[p.id]?.registration_status_at || null,
      })),
      availablePhoneNumbers,
      config: hardphoneConfigStatus(user),
    });
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
  if (!process.env.TELNYX_PHONE_ADMIN_PASSWORD) {
    return NextResponse.json({ error: "TELNYX_PHONE_ADMIN_PASSWORD must be configured before adding hard phones" }, { status: 400 });
  }
  if (!process.env.TELNYX_OUTBOUND_VOICE_PROFILE) {
    return NextResponse.json({ error: "TELNYX_OUTBOUND_VOICE_PROFILE must be configured before adding hard phones" }, { status: 400 });
  }
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

    const phoneName = String(body?.phone_name || "").trim() || null;
    const label = String(body?.label || "").trim() || null;
    const model = String(body?.model || "").trim() || null;
    const assignedPhoneNumberId = String(body?.assigned_phone_number_id || "").trim() || null;
    const assignedPhoneNumber = String(body?.assigned_phone_number || "").trim() || null;
    if (assignedPhoneNumberId || assignedPhoneNumber) {
      const { rows: assignedRows } = await pool.query(
        `SELECT id FROM hp_phones
         WHERE ($1::text IS NOT NULL AND assigned_phone_number_id = $1)
            OR ($2::text IS NOT NULL AND assigned_phone_number = $2)
         LIMIT 1`,
        [assignedPhoneNumberId, assignedPhoneNumber],
      );
      if (assignedRows.length) return NextResponse.json({ error: "Selected phone number is already assigned to another hard phone" }, { status: 409 });
    }
    let connection = { id: null, connection_id: null, connection_name: null, sip_username: null, sip_password: null };
    let assignedNumber = null;
    try {
      connection = await createPhoneSipConnection({ label: phoneName || label, mac, vendor, model, assignedPhoneNumber });
      if (assignedPhoneNumberId) {
        assignedNumber = await assignPhoneNumberToConnection(assignedPhoneNumberId, connection.connection_id || connection.id);
      }
      const callerIdNumber = assignedNumber?.phone_number || assignedPhoneNumber || null;
      if (callerIdNumber) {
        await updatePhoneSipConnectionCallerId({ connectionId: connection.connection_id || connection.id, phoneNumber: callerIdNumber });
      }
    } catch (err) {
      adminRuntimeLogger.error("hardphone_credential_failed", runtimePayload({ error: err, operation: "hp_sip_connection_create" }));
      if (connection?.id) await deletePhoneSipConnection(connection.id);
      return NextResponse.json({ error: err.message }, { status: 502 });
    }

    let client = null;
    let commitStarted = false;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      const adminPassword = process.env.TELNYX_PHONE_ADMIN_PASSWORD;
      const numberValue = assignedNumber?.phone_number || assignedPhoneNumber || null;
      const numberId = assignedNumber?.id || assignedPhoneNumberId || null;
      const ipAddress = null;
      const { rows } = await client.query(
        `INSERT INTO hp_phones (phone_name, mac, vendor, model, label, agent_id, telnyx_credential_id, telnyx_connection_id, telnyx_connection_name,
          assigned_phone_number_id, assigned_phone_number, sip_username, sip_password, admin_password, settings, ip_address, local_bridge_id, provisioning_state, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'pending', $18)
         RETURNING ${PHONE_COLUMNS}`,
        [
          phoneName,
          mac,
          vendor,
          model,
          label,
          String(body?.agent_id || "").trim() || null,
          connection.id,
          connection.connection_id || connection.id,
          connection.connection_name,
          numberId,
          numberValue,
          connection.sip_username,
          connection.sip_password,
          adminPassword,
          JSON.stringify(body?.settings && typeof body.settings === "object" ? body.settings : {}),
          ipAddress,
          String(body?.local_bridge_id || body?.settings?.local_bridge_id || "").trim() || null,
          user.id || user.email || null,
        ],
      );
      await client.query(
        `INSERT INTO hp_provisioning_events (phone_id, mac, event_type, detail) VALUES ($1, $2, 'created', $3)`,
        [rows[0].id, mac, JSON.stringify({ vendor, credential_connection_id: connection.connection_id || connection.id, assigned_phone_number: numberValue })],
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
      if (connection.id && !commitStarted) {
        try {
          await deletePhoneSipConnection(connection.id);
        } catch (cleanupErr) {
          adminRuntimeLogger.error(
            "hardphone_credential_cleanup_failed",
            runtimePayload({ error: cleanupErr, operation: "hp_sip_connection_cleanup", connection_id: connection.id }),
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
