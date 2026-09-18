import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-server';
import { getPostgresPool } from '@/lib/postgres.mjs';
import { authorizeInteractionRead } from '@/lib/acd/conversation-preview.mjs';
import { readSupervisorDraftAttachment } from '@/lib/email/draft-attachments.mjs';
import { emailAttachmentResponse } from '@/lib/email/attachment-response.mjs';
import { withPermission } from "@/lib/authz/guard";
import { workItemInScope } from "@/lib/authz/scope.mjs";

async function GET_handler(request, context, authz) {
  const user = authz.user;
  try {
    const { id, agentId, index } = await context.params, pool = getPostgresPool();
    const supervisor = Boolean(authz.elevated) && (await workItemInScope(pool, authz.scope, id));
    const work = await authorizeInteractionRead(pool, id, user, { supervisor });
    const attachment = await readSupervisorDraftAttachment(pool, work, {
      agentId, index, draftId: new URL(request.url).searchParams.get('draftId')||'legacy', version: new URL(request.url).searchParams.get('version'),
    });
    return await emailAttachmentResponse(request, attachment);
  } catch (error) {
    return NextResponse.json({ error: error.status ? error.message : 'Attachment unavailable' }, { status: error.status || 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission(["agent:self", "interactions:read"], GET_handler, { elevated: ["monitor:read", "interactions_history:read", "quality:read", "quality_evaluations:read"], route: "/api/contact-center/interactions/[id]/conversation/email-drafts/[agentId]/attachments/[index]" });
