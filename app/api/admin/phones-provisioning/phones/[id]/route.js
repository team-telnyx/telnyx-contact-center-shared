import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { SUPPORTED_VENDORS } from "@/lib/hardphones/config-generators.mjs";
import { deleteLegacyPhoneCredential, deletePhoneSipConnection, assignPhoneNumberToConnection, unassignPhoneNumberFromConnection, updatePhoneSipConnectionCallerId } from "@/lib/hardphones/credentials.mjs";
import { syncHardphonePhoneNumbersFromTelnyx } from "@/lib/hardphones/number-sync.mjs";
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
  assigned_phone_number_id, assigned_phone_number, sip_username,
  admin_password, settings, provisioning_state, ip_address, last_ip, local_bridge_id, last_seen_at, last_user_agent, created_at, updated_at`;

export async function GET(_request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const { id } = await params;
    const { rows } = await pool.query(`SELECT ${PHONE_COLUMNS} FROM hp_phones WHERE id = $1`, [id]);
    if (!rows.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
    let phone = rows[0];
    [phone] = await syncHardphonePhoneNumbersFromTelnyx(pool, [phone]).catch(() => [phone]);
    const { rows: events } = await pool.query(
      `SELECT id, event_type, detail, created_at FROM hp_provisioning_events WHERE phone_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [id],
    );
    return NextResponse.json({ phone, events });
  } catch {
    return NextResponse.json({ error: "Failed to load phone" }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const { id } = await params;
    const body = await request.json();
    const { rows: existingRows } = await pool.query(`SELECT ${PHONE_COLUMNS} FROM hp_phones WHERE id = $1`, [id]);
    if (!existingRows.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const existingPhone = existingRows[0];
    const columns = [];
    const values = [];
    let idx = 1;
    if (body.vendor !== undefined) {
      const vendor = String(body.vendor || "").toLowerCase();
      if (!SUPPORTED_VENDORS.includes(vendor)) return NextResponse.json({ error: "Unsupported vendor" }, { status: 400 });
      columns.push(`vendor = $${idx++}`); values.push(vendor);
    }
    if (body.phone_name !== undefined) { columns.push(`phone_name = $${idx++}`); values.push(String(body.phone_name || "").trim() || null); }
    if (body.model !== undefined) { columns.push(`model = $${idx++}`); values.push(String(body.model || "").trim() || null); }
    if (body.label !== undefined) { columns.push(`label = $${idx++}`); values.push(String(body.label || "").trim() || null); }
    if (body.agent_id !== undefined) { columns.push(`agent_id = $${idx++}`); values.push(String(body.agent_id || "").trim() || null); }
    if (body.ip_address !== undefined) { columns.push(`ip_address = $${idx++}`); values.push(String(body.ip_address || "").trim() || null); }
    if (body.local_bridge_id !== undefined) { columns.push(`local_bridge_id = $${idx++}`); values.push(String(body.local_bridge_id || "").trim() || null); }
    if (body.settings !== undefined) { columns.push(`settings = $${idx++}`); values.push(JSON.stringify(body.settings && typeof body.settings === "object" ? body.settings : {})); }
    if (body.assigned_phone_number_id !== undefined || body.assigned_phone_number !== undefined) {
      const nextNumberId = String(body.assigned_phone_number_id || "").trim() || null;
      const nextNumberValue = String(body.assigned_phone_number || "").trim() || null;
      const currentNumberId = existingPhone.assigned_phone_number_id || null;
      const connectionId = existingPhone.telnyx_connection_id || existingPhone.telnyx_credential_id || null;
      if (nextNumberId) {
        if (!connectionId) return NextResponse.json({ error: "Phone has no Telnyx SIP connection" }, { status: 400 });
        const { rows: assignedRows } = await pool.query(
          `SELECT id FROM hp_phones
           WHERE id <> $3 AND (($1::text IS NOT NULL AND assigned_phone_number_id = $1) OR ($2::text IS NOT NULL AND assigned_phone_number = $2))
           LIMIT 1`,
          [nextNumberId, nextNumberValue, id],
        );
        if (assignedRows.length) return NextResponse.json({ error: "Selected phone number is already assigned to another hard phone" }, { status: 409 });
        if (currentNumberId && currentNumberId !== nextNumberId) await unassignPhoneNumberFromConnection(currentNumberId);
        const assignedNumber = await assignPhoneNumberToConnection(nextNumberId, connectionId);
        const numberValue = assignedNumber?.phone_number || nextNumberValue || null;
        if (numberValue) await updatePhoneSipConnectionCallerId({ connectionId, phoneNumber: numberValue });
        columns.push(`assigned_phone_number_id = $${idx++}`); values.push(assignedNumber?.id || nextNumberId);
        columns.push(`assigned_phone_number = $${idx++}`); values.push(numberValue);
      } else {
        if (currentNumberId) await unassignPhoneNumberFromConnection(currentNumberId);
        columns.push(`assigned_phone_number_id = $${idx++}`); values.push(null);
        columns.push(`assigned_phone_number = $${idx++}`); values.push(null);
      }
    }
    if (body.provisioning_state !== undefined) {
      const state = String(body.provisioning_state || "");
      if (!["pending", "provisioned", "disabled"].includes(state)) return NextResponse.json({ error: "Invalid provisioning_state" }, { status: 400 });
      columns.push(`provisioning_state = $${idx++}`); values.push(state);
    }
    if (!columns.length) return NextResponse.json({ error: "No changes" }, { status: 400 });
    values.push(id);
    await pool.query(`UPDATE hp_phones SET ${columns.join(", ")} WHERE id = $${idx}`, values);
    const { rows } = await pool.query(`SELECT ${PHONE_COLUMNS} FROM hp_phones WHERE id = $1`, [id]);
    if (!rows.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ phone: rows[0] });
  } catch (err) {
    adminRuntimeLogger.error("hardphone_update_failed", runtimePayload({ error: err, operation: "hp_update" }));
    return NextResponse.json({ error: "Failed to update phone" }, { status: 500 });
  }
}

export async function DELETE(_request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const { id } = await params;
    const { rows } = await pool.query(`SELECT telnyx_connection_id, telnyx_credential_id, mac FROM hp_phones WHERE id = $1`, [id]);
    if (!rows.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const credentialDeleted = rows[0].telnyx_connection_id
      ? await deletePhoneSipConnection(rows[0].telnyx_connection_id)
      : await deleteLegacyPhoneCredential(rows[0].telnyx_credential_id);
    await pool.query(`DELETE FROM hp_provisioning_events WHERE phone_id = $1`, [id]);
    await pool.query(`DELETE FROM hp_phones WHERE id = $1`, [id]);
    return NextResponse.json({ ok: true, credentialDeleted });
  } catch (err) {
    adminRuntimeLogger.error("hardphone_delete_failed", runtimePayload({ error: err, operation: "hp_delete" }));
    return NextResponse.json({ error: "Failed to delete phone" }, { status: 500 });
  }
}
