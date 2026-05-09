import { NextResponse } from "next/server";
import { getOutboundPool, mapCampaign, mapContactList, mapForm, outboundSchemaPayload, requireOutboundSupervisor } from "@/lib/outbound-dialer/api";

export async function GET() {
  const user = await requireOutboundSupervisor();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const pool = getOutboundPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  try {
    const [campaignsResult, listsResult, formsResult] = await Promise.all([
      pool.query(`SELECT c.*, l.name AS contact_list_name, f.name AS attached_form_name FROM outbound_campaigns c LEFT JOIN outbound_contact_lists l ON l.id = c.contact_list_id LEFT JOIN form_definitions f ON f.id = c.attached_form_id WHERE c.status <> 'archived' ORDER BY c.updated_at DESC LIMIT 100`),
      pool.query(`SELECT * FROM outbound_contact_lists WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 100`),
      pool.query(`SELECT id, name, status, category, schema FROM form_definitions WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 200`),
    ]);

    return NextResponse.json({
      ok: true,
      schema: outboundSchemaPayload,
      campaigns: campaignsResult.rows.map(mapCampaign),
      contactLists: listsResult.rows.map(mapContactList),
      forms: formsResult.rows.map(mapForm),
    });
  } catch (err) {
    console.error("[Outbound Dialer] GET error:", err);
    return NextResponse.json({ error: "Failed to load outbound dialer data" }, { status: 500 });
  }
}
