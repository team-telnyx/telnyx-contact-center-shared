import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { authorizeInteractionRead } from "@/lib/acd/conversation-preview.mjs";
import { fetchEmailContent, emailError } from "@/lib/email/provider.mjs";
import { readEmailFile } from "@/lib/email/private-storage.mjs";
import { emailAttachmentResponse } from "@/lib/email/attachment-response.mjs";
import { withPermission } from "@/lib/authz/guard";
import { workItemInScope } from "@/lib/authz/scope.mjs";

async function GET_handler(request, context, authz) {
  const user = authz.user;
  try {
    const { id, messageId, index } = await context.params,
      pool = getPostgresPool();
    const supervisor = Boolean(authz.elevated) && (await workItemInScope(pool, authz.scope, id));
    const work = await authorizeInteractionRead(pool, id, user, { supervisor });
    const row = (
      await pool.query(
        `SELECT e.envelope,s.data FROM cc_email_messages e JOIN acd_messages m ON m.id=e.message_id
      LEFT JOIN acd_sagas s ON s.id=e.saga_id WHERE m.id=$1 AND m.work_item_id=$2`,
        [messageId, work.id],
      )
    ).rows[0];
    if (!/^\d+$/.test(index) || !row)
      throw emailError("Attachment not found", 404);
    const file = row.envelope.attachments?.[Number(index)];
    if (!file) throw emailError("Attachment not found", 404);
    const encoded = row.data?.payload?.attachments?.[Number(index)]?.content;
    const data = encoded
      ? Buffer.from(encoded, "base64")
      : file.storage_key
        ? await readEmailFile(file.storage_key)
        : await fetchEmailContent(file.url, 25_000_000);
    return await emailAttachmentResponse(request, { file, bytes: data, conversationId: work.conversation_id || work.id });
  } catch (error) {
    return NextResponse.json(
      { error: error.status ? error.message : "Attachment unavailable" },
      { status: error.status || 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission(["agent:self", "interactions:read"], GET_handler, { elevated: ["monitor:read", "interactions_history:read", "quality:read", "quality_evaluations:read"], route: "/api/contact-center/interactions/[id]/conversation/email-attachments/[messageId]/[index]" });
