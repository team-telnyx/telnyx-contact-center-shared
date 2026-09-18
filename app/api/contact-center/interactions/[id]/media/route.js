import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { createTelnyxProvider } from "@/lib/acd/provider.mjs";
import { requestMediaIntent } from "@/lib/acd/sagas/media.mjs";
import { withPermission } from "@/lib/authz/guard";

async function POST_handler(request, { params }, authz) {
  try {
    const user = authz.user;
    const { id } = await params;
    const body = await request.json();
    const intent = await requestMediaIntent(getPostgresPool(), {
      interactionId: id, agentId: user.id, requestId: body.requestId, action: body.action, text: body.text,
      provider: createTelnyxProvider(),
    });
    return NextResponse.json({ ok: true, intent }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: error.status || 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission(["agent:self", "interactions:annotate"], POST_handler, { route: "/api/contact-center/interactions/[id]/media" });
