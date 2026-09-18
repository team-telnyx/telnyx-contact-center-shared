import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import {
  AcdIntentError,
  executeTransferIntent,
  getTransferIntent,
} from "@/lib/acd/transfer-intents.mjs";
import { recordHoldIntent } from "@/lib/acd/hold-intents.mjs";
import { loadAgentHoldSettings } from "@/lib/acd/consult-hold-settings.mjs";
import { createTelnyxProvider } from "@/lib/acd/provider.mjs";
import { withPermission } from "@/lib/authz/guard";

function failure(error) {
  const status = error instanceof AcdIntentError
    ? error.status
    : Number.isInteger(error?.status)
      ? error.status
      : 500;
  return NextResponse.json(
    {
      ok: false,
      error: error?.message || "Core ACD intent failed",
      code: error?.code || "ACD_INTENT_FAILED",
    },
    { status },
  );
}

async function GET_handler(_request, { params }, authz) {
  try {
    const user = authz.user;
    const { id } = await params;
    const intent = await getTransferIntent(getPostgresPool(), {
      interactionId: id,
      username: user.username,
    });
    return NextResponse.json({ ok: true, intent });
  } catch (error) {
    return failure(error);
  }
}

async function POST_handler(request, { params }, authz) {
  try {
    const user = authz.user;
    const { id } = await params;
    const body = await request.json();
    if (["hold", "unhold"].includes(body.action)) {
      const pool = getPostgresPool();
      const intent = await recordHoldIntent(pool, {
        interactionId: id,
        agentId: user.id,
        action: body.action,
        requestId: body.requestId,
        provider: createTelnyxProvider(),
        holdSettings: await loadAgentHoldSettings(pool),
      });
      return NextResponse.json({ ok: true, intent }, { status: 202 });
    }
    const intent = await executeTransferIntent(getPostgresPool(), {
      interactionId: id,
      username: user.username,
      action: body.action,
      target: body.target,
      targetKind: body.targetKind,
      targetUserId: body.targetUserId,
      targetUsername: body.targetUsername,
      targetLabel: body.targetLabel,
      preserveRoutingOptions: body.preserveRoutingOptions !== false,
    });
    return NextResponse.json({ ok: true, intent }, { status: 202 });
  } catch (error) {
    return failure(error);
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("interactions:read", GET_handler, { route: "/api/contact-center/interactions/[id]/intents" });
export const POST = withPermission(["agent:self", "interactions:annotate"], POST_handler, { route: "/api/contact-center/interactions/[id]/intents" });
