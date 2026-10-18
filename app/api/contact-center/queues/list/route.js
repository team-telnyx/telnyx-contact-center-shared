import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { withPermission } from "@/lib/authz/guard";
import { readTransferQueues } from "@/lib/acd/transfer-directory.mjs";

async function handler(request, _context, authz) {
  try {
    const result = await readTransferQueues(getPostgresPool(), new URL(request.url).searchParams, authz.scope);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Unable to load transfer queues" }, { status: 500 });
  }
}
// The shared guard supports both browser cookies and authenticated mobile tokens.
export const GET = withPermission("agent:self", handler, { route: "/api/contact-center/queues/list" });
