import { parseChannel } from "@/lib/acd/interaction-channels.mjs";
import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { readAcdOperations, executeAcdOperation } from "@/lib/acd/operations.mjs";
import { createTelnyxProvider } from "@/lib/acd/provider.mjs";
import { withPermission } from "@/lib/authz/guard";

async function handle(request, write, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  try {
    const result = write
      ? await executeAcdOperation(pool, {
          ...await request.json(),
          actorId: user.id,
          provider: createTelnyxProvider(),
        })
      : await readAcdOperations(pool,{channel:parseChannel(new URL(request.url).searchParams.get("channel"))});
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: error.status ? error.message : "ACD operation failed" }, { status: error.status || 500 });
  }
}
export const GET = withPermission("acd_operations:read", (request, context, authz) => handle(request, false, authz), { route: "/api/contact-center/acd/operations" });
export const POST = withPermission("acd_operations:manage", (request, context, authz) => handle(request, true, authz), { route: "/api/contact-center/acd/operations" });
