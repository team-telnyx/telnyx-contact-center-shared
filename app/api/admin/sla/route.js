import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import {
  loadGlobalSla,
  effectiveSlaPolicy,
  saveSlaPolicies,
} from "@/lib/acd/sla.mjs";
import { RELEASED_CHANNELS } from "@/lib/acd/channel-registry.mjs";
import { withPermission } from "@/lib/authz/guard";
export const dynamic = "force-dynamic";
async function GET_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  const queueId = new URL(request.url).searchParams.get("queueId");
  const global = await loadGlobalSla(pool),
    queue = queueId
      ? (
          await pool.query(
            "SELECT to_jsonb(q) AS config FROM cc_queues q WHERE id=$1",
            [queueId],
          )
        ).rows[0]?.config
      : null;
  if (queueId && !queue)
    return NextResponse.json({ error: "Queue not found" }, { status: 404 });
  return NextResponse.json(
    {
      global,
      revision: Number(queueId ? queue.sla_revision : global.revision),
      policies: queueId ? queue.sla_policies : global.policies,
      channels: RELEASED_CHANNELS,
      inherited: Object.fromEntries(
        RELEASED_CHANNELS.map((channel) => [
          channel,
          effectiveSlaPolicy(channel, global),
        ]),
      ),
      effective: Object.fromEntries(
        RELEASED_CHANNELS.map((channel) => [
          channel,
          effectiveSlaPolicy(channel, global, queue),
        ]),
      ),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
async function PUT_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  try {
    const body = await request.json();
    return NextResponse.json(
      await saveSlaPolicies(pool, {
        queueId: body.queueId || null,
        revision: body.revision,
        policies: body.policies,
        actor: String(user.id),
      }),
    );
  } catch (error) {
    return NextResponse.json(
      { error: error.status ? error.message : "Unable to save SLA settings" },
      { status: error.status || 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("system_settings:read", GET_handler, { route: "/api/admin/sla" });
export const PUT = withPermission("system_settings:update", PUT_handler, { route: "/api/admin/sla" });
