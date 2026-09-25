import { withWrapupDevice, takeOverWrapup } from "@/lib/acd/media-device-control.mjs";
import { NextResponse } from "next/server";

import { completeAcdWrapup } from "@/lib/acd/wrapup.mjs";
import { findPendingAcdWrapupSegment } from "@/lib/acd/wrapup-context.mjs";
import { findInteractionViewByReference } from "@/lib/acd/work-item-repository.mjs";
import { getPostgresPool } from "@/lib/postgres.mjs";
import {
  contactCenterErrorPayload,
  wrapupLogger,
} from "@/lib/contact-center/logging.mjs";
import { withPermission } from "@/lib/authz/guard";

async function POST_handler(request, { params }, authz) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ ok: false, error: "Interaction ID is required" }, { status: 400 });
    }
    const user = authz.user;
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json({ ok: false, error: "Database unavailable" }, { status: 503 });
    }
    const interaction = await findInteractionViewByReference(pool, id);
    if (!interaction) {
      return NextResponse.json({ ok: false, error: "Interaction not found" }, { status: 404 });
    }
    const { action, nextStatus = null, segmentId = null, expectedVersion, ownerVersion } = await request.json();
    const segment = await findPendingAcdWrapupSegment(pool, {
      workItemId: interaction.id,
      agentId: user.id,
      segmentId,
    });
    if (!segment) {
      return NextResponse.json(
        { ok: false, error: "No pending wrap-up belongs to this agent" },
        { status: 403 },
      );
    }

    if (action === 'takeover') return NextResponse.json(await takeOverWrapup(pool,user,request,
      {workItemId:interaction.id,segmentId:segment.id,expectedVersion}));
    if (!['start', 'end'].includes(action)) {
      return NextResponse.json({ ok: false, error: "Invalid wrapup action" }, { status: 400 });
    }
    if (nextStatus !== null && nextStatus !== "Break") {
      return NextResponse.json({ ok: false, error: "Invalid next status" }, { status: 400 });
    }
    if (action === "start") {
      return NextResponse.json({
        ok: true,
        startedAt: segment.ended_at,
        deadlineAt: segment.wrapup_deadline_at || null,
      });
    }

    const result = await withWrapupDevice(pool,user,request,{workItemId:interaction.id,segmentId:segment.id,ownerVersion},()=>completeAcdWrapup(pool, {
      workItemId: interaction.id,
      expectedAgentId: user.id,
      segmentId: segment.id,
      nextManualStatus: nextStatus,
      actor: `agent:${user.id}`,
    }));
    if (!result.completed) {
      const status = result.reason === "work_item_not_found" ? 404 : 409;
      return NextResponse.json({ ok: false, error: result.reason }, { status });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    wrapupLogger.error("wrapup_failed", contactCenterErrorPayload(error));
    return NextResponse.json(
      { ok: false, error: error.status ? error.message : "Failed to update wrapup status" },
      { status: error.status || 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission(["agent:self", "interactions:annotate"], POST_handler, { route: "/api/contact-center/interactions/[id]/wrapup" });
