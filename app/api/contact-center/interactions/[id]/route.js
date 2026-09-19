import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import {
  loadAcdInteractionSegments,
  loadAcdTimelineProjection,
} from "@/lib/acd/history-projection.mjs";
import {
  findInteractionViewByReference,
  loadAcdHistoryDto,
} from "@/lib/acd/work-item-repository.mjs";
import {
  contactCenterRuntimeLogger,
  runtimePayload,
} from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { workItemInScope } from "@/lib/authz/scope.mjs";

async function GET_handler(request, context, authz) {
  try {
    const user = authz.user;

    const { id } = (await context?.params) || {};
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "Interaction ID is required" },
        { status: 400 },
      );
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 503 },
      );
    }

    const row = await findInteractionViewByReference(pool, id);
    if (!row) {
      return NextResponse.json(
        { ok: false, error: "Interaction not found" },
        { status: 404 },
      );
    }
    if (!authz.elevated && !(user.id && row.agent_id === String(user.id)) && !(await pool.query("SELECT 1 FROM acd_segments WHERE work_item_id=$1 AND agent_id=$2 LIMIT 1",[row.work_item_id,String(user.id)])).rowCount) {
      return NextResponse.json(
        { ok: false, error: "Forbidden" },
        { status: 403 },
      );
    }
    // Elevated callers stay within the data scope of the roles that elevate them (Phase 3a).
    if (authz.elevated && !(user.id && row.agent_id === String(user.id)) && !(await workItemInScope(pool, authz.scope, row.work_item_id, { queueId: row.queue_id, agentId: row.agent_id, channel: row.interaction_type }))) {
      return NextResponse.json(
        { ok: false, error: "Forbidden" },
        { status: 403 },
      );
    }

    const [routingMetadata, acdSegments, history, contextResult] = await Promise.all([
      loadAcdTimelineProjection(pool, row.work_item_id, {
        routingMetadata: row.routing_metadata,
      }),
      loadAcdInteractionSegments(pool, row.work_item_id),
      loadAcdHistoryDto(pool, row.work_item_id),
      pool.query(`SELECT c.customer_name,t.subject,
        (SELECT to_jsonb(m) FROM acd_sla_status m WHERE m.work_item_id=w.id
          ORDER BY m.started_at DESC,m.id DESC LIMIT 1) AS sla
        FROM acd_work_items w LEFT JOIN acd_conversations c ON c.id=w.conversation_id
        LEFT JOIN cc_email_threads t ON t.conversation_id=c.id
        WHERE w.id=$1 LIMIT 1`, [row.work_item_id]),
    ]);
    const wrapupCodeIds = Array.isArray(row.wrapup_codes)
      ? row.wrapup_codes.filter(Boolean)
      : [];
    const wrapupCodeNames = wrapupCodeIds.length
      ? (
          await pool.query(
            `SELECT name
               FROM cc_wrapup_codes
              WHERE id = ANY($1::text[])
              ORDER BY display_order, name`,
            [wrapupCodeIds],
          )
        ).rows.map((code) => code.name)
      : [];

    return NextResponse.json({
      ok: true,
      interaction: {
        ...row,
        from_name: contextResult.rows[0]?.customer_name || row.from_name,
        subject: contextResult.rows[0]?.subject || null,
        sla: contextResult.rows[0]?.sla || null,
        routing_metadata: routingMetadata || row.routing_metadata,
        wrapup_code_names: wrapupCodeNames,
        acd_segments: acdSegments,
        history,
      },
    });
  } catch (error) {
    contactCenterRuntimeLogger.error("runtime_error", {
      ...runtimePayload({ error }),
    });
    return NextResponse.json(
      { ok: false, error: "Failed to fetch interaction" },
      { status: 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("interactions:read", GET_handler, { route: "/api/contact-center/interactions/[id]", elevated: "monitor:read" });
