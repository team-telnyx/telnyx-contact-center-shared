/**
 * SSE endpoint for real-time Call Generator monitoring
 * GET /api/admin/call-generator/stream
 * Streams run + ledger snapshots every 2 seconds for the admin dashboard.
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { isAdmin } from "@/lib/role-utils";
import { PgDb } from "@/lib/pgdb";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { addSseClient, removeSseClient } from "@/lib/sse";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";

export const maxDuration = 300;

async function loadSnapshot(pool) {
  const [{ rows: runs }, { rows: ledgerStats }, { rows: recentCalls }] = await Promise.all([
    pool.query(
      `SELECT r.id, r.scenario_id, r.status, r.started_at, r.stopped_at, r.stats, r.created_at, s.name AS scenario_name
       FROM cg_runs r JOIN cg_scenarios s ON s.id = r.scenario_id
       ORDER BY r.created_at DESC LIMIT 25`,
    ),
    pool.query(
      `SELECT run_id, status, COUNT(*)::int AS count
       FROM cg_call_ledger
       WHERE run_id IN (SELECT id FROM cg_runs ORDER BY created_at DESC LIMIT 25)
       GROUP BY run_id, status`,
    ),
    pool.query(
      // max_duration_secs mirrors the effective max-call-duration precedence the
      // runner/engine apply (top-level run config → legacy post-answer run config
      // → per-scenario override → global Settings → 120s default), clamped to 10s–1h.
      // Surfaced so the dashboard can show
      // "elapsed / max" and color the live timer as it nears the hangup.
      `SELECT l.id, l.run_id, l.call_session_id, l.to_number, l.from_number, l.status,
              l.started_at, l.answered_at, l.ended_at, l.duration_ms, l.result, l.created_at,
              GREATEST(10, LEAST(3600, COALESCE(
                CASE WHEN (r.config #>> '{maxDurationSecs}') ~ '^\\s*[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)\\s*$' THEN (r.config #>> '{maxDurationSecs}')::numeric END,
                CASE WHEN (r.config #>> '{postAnswer,maxDurationSecs}') ~ '^\\s*[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)\\s*$' THEN (r.config #>> '{postAnswer,maxDurationSecs}')::numeric END,
                CASE WHEN (s.config #>> '{maxCallDurationSecs}') ~ '^\\s*[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)\\s*$' THEN (s.config #>> '{maxCallDurationSecs}')::numeric END,
                CASE WHEN (cs.settings #>> '{max_call_duration_secs}') ~ '^\\s*[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)\\s*$' THEN (cs.settings #>> '{max_call_duration_secs}')::numeric END,
                120
              )))::int AS max_duration_secs
       FROM cg_call_ledger l
       LEFT JOIN cg_runs r ON r.id = l.run_id
       LEFT JOIN cg_scenarios s ON s.id = r.scenario_id
       LEFT JOIN cg_settings cs ON cs.id = 'default'
       WHERE l.run_id IN (SELECT id FROM cg_runs WHERE status = 'running')
          OR l.created_at > NOW() - INTERVAL '15 minutes'
       ORDER BY l.created_at DESC LIMIT 100`,
    ),
  ]);

  const statsByRun = {};
  for (const row of ledgerStats) {
    if (!statsByRun[row.run_id]) statsByRun[row.run_id] = {};
    statsByRun[row.run_id][row.status] = row.count;
  }

  const active = recentCalls.filter((c) => ["dialing", "ringing", "answered", "talking"].includes(c.status));
  const totals = {
    activeCalls: active.length,
    dialing: active.filter((c) => c.status === "dialing").length,
    ringing: active.filter((c) => c.status === "ringing").length,
    answered: active.filter((c) => ["answered", "talking"].includes(c.status)).length,
    runningRuns: runs.filter((r) => r.status === "running").length,
  };

  return { runs, statsByRun, recentCalls, totals, timestamp: new Date().toISOString() };
}

export async function GET(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
    const user = await PgDb.findUserById(session.user.id);
    if (!user || !isAdmin(user)) return new Response("Access denied", { status: 403 });

    const pool = getPostgresPool();
    if (!pool) return new Response("Server not ready", { status: 500 });

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const key = `call-generator:${session.user.id}`;
        let closed = false;
        let updateInterval = null;

        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (updateInterval) {
            clearInterval(updateInterval);
            updateInterval = null;
          }
          removeSseClient(key, writer);
          try {
            controller.close();
          } catch {}
        };

        const send = (data, eventType = null) => {
          if (closed) return;
          try {
            const message = eventType
              ? `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
              : `data: ${JSON.stringify(data)}\n\n`;
            controller.enqueue(encoder.encode(message));
          } catch (error) {
            if (error.code === "ERR_INVALID_STATE" || error.message?.includes("closed")) cleanup();
          }
        };

        send({ type: "connected", timestamp: new Date().toISOString() });

        const writer = {
          write: (data) => {
            if (closed) return;
            try {
              controller.enqueue(data);
            } catch (error) {
              if (error.code === "ERR_INVALID_STATE" || error.message?.includes("closed")) cleanup();
            }
          },
        };
        addSseClient(key, writer);

        const sendUpdate = async () => {
          if (closed) return;
          try {
            const snapshot = await loadSnapshot(pool);
            if (closed) return;
            send({ type: "update", ...snapshot }, "cg_update");
          } catch (error) {
            if (error.code === "ERR_INVALID_STATE" || error.message?.includes("closed")) {
              cleanup();
            } else {
              adminRuntimeLogger.error("call_generator_stream_failed", runtimePayload({ error, operation: "cg_stream_update" }));
            }
          }
        };

        sendUpdate();
        updateInterval = setInterval(sendUpdate, 2000);
        request.signal.addEventListener("abort", cleanup);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    adminRuntimeLogger.error("call_generator_stream_failed", runtimePayload({ error, operation: "cg_stream" }));
    return new Response("Internal server error", { status: 500 });
  }
}
