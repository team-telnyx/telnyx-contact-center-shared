import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { authorizeInteractionRead } from "@/lib/acd/conversation-preview.mjs";
import { attachmentResponse } from "@/lib/widgets/attachments";
import { withPermission } from "@/lib/authz/guard";
import { workItemInScope } from "@/lib/authz/scope.mjs";
async function GET_handler(request, context, authz) {
  try {
    const user = authz.user,
      { id, attachmentId } = await context.params,
      pool = getPostgresPool();
    const supervisor = Boolean(authz.elevated) && (await workItemInScope(pool, authz.scope, id));
    const work = await authorizeInteractionRead(pool, id, user, { supervisor });
    const file = (
      await pool.query(
        `SELECT f.* FROM acd_text_attachments f JOIN acd_messages m ON m.id=f.message_id
      WHERE f.id::text=$1 AND m.work_item_id=$2`,
        [attachmentId, work.id],
      )
    ).rows[0];
    if (!file)
      return NextResponse.json(
        { error: "Attachment not found" },
        { status: 404 },
      );
    return attachmentResponse(request, file);
  } catch (error) {
    return NextResponse.json(
      { error: error.status ? error.message : "Attachment unavailable" },
      { status: error.status || 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission(["agent:self", "interactions:read"], GET_handler, { elevated: ["monitor:read", "interactions_history:read", "quality:read", "quality_evaluations:read"], route: "/api/contact-center/interactions/[id]/conversation/attachments/[attachmentId]" });
