import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { withPermission, authzErrorResponse } from "@/lib/authz/guard";
import { listRoles, createRole, RoleStoreError } from "@/lib/authz/roles-store.mjs";
import { adminSecurityLogger, securityErrorPayload } from "@/lib/security-logging.mjs";

export const dynamic = "force-dynamic";

function fail(err, fallback) {
  if (err instanceof RoleStoreError || (err && typeof err.status === "number" && err.status < 500)) {
    return NextResponse.json({ error: err.message, details: err.details || undefined }, { status: err.status });
  }
  adminSecurityLogger.error("roles_request_failed", { ...securityErrorPayload(err) });
  return authzErrorResponse({ status: 500, message: fallback });
}

export const GET = withPermission(
  ["roles:read", "roles:manage", "users:read"],
  async () => {
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 503 });
    try {
      const roles = await listRoles(pool);
      return NextResponse.json({ roles }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (err) {
      return fail(err, "Failed to load roles");
    }
  },
  { route: "/api/admin/roles" },
);

export const POST = withPermission(
  "roles:manage",
  async (request, context, { user, access }) => {
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 503 });
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    try {
      const role = await createRole(pool, body, { actor: user, actorAccess: access });
      adminSecurityLogger.info("role_created", { actorId: String(user.id), roleKey: role.key });
      return NextResponse.json({ role }, { status: 201 });
    } catch (err) {
      return fail(err, "Failed to create role");
    }
  },
  { route: "/api/admin/roles" },
);
