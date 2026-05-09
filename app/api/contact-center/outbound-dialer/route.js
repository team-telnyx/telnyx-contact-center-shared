import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import {
  OUTBOUND_CAMPAIGN_MODES,
  OUTBOUND_CHANNELS,
  OUTBOUND_CONTACT_FIELD_TYPES,
  OUTBOUND_HANDLER_TYPES,
  OUTBOUND_STANDARD_CONTACT_COLUMNS,
} from "@/lib/outbound-dialer/schema";

async function requireSupervisor() {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) return null;
  let user = id ? await PgDb.findUserById(id) : null;
  if (!user && email) user = await PgDb.findUserByUsername(email);
  return user && isSupervisorOrAdmin(user) ? user : null;
}

function mapCampaign(row) {
  return row ? {
    ...row,
    pacing_config: row.pacing_config || {},
    concurrency_config: row.concurrency_config || {},
    dialing_windows: row.dialing_windows || [],
    retry_policy: row.retry_policy || {},
    amd_config: row.amd_config || {},
    form_variable_mapping: row.form_variable_mapping || [],
  } : null;
}

function mapContactList(row) {
  return row ? {
    ...row,
    standard_columns: row.standard_columns || {},
    custom_field_schema: row.custom_field_schema || [],
    custom_fields: row.custom_fields || {},
  } : null;
}

export async function GET() {
  const user = await requireSupervisor();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  try {
    const [campaignsResult, listsResult] = await Promise.all([
      pool.query(`SELECT * FROM outbound_campaigns WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 100`),
      pool.query(`SELECT * FROM outbound_contact_lists WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 100`),
    ]);

    return NextResponse.json({
      ok: true,
      schema: {
        channels: OUTBOUND_CHANNELS,
        campaignModes: OUTBOUND_CAMPAIGN_MODES,
        handlerTypes: OUTBOUND_HANDLER_TYPES,
        contactFieldTypes: OUTBOUND_CONTACT_FIELD_TYPES,
        standardContactColumns: OUTBOUND_STANDARD_CONTACT_COLUMNS,
      },
      campaigns: campaignsResult.rows.map(mapCampaign),
      contactLists: listsResult.rows.map(mapContactList),
    });
  } catch (err) {
    console.error("[Outbound Dialer] GET error:", err);
    return NextResponse.json({ error: "Failed to load outbound dialer data" }, { status: 500 });
  }
}
