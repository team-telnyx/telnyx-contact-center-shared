import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { listTeams, createTeam, TeamStoreError } from "@/lib/teams/store.mjs";

/**
 * GET /api/admin/teams?page=&pageSize=&q=&active=
 * Teams (`agent_groups`) with their member counts. Backs the Teams screen and
 * the teams anchor of the scope editor (Phase 3a).
 */
async function GET_handler(request, _context, authz) {
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  const { searchParams } = new URL(request.url);
  try {
    const result = await listTeams(pool, {
      teamIds: authz.scope?.restricted ? authz.scope.teamIds : null,
      page: searchParams.get("page"),
      pageSize: searchParams.get("pageSize"),
      q: searchParams.get("q"),
      active: searchParams.get("active"),
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    adminRuntimeLogger.error("teams_list_failed", { ...runtimePayload({ error: err }) });
    return NextResponse.json({ error: "Failed to load teams" }, { status: 500 });
  }
}

/** POST /api/admin/teams — { name, description?, isActive?, memberIds? } */
async function POST_handler(request, _context, authz) {
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const body = await request.json().catch(() => ({}));
    if (Array.isArray(body.memberIds) && body.memberIds.length && !authz.can("teams:members.assign")) {
      return NextResponse.json({ error: "Forbidden", permission: "teams:members.assign" }, { status: 403 });
    }
    const team = await createTeam(pool, { id: randomUUID(), ...body }, { actor: authz.user });
    return NextResponse.json({ ok: true, id: team.id, team }, { status: 201 });
  } catch (err) {
    if (err instanceof TeamStoreError) return NextResponse.json({ error: err.message }, { status: err.status });
    adminRuntimeLogger.error("team_create_failed", { ...runtimePayload({ error: err }) });
    return NextResponse.json({ error: "Failed to create team" }, { status: 500 });
  }
}

export const GET = withPermission("teams:read", GET_handler, { route: "/api/admin/teams" });
export const POST = withPermission("teams:create", POST_handler, { route: "/api/admin/teams" });
