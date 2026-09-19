import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { withPermission } from "@/lib/authz/guard";
import { listAudit } from "@/lib/authz/roles-store.mjs";
import { adminSecurityLogger, securityErrorPayload } from "@/lib/security-logging.mjs";

export const dynamic = "force-dynamic";

export const GET = withPermission(
  ["roles:read", "roles:manage"],
  async (request, context) => {
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 503 });
    const params = await context?.params;
    const key = String(params?.id || "").trim().toLowerCase();
    const limit = Number(new URL(request.url).searchParams.get("limit") || 20);
    try {
      const entries = await listAudit(pool, { targetType: "role", targetId: key, limit });
      return NextResponse.json({ entries }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (err) {
      adminSecurityLogger.error("roles_request_failed", { ...securityErrorPayload(err) });
      return NextResponse.json({ error: "Failed to load audit" }, { status: 500 });
    }
  },
  { route: "/api/admin/roles/[id]/audit" },
);
