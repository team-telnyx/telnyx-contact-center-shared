import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { interactionsLogger, contactCenterErrorPayload } from "@/lib/contact-center/logging.mjs";
import { persistAgentAssistTranscriptionsInTransaction } from "@/lib/agent-assist/transcription-persistence.mjs";
import { withPermission } from "@/lib/authz/guard";
import { workItemInScope } from "@/lib/authz/scope.mjs";

async function POST_handler(request, { params }, authz) {
  try {
    const user = authz.user;

    const resolvedParams = (await params) || {};
    const { id } = resolvedParams;
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "Interaction ID is required" },
        { status: 400 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const transcriptions = Array.isArray(body.transcriptions)
      ? body.transcriptions
      : [];

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 500 }
      );
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const workItemRes = await client.query(
        `SELECT w.id, owner.username AS agent_username
           FROM acd_work_items w
           LEFT JOIN LATERAL (
             SELECT u.username
               FROM acd_segments s
               JOIN users u ON u.id = s.agent_id
              WHERE s.work_item_id = w.id AND s.kind = 'agent'
              ORDER BY (s.ended_at IS NULL) DESC, s.seq DESC
              LIMIT 1
           ) owner ON true
          WHERE w.id::text = $1
          FOR UPDATE OF w`,
        [String(id)],
      );
      const workItem = workItemRes.rows?.[0];
      if (!workItem) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { ok: false, error: "Interaction not found" },
          { status: 404 }
        );
      }
      if (
        !authz.elevated &&
        (!user.username || workItem.agent_username !== user.username)
      ) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { ok: false, error: "This interaction belongs to another agent" },
          { status: 403 },
        );
      }
      if (authz.elevated && !(await workItemInScope(client, authz.scope, workItem.id))) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { ok: false, error: "Interaction is outside your data scope" },
          { status: 403 },
        );
      }

      // Queue transfers keep one durable interaction while each agent has a
      // fresh browser call store. Merge the browser transcript into the typed
      // workflow session and a Core transcript artifact atomically. The same
      // writer is also used directly by the server-side live STT router.
      await persistAgentAssistTranscriptionsInTransaction(client, {
        workItemId: workItem.id,
        transcriptions,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    interactionsLogger.error("interaction_error_0", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof hangupError !== "undefined" ? hangupError : typeof e !== "undefined" ? e : undefined) });
    return NextResponse.json(
      { ok: false, error: "Failed to store transcription data" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
// Agents may transcribe their own interactions; supervisors (monitor:read) any interaction.
export const POST = withPermission(["interactions:transcribe", "agent:self"], POST_handler, { elevated: "monitor:read", route: "/api/contact-center/interactions/[id]/transcription" });
