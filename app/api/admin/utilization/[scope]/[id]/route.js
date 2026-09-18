import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { readUtilization, saveUtilization } from "@/lib/acd/utilization.mjs";
import { withPermission } from "@/lib/authz/guard";
import { agentInScope, queueInScope } from "@/lib/authz/scope.mjs";

async function handle(request, context, write, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  try {
    const { scope, id } = await context.params;
    if (scope === "queue" && !queueInScope(authz.scope, id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (scope === "agent" && !agentInScope(authz.scope, id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (scope !== "queue" && scope !== "agent" && authz.scope?.restricted) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const result = write
      ? await saveUtilization(pool, { ...await request.json(), scope, id, actor: String(user.id) })
      : await readUtilization(pool, scope, id);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.status ? error.message : "Unable to update channel settings" }, { status: error.status || 500 });
  }
}
export const GET = withPermission("utilization:read", (request, context, authz) => handle(request, context, false, authz), { route: "/api/admin/utilization/[scope]/[id]" });
export const PUT = withPermission("utilization:update", (request, context, authz) => handle(request, context, true, authz), { route: "/api/admin/utilization/[scope]/[id]" });
