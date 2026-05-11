import { NextResponse } from "next/server";
import { getOutboundPool, loadOutboundContactLists, mapCampaign, mapContactList, mapDncList, mapForm, mapHandlerReference, mapOutboundFilter, mapOutboundTimeSet, outboundSchemaPayload, requireOutboundSupervisor } from "@/lib/outbound-dialer/api";
import { buildTelnyxV2Url } from "@/lib/telnyx";

async function safeQuery(pool, sql, params = [], fallback = []) {
  try {
    const { rows } = await pool.query(sql, params);
    return rows || fallback;
  } catch (err) {
    console.warn("[Outbound Dialer] optional query failed:", err?.message || err);
    return fallback;
  }
}

async function loadAiAssistants() {
  if (!process.env.TELNYX_API_KEY) return [];
  try {
    const res = await fetch(buildTelnyxV2Url("/ai/assistants"), {
      headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.data) ? data.data.slice(0, 200).map((assistant) => mapHandlerReference({ id: assistant.id, name: assistant.name, status: assistant.status }, "ai_assistant")) : [];
  } catch (err) {
    console.warn("[Outbound Dialer] assistants load failed:", err?.message || err);
    return [];
  }
}

export async function GET() {
  const user = await requireOutboundSupervisor();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const pool = getOutboundPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  try {
    const [campaignsResult, listsResult, dncListsResult, formsResult, filtersRows, timeSetsRows, queueRows, flowRows, assistants] = await Promise.all([
      pool.query(`SELECT c.*, l.name AS contact_list_name, f.name AS attached_form_name FROM outbound_campaigns c LEFT JOIN outbound_contact_lists l ON l.id = c.contact_list_id LEFT JOIN form_definitions f ON f.id = c.attached_form_id WHERE c.status <> 'archived' ORDER BY c.updated_at DESC LIMIT 100`),
      loadOutboundContactLists(pool, 100),
      pool.query(`SELECT * FROM outbound_dnc_lists WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 100`),
      pool.query(`SELECT id, name, status, category, schema FROM form_definitions WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 200`),
      safeQuery(pool, `SELECT f.*, l.name AS contact_list_name FROM outbound_contact_filters f LEFT JOIN outbound_contact_lists l ON l.id = f.contact_list_id WHERE f.status <> 'archived' ORDER BY f.updated_at DESC LIMIT 100`),
      safeQuery(pool, `SELECT * FROM outbound_time_sets WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 100`),
      safeQuery(pool, `SELECT id, name, display_name, enabled, active FROM cc_queues WHERE enabled = true AND active = true ORDER BY priority DESC, name ASC LIMIT 200`),
      safeQuery(pool, `SELECT id, name, status FROM voice_flows ORDER BY updated_at DESC LIMIT 200`),
      loadAiAssistants(),
    ]);

    return NextResponse.json({
      ok: true,
      schema: outboundSchemaPayload,
      campaigns: campaignsResult.rows.map(mapCampaign),
      contactLists: listsResult.rows.map(mapContactList),
      dncLists: dncListsResult.rows.map(mapDncList),
      forms: formsResult.rows.map(mapForm),
      filters: filtersRows.map(mapOutboundFilter),
      timeSets: timeSetsRows.map(mapOutboundTimeSet),
      handlerReferences: {
        queue: queueRows.map((row) => mapHandlerReference(row, "queue")),
        call_flow: flowRows.map((row) => mapHandlerReference(row, "call_flow")),
        ai_assistant: assistants,
      },
    });
  } catch (err) {
    console.error("[Outbound Dialer] GET error:", err);
    return NextResponse.json({ error: "Failed to load outbound dialer data" }, { status: 500 });
  }
}
