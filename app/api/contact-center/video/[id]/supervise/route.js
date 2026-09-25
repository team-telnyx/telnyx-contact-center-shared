import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { AuthzError, authzErrorResponse, requirePermission, withPermission } from "@/lib/authz/guard";
import { workItemInScope } from "@/lib/authz/scope.mjs";
import { endVideoSupervision, readVideoSession, refreshJoinToken, setVideoSupervisionMode, startVideoSupervision } from "@/lib/video/lifecycle.mjs";

// Supervisor side of a web video call: join the room as a third participant
// (monitor / whisper / barge), switch the mode, refresh the token, leave.
// Each mode is its own operation, as for voice calls.
const SUPERVISION_PERMISSION = { monitor: "calls:supervise.listen", whisper: "calls:supervise.whisper", barge: "calls:supervise.barge" };
const ROUTE = "/api/contact-center/video/[id]/supervise";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function inScope(pool, authz, workItemId) {
  if (!authz.scope?.restricted) return true;
  const work = (await pool.query(`SELECT w.queue_id, a.agent_id FROM acd_work_items w
    LEFT JOIN acd_text_assignments a ON a.work_item_id=w.id AND a.state='active' WHERE w.id=$1 AND w.channel='video' LIMIT 1`, [workItemId])).rows[0];
  return Boolean(work) && workItemInScope(pool, authz.scope, workItemId, { queueId: work.queue_id, agentId: work.agent_id, channel: "video" });
}

async function POST_handler(request, context, authz) {
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  try {
    const { id } = await context.params;
    if (!UUID.test(id || "")) return NextResponse.json({ error: "Invalid video call id" }, { status: 400 });
    const body = await request.json().catch(() => ({}));
    const supervisorId = String(authz.user.id);
    const action = body.action || "start";
    if (action === "start" || action === "mode") {
      const permission = SUPERVISION_PERMISSION[body.mode];
      if (!permission) return NextResponse.json({ error: "Invalid supervision mode. Must be one of: monitor, whisper, barge" }, { status: 400 });
      // The wrapper accepts any supervision permission and merges their data
      // scopes; the requested mode is checked against its own permission and
      // that permission's scope (listen everywhere does not grant barge everywhere).
      let modeAuthz;
      try { modeAuthz = await requirePermission(permission, { request, route: ROUTE }); }
      catch (error) { if (error instanceof AuthzError) return authzErrorResponse(error); throw error; }
      if (!(await inScope(pool, modeAuthz, id))) return NextResponse.json({ error: "Video call is outside your data scope" }, { status: 403 });
      if (action === "mode") return NextResponse.json({ ok: true, supervision: await setVideoSupervisionMode(pool, { workItemId: id, supervisorId, supervisionId: typeof body.supervisionId === "string" ? body.supervisionId : null, mode: body.mode }) });
      const name = [authz.user.first_name, authz.user.last_name].filter(Boolean).join(" ") || authz.user.username || "Supervisor";
      return NextResponse.json({ ok: true, join: await startVideoSupervision(pool, { workItemId: id, supervisorId, name, mode: body.mode }) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (action === "refresh") {
      // A refreshed token is re-authorised for the stored mode: a permission
      // or scope withdrawn mid-call ends the session at the next refresh.
      const mode = (await readVideoSession(pool, id))?.supervision?.mode;
      const permission = SUPERVISION_PERMISSION[mode];
      if (!permission) return NextResponse.json({ error: "You are not supervising this video call" }, { status: 409 });
      let modeAuthz;
      try { modeAuthz = await requirePermission(permission, { request, route: ROUTE }); }
      catch (error) { if (error instanceof AuthzError) return authzErrorResponse(error); throw error; }
      if (!(await inScope(pool, modeAuthz, id))) return NextResponse.json({ error: "Video call is outside your data scope" }, { status: 403 });
      return NextResponse.json({ ok: true, join: await refreshJoinToken(pool, { workItemId: id, refreshToken: body.refreshToken, supervisorId }) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (action === "end") return NextResponse.json({ ok: true, supervision: await endVideoSupervision(pool, { workItemId: id, supervisorId, supervisionId: typeof body.supervisionId === "string" ? body.supervisionId : null, reason: "supervisor_left" }) });
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error.status ? error.message : "Video supervision failed" }, { status: error.status || 500 });
  }
}

export const POST = withPermission(Object.values(SUPERVISION_PERMISSION), POST_handler, { route: "/api/contact-center/video/[id]/supervise" });

async function GET_handler(request, context, authz) {
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({error: "Database unavailable"}, {status: 503});
  try {
    const {id} = await context.params;
    if (!UUID.test(id || "")) return NextResponse.json({error: "Invalid video call id"}, {status: 400});
    if (!(await inScope(pool, authz, id))) return NextResponse.json({error: "Video call is outside your data scope"}, {status: 403});
    const work = (await pool.query("SELECT id,state,terminal_at,version FROM acd_work_items WHERE id=$1 AND channel='video'", [id])).rows[0];
    if (!work) return NextResponse.json({error: "Video call not found"}, {status: 404});
    const session = await readVideoSession(pool, id);
    // Recheck the active mode on every mobile verification, not just token refresh.
    if (session?.supervision?.supervisorId === String(authz.user.id)) {
      const permission = SUPERVISION_PERMISSION[session.supervision.mode];
      if (permission) {
        const modeAuthz = await requirePermission(permission, {request, route: ROUTE});
        if (!(await inScope(pool, modeAuthz, id))) return NextResponse.json({error: "Video call is outside your data scope"}, {status:403});
      }
    }
    return NextResponse.json({work, video: session ? {state:session.state, recordingEnabled:session.recording_enabled,
      supervision:session.supervision ? {mode:session.supervision.mode, name:session.supervision.name,
        id:session.supervision.id, supervisorId:session.supervision.supervisorId} : null} : null}, {headers:{"Cache-Control":"no-store"}});
  } catch (error) {
    if (error instanceof AuthzError) return authzErrorResponse(error);
    return NextResponse.json({error: "Video supervision unavailable"}, {status:500});
  }
}
export const GET = withPermission(Object.values(SUPERVISION_PERMISSION), GET_handler, {route: ROUTE});
