import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { withPermission, authzErrorResponse } from "@/lib/authz/guard";
import { getRole, updateRole, deleteRole, RoleStoreError } from "@/lib/authz/roles-store.mjs";
import { adminSecurityLogger, securityErrorPayload } from "@/lib/security-logging.mjs";

export const dynamic = "force-dynamic";

function fail(err, fallback) {
  if (err instanceof RoleStoreError || (err && typeof err.status === "number" && err.status < 500)) {
    return NextResponse.json({ error: err.message, details: err.details || undefined }, { status: err.status });
  }
  adminSecurityLogger.error("roles_request_failed", { ...securityErrorPayload(err) });
  return authzErrorResponse({ status: 500, message: fallback });
}

async function roleKey(context) {
  const params = await context?.params;
  return String(params?.id || "").trim().toLowerCase();
}

export const GET = withPermission(
  ["roles:read", "roles:manage", "users:read"],
  async (request, context) => {
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 503 });
    try {
      const role = await getRole(pool, await roleKey(context));
      if (!role) return NextResponse.json({ error: "Role not found" }, { status: 404 });
      return NextResponse.json({ role }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (err) {
      return fail(err, "Failed to load role");
    }
  },
  { route: "/api/admin/roles/[id]" },
);

export const PUT = withPermission(
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
      const role = await updateRole(pool, await roleKey(context), body, { actor: user, actorAccess: access });
      adminSecurityLogger.info("role_updated", { actorId: String(user.id), roleKey: role.key });
      return NextResponse.json({ role });
    } catch (err) {
      return fail(err, "Failed to update role");
    }
  },
  { route: "/api/admin/roles/[id]" },
);

export const DELETE = withPermission(
  "roles:manage",
  async (request, context, { user }) => {
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 503 });
    const removeFromUsers = new URL(request.url).searchParams.get("removeFromUsers") === "true";
    try {
      const key = await roleKey(context);
      const result = await deleteRole(pool, key, { actor: user, removeFromUsers });
      adminSecurityLogger.info("role_deleted", { actorId: String(user.id), roleKey: key, removedFromUsers: result.removedFromUsers });
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      return fail(err, "Failed to delete role");
    }
  },
  { route: "/api/admin/roles/[id]" },
);
