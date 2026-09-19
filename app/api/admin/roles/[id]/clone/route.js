import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { withPermission } from "@/lib/authz/guard";
import { cloneRole, RoleStoreError } from "@/lib/authz/roles-store.mjs";
import { adminSecurityLogger, securityErrorPayload } from "@/lib/security-logging.mjs";

export const dynamic = "force-dynamic";

export const POST = withPermission(
  "roles:manage",
  async (request, context, { user, access }) => {
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 503 });
    const params = await context?.params;
    const source = String(params?.id || "").trim().toLowerCase();
    let body = {};
    try {
      body = (await request.json()) || {};
    } catch (_) {
      body = {};
    }
    try {
      const role = await cloneRole(pool, source, body, { actor: user, actorAccess: access });
      adminSecurityLogger.info("role_cloned", { actorId: String(user.id), source, roleKey: role.key });
      return NextResponse.json({ role }, { status: 201 });
    } catch (err) {
      if (err instanceof RoleStoreError) return NextResponse.json({ error: err.message, details: err.details || undefined }, { status: err.status });
      adminSecurityLogger.error("roles_request_failed", { ...securityErrorPayload(err) });
      return NextResponse.json({ error: "Failed to clone role" }, { status: 500 });
    }
  },
  { route: "/api/admin/roles/[id]/clone" },
);
