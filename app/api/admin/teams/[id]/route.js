import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { teamInScope, resolveScope } from "@/lib/authz/scope.mjs";
import { getTeam, updateTeam, deleteTeam, TeamStoreError } from "@/lib/teams/store.mjs";

async function resolveId(params) {
  const resolved = await params;
  return resolved?.id || null;
}

/** GET /api/admin/teams/[id] — the team with its members. */
async function GET_handler(request, { params }, authz) {
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  const id = await resolveId(params);
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  if (!teamInScope(authz.scope, id)) return NextResponse.json({ error: "Team not found" }, { status: 404 });
  try {
    const team = await getTeam(pool, id);
    if (!team) return NextResponse.json({ error: "Team not found" }, { status: 404 });
    return NextResponse.json({ team }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    adminRuntimeLogger.error("team_load_failed", { ...runtimePayload({ error: err }) });
    return NextResponse.json({ error: "Failed to load team" }, { status: 500 });
  }
}

/** PUT /api/admin/teams/[id] — { name?, description?, isActive?, memberIds? } */
async function PUT_handler(request, { params }, authz) {
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  const id = await resolveId(params);
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  if (!teamInScope(authz.scope, id)) return NextResponse.json({ error: "Team not found" }, { status: 404 });
  try {
    const body = await request.json().catch(() => ({}));
    // The guard admits either grant; each part of the body needs its own one.
    if (body.memberIds !== undefined && (!authz.can("teams:members.assign") || !teamInScope(await resolveScope(getPostgresPool(), authz.user, authz.access, "teams:members.assign"), id))) {
      return NextResponse.json({ error: "Forbidden", permission: "teams:members.assign" }, { status: 403 });
    }
    if (["name", "description", "isActive"].some((field) => body[field] !== undefined) && (!authz.can("teams:update") || !teamInScope(await resolveScope(getPostgresPool(), authz.user, authz.access, "teams:update"), id))) {
      return NextResponse.json({ error: "Forbidden", permission: "teams:update" }, { status: 403 });
    }
    const team = await updateTeam(pool, id, body, { actor: authz.user });
    return NextResponse.json({ ok: true, team });
  } catch (err) {
    if (err instanceof TeamStoreError) return NextResponse.json({ error: err.message }, { status: err.status });
    adminRuntimeLogger.error("team_update_failed", { ...runtimePayload({ error: err }) });
    return NextResponse.json({ error: "Failed to update team" }, { status: 500 });
  }
}

/** DELETE /api/admin/teams/[id] — removes the team, its memberships and its role-scope references. */
async function DELETE_handler(request, { params }, authz) {
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  const id = await resolveId(params);
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  if (!teamInScope(authz.scope, id)) return NextResponse.json({ error: "Team not found" }, { status: 404 });
  try {
    const result = await deleteTeam(pool, id, { actor: authz.user });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof TeamStoreError) return NextResponse.json({ error: err.message }, { status: err.status });
    adminRuntimeLogger.error("team_delete_failed", { ...runtimePayload({ error: err }) });
    return NextResponse.json({ error: "Failed to delete team" }, { status: 500 });
  }
}

export const GET = withPermission("teams:read", GET_handler, { route: "/api/admin/teams/[id]" });
export const PUT = withPermission(["teams:update", "teams:members.assign"], PUT_handler, { route: "/api/admin/teams/[id]" });
export const DELETE = withPermission("teams:delete", DELETE_handler, { route: "/api/admin/teams/[id]" });
