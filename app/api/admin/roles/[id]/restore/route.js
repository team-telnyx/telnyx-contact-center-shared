import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { withPermission } from "@/lib/authz/guard";
import { restoreRole, RoleStoreError } from "@/lib/authz/roles-store.mjs";
import { adminSecurityLogger, securityErrorPayload } from "@/lib/security-logging.mjs";

export const dynamic = "force-dynamic";

/** Restore a shipped role to the permission set defined by the product. */
export const POST = withPermission(
  "roles:manage",
  async (request, context, { user, access }) => {
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 503 });
    const params = await context?.params;
    const key = String(params?.id || "").trim().toLowerCase();
    try {
      const role = await restoreRole(pool, key, { actor: user, actorAccess: access });
      adminSecurityLogger.info("role_restored", { actorId: String(user.id), roleKey: key });
      return NextResponse.json({ role });
    } catch (err) {
      if (err instanceof RoleStoreError) return NextResponse.json({ error: err.message, details: err.details || undefined }, { status: err.status });
      adminSecurityLogger.error("roles_request_failed", { ...securityErrorPayload(err) });
      return NextResponse.json({ error: "Failed to restore role" }, { status: 500 });
    }
  },
  { route: "/api/admin/roles/[id]/restore" },
);
