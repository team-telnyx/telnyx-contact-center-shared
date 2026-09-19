import { NextResponse } from "next/server";

import { saveAcdDisposition } from "@/lib/acd/wrapup.mjs";
import { findPendingAcdWrapupSegment } from "@/lib/acd/wrapup-context.mjs";
import { findInteractionViewByReference } from "@/lib/acd/work-item-repository.mjs";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { contactCenterRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";

async function loadCodes(pool, queueId) {
  const [assigned, fallback] = await Promise.all([
    queueId
      ? pool.query(
          `SELECT w.id, w.name, w.is_default, w.description, w.icon, w.color
             FROM cc_queue_wrapup_codes qwc
             JOIN cc_wrapup_codes w ON w.id = qwc.wrapup_code_id
            WHERE qwc.queue_id = $1 AND w.is_active = true
            ORDER BY w.display_order, w.name`,
          [queueId],
        )
      : Promise.resolve({ rows: [] }),
    pool.query(
      `SELECT id, name, is_default, description, icon, color
         FROM cc_wrapup_codes
        WHERE is_active = true AND is_default = true
        ORDER BY display_order, name
        LIMIT 1`,
    ),
  ]);
  const defaultCode = fallback.rows[0] || null;
  const codes = [...assigned.rows];
  if (codes.length === 0 && defaultCode) codes.push(defaultCode);
  return { codes, defaultCode };
}

async function contextForRequest(id, userId, segmentId = null) {
  const pool = getPostgresPool();
  if (!pool) return { error: "Database unavailable", status: 503 };
  const interaction = await findInteractionViewByReference(pool, id);
  if (!interaction) return { error: "Interaction not found", status: 404 };
  const segment = await findPendingAcdWrapupSegment(pool, {
    workItemId: interaction.id,
    agentId: userId,
    segmentId,
  });
  if (!segment) {
    return { error: "No pending wrap-up belongs to this agent", status: 403 };
  }
  return { pool, interaction, segment };
}

async function GET_handler(request, { params }, authz) {
  try {
    const { id } = await params;
    const user = authz.user;
    if (!id) return NextResponse.json({ ok: false, error: "Interaction ID is required" }, { status: 400 });

    const context = await contextForRequest(id, user.id, new URL(request.url).searchParams.get('segmentId'));
    if (context.error) {
      return NextResponse.json({ ok: false, error: context.error }, { status: context.status });
    }
    const { codes, defaultCode } = await loadCodes(context.pool, context.segment.queue_id);
    return NextResponse.json({
      ok: true,
      segmentId: context.segment.id,
      queueId: context.segment.queue_id || null,
      queueName: context.segment.queue_name || null,
      codes,
      defaultCodeId: defaultCode?.id || null,
      selectedCodes: context.segment.wrapup_code_id ? [context.segment.wrapup_code_id] : [],
      wrapupPending: true,
      acdOwned: true,
      wrapupDeadlineAt: context.segment.wrapup_deadline_at || null,
    });
  } catch (error) {
    contactCenterRuntimeLogger.error("runtime_error", runtimePayload({ error }));
    return NextResponse.json({ ok: false, error: "Failed to load wrapup codes" }, { status: 500 });
  }
}

async function POST_handler(request, { params }, authz) {
  try {
    const { id } = await params;
    const user = authz.user;
    if (!id) return NextResponse.json({ ok: false, error: "Interaction ID is required" }, { status: 400 });

    const body = await request.json();
    const context = await contextForRequest(id, user.id, body.segmentId);
    if (context.error) {
      return NextResponse.json({ ok: false, error: context.error }, { status: context.status });
    }
    const requested = Array.isArray(body.wrapupCodes) ? body.wrapupCodes : [];
    const { codes, defaultCode } = await loadCodes(context.pool, context.segment.queue_id);
    const allowed = new Set(codes.map((code) => String(code.id)));
    const selected = requested.find((codeId) => allowed.has(String(codeId))) || defaultCode?.id || null;

    const tx = await context.pool.connect();
    try {
      await tx.query("BEGIN");
      await saveAcdDisposition(tx, {
        segmentId: context.segment.id,
        agentId: String(user.id),
        codeId: selected,
        actor: `agent:${user.id}`,
      });
      await tx.query("COMMIT");
    } catch (error) {
      await tx.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      tx.release();
    }
    return NextResponse.json({ ok: true, wrapupCodes: selected ? [selected] : [] });
  } catch (error) {
    contactCenterRuntimeLogger.error("runtime_error", runtimePayload({ error }));
    return NextResponse.json({ ok: false, error: "Failed to save wrapup codes" }, { status: error.status || 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("interactions:read", GET_handler, { route: "/api/contact-center/interactions/[id]/wrapup-codes" });
export const POST = withPermission(["agent:self", "interactions:annotate"], POST_handler, { route: "/api/contact-center/interactions/[id]/wrapup-codes" });
