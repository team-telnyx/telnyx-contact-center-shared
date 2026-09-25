import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { authorizePersistedInteractionControl } from "@/lib/voice/interaction-control-policy.mjs";
import { cancelUnstartedDirectIntent, reserveDirectVoice, reserveCoreTarget } from "@/lib/acd/direct-capacity.mjs";
import { withPermission } from "@/lib/authz/guard";

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

async function POST_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  try {
    const body = await request.json();
    const intent = body.sourceInteractionId
      ? await reserveCoreTarget(pool, { username: user.username, sourceInteractionId: body.sourceInteractionId, target: body.target, targetUserId: body.targetUserId, requestId: body.requestId })
      : await reserveDirectVoice(pool, { agentId: String(user.id), requestId: body.requestId, target: body.target });
    if (!intent) return NextResponse.json({ ok: true, customHeaders: [] });
    return NextResponse.json({
      ok: true,
      intentId: intent.id,
      workItemId: intent.work_item_id || null,
      customHeaders: [{ name: "X-CC-Direct-Intent-Id", value: intent.id }],
    });
  } catch (error) { return NextResponse.json({ error: error.status ? error.message : "Call preparation failed" }, { status: error.status || 500 }); }
}

async function DELETE_handler(request, _context, authz) {
  const user = authz.user;
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!UUID_PATTERN.test(String(id || ""))) {
      return NextResponse.json({ error: "Invalid direct call intent" }, { status: 400 });
    }
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    const intent = (await pool.query(
      `SELECT id, agent_id, work_item_id, purpose FROM acd_direct_intents WHERE id = $1`,
      [id],
    )).rows[0];
    if (!intent) return NextResponse.json({ ok: true, released: false });

    let cancellationScope;
    if (["blind_transfer_target", "consult_target"].includes(intent.purpose)) {
      const access = await authorizePersistedInteractionControl(
        pool,
        { id: intent.work_item_id, work_item_id: intent.work_item_id },
        user,
      );
      if (!access.ok) return NextResponse.json(access, { status: access.status });
      cancellationScope = { workItemId: intent.work_item_id };
    } else {
      if (String(intent.agent_id) !== String(user.id)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      cancellationScope = { agentId: String(user.id) };
    }

    const released = await cancelUnstartedDirectIntent(pool, {
      id,
      ...cancellationScope,
    });
    return NextResponse.json({ ok: true, released });
  } catch (error) {
    return NextResponse.json(
      { error: error.status ? error.message : "Call cancellation failed" },
      { status: error.status || 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("agent:self", POST_handler, { voiceControl: true, route: "/api/voice/direct-intent" });
export const DELETE = withPermission("agent:self", DELETE_handler, { voiceControl: true, route: "/api/voice/direct-intent" });
