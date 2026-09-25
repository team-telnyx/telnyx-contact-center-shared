import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { requestAgentControl } from "@/lib/cobrowse/lifecycle.mjs";

async function post(request, context, authz) {
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  const { workItemId } = await context.params;
  try {
    return NextResponse.json({ session: await requestAgentControl(pool, {
      workItemId, agentId: authz.user.id, scope: authz.scope,
    }) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.status ? error.message : "Request failed" },
      { status: error.status || 500, headers: { "Cache-Control": "no-store" } });
  }
}

export const POST = withPermission("cobrowse:control", post, { route: "/api/contact-center/cobrowse/[workItemId]/control" });
