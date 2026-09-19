import { RELEASED_CHANNELS } from "@/lib/acd/channel-registry.mjs";
import { parseChannel } from "@/lib/acd/interaction-channels.mjs";
import { resolveReportingScope } from "@/lib/acd/reporting-scope.mjs";
import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import {
  normalizeCallerPhone,
  resolveCallerIdentities,
} from "@/lib/contact-center/caller-identity.mjs";
import { resolveInteractionDurationSeconds } from "@/lib/contact-center/interaction-duration.mjs";
import {
  contactCenterRuntimeLogger,
  runtimePayload,
} from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { interactionScopeSql } from "@/lib/authz/scope.mjs";

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function GET_handler(request, _context, authz) {
  try {
    const user = authz.user;

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 503 },
      );
    }

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, Math.floor(Number(searchParams.get("page")) || 1));
    const pageSize = Math.min(
      100,
      Math.max(1, Math.floor(Number(searchParams.get("pageSize")) || 25)),
    );
    const {from,to,timezone} = await resolveReportingScope(pool,searchParams);
    const channel = parseChannel(searchParams.get("channel"));
    const queueName = searchParams.get("queue");
    const agentUsername = searchParams.get("agent");
    const summaryOnly = searchParams.get("summary") === "true";

    const where = ["i.interaction_type = ANY($1::text[])", "i.terminal_at IS NOT NULL"];
    const values = [channel ? [channel] : RELEASED_CHANNELS];
    const add = (clause, value) => {
      values.push(value);
      where.push(clause.replace("?", `$${values.length}`));
    };
    if (from) add("i.terminal_at >= ?", from);
    if (to) add("i.terminal_at < ?", to);
    if (queueName) add("EXISTS(SELECT 1 FROM acd_segments s JOIN cc_queues q ON q.id=s.queue_id WHERE s.work_item_id=i.work_item_id AND q.name=?)", queueName);
    if (agentUsername) add("EXISTS(SELECT 1 FROM acd_segments s JOIN users u ON u.id=s.agent_id WHERE s.work_item_id=i.work_item_id AND u.username=?)", agentUsername);
    // Caller's data scope (Phase 3a): queues, team agents and channels of the granting roles.
    where.push(...interactionScopeSql(authz.scope, { queue: "i.queue_id", agent: "i.agent_id", channel: "i.interaction_type", workItem: "i.work_item_id" }, values));
    const outcome=searchParams.get("outcome");
    if(outcome && ["completed","abandoned","failed"].includes(outcome)) add("i.state = ?",outcome);
    const search=searchParams.get("search")?.trim();
    if(search) add("concat_ws(' ',i.work_item_id::text,i.from_number,i.to_number,i.from_name,i.queue_name,(SELECT subject FROM cc_email_threads t WHERE t.conversation_id=i.conversation_id LIMIT 1)) ILIKE ?",`%${search.slice(0,200)}%`);
    const whereSql = `WHERE ${where.join(" AND ")}`;

    if (summaryOnly) {
      const [callsResult, dailyResult, queuesResult] = await Promise.all([
        pool.query(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE i.state='completed')::int AS answered,
                  COUNT(*) FILTER (WHERE i.state = 'abandoned')::int AS abandoned,
                  AVG(i.wait_time_seconds)::numeric(10,2) AS avg_wait_time_seconds,
                  AVG(i.handle_time_seconds)::numeric(10,2) AS avg_handle_time_seconds,
                  AVG(i.talk_time_seconds) FILTER(WHERE i.interaction_type='voice')::numeric(10,2) AS avg_talk_time_seconds
             FROM acd_history_interactions i
             ${whereSql}`,
          values,
        ),
        pool.query(
          `SELECT to_char(i.terminal_at AT TIME ZONE $${values.length + 1},'YYYY-MM-DD') AS day,
                  COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE i.state='completed')::int AS answered,
                  COUNT(*) FILTER (WHERE i.state = 'abandoned')::int AS abandoned,
                  AVG(i.wait_time_seconds)::numeric(10,2) AS avg_wait_time_seconds
             FROM acd_history_interactions i
             ${whereSql}
            GROUP BY to_char(i.terminal_at AT TIME ZONE $${values.length + 1},'YYYY-MM-DD')
            ORDER BY to_char(i.terminal_at AT TIME ZONE $${values.length + 1},'YYYY-MM-DD')`,
          [...values,timezone],
        ),
        pool.query(
          `SELECT COALESCE(i.queue_name, 'No queue') AS queue_name,
                  COUNT(*)::int AS total,
                  AVG(i.wait_time_seconds)::numeric(10,2) AS avg_wait_time_seconds
             FROM acd_history_interactions i
             ${whereSql}
            GROUP BY COALESCE(i.queue_name, 'No queue')
            ORDER BY total DESC
            LIMIT 12`,
          values,
        ),
      ]);
      const calls = callsResult.rows[0] || {};
      return NextResponse.json({
        ok: true,
        summary: {
          calls: {
            total: asNumber(calls.total),
            answered: asNumber(calls.answered),
            abandoned: asNumber(calls.abandoned),
          },
          durations: {
            avgWaitTimeSeconds: asNumber(calls.avg_wait_time_seconds),
            avgHandleTimeSeconds: asNumber(calls.avg_handle_time_seconds),
            avgTalkTimeSeconds: asNumber(calls.avg_talk_time_seconds),
          },
          daily: dailyResult.rows.map((row) => ({
            day: row.day,
            label: row.day,
            total: asNumber(row.total),
            answered: asNumber(row.answered),
            abandoned: asNumber(row.abandoned),
            avgWaitTimeSeconds: asNumber(row.avg_wait_time_seconds),
          })),
          queues: queuesResult.rows.map((row) => ({
            queueName: row.queue_name,
            total: asNumber(row.total),
            avgWaitTimeSeconds: asNumber(row.avg_wait_time_seconds),
          })),
        },
      });
    }

    const offset = (page - 1) * pageSize;
    const [rowsResult, countResult, queuesResult, agentsResult] =
      await Promise.all([
        pool.query(
          `SELECT i.*,(SELECT subject FROM cc_email_threads t WHERE t.conversation_id=i.conversation_id LIMIT 1) AS subject,
                  i.created_at AS customer_started_at,
                  i.terminal_at AS customer_ended_at
             FROM acd_history_interactions i
             ${whereSql}
            ORDER BY i.terminal_at DESC
            LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
          [...values, pageSize, offset],
        ),
        pool.query(
          `SELECT COUNT(*) AS count,COUNT(*) FILTER(WHERE i.state='completed')::int AS completed,
                  COUNT(*) FILTER(WHERE i.state IN ('abandoned','failed'))::int AS missed,
                  COUNT(*) FILTER(WHERE i.recording_url IS NOT NULL AND i.interaction_type='voice')::int AS recordings,
                  COUNT(*) FILTER(WHERE EXISTS(SELECT 1 FROM acd_messages m WHERE m.work_item_id=i.work_item_id))::int AS conversations
             FROM acd_history_interactions i
             ${whereSql}`,
          values,
        ),
        pool.query(
          `SELECT DISTINCT q.name AS queue_name FROM acd_work_items w JOIN acd_segments s ON s.work_item_id=w.id
            JOIN cc_queues q ON q.id=s.queue_id WHERE w.terminal_at>=$1 AND w.terminal_at<$2 AND w.channel=ANY($3::text[]) ORDER BY q.name`,[from,to,channel?[channel]:RELEASED_CHANNELS],
        ),
        pool.query(
          `SELECT DISTINCT u.username,u.first_name,u.last_name FROM acd_work_items w JOIN acd_segments s ON s.work_item_id=w.id
            JOIN users u ON u.id=s.agent_id WHERE w.terminal_at>=$1 AND w.terminal_at<$2 AND w.channel=ANY($3::text[]) ORDER BY u.username`,[from,to,channel?[channel]:RELEASED_CHANNELS],
        ),
      ]);

    const unresolvedNumbers = [
      ...new Set(
        rowsResult.rows
          .filter((row) => row.interaction_type === "voice" && !row.from_name)
          .map((row) => row.from_number)
          .filter(Boolean),
      ),
    ];
    const callerIdentities = await resolveCallerIdentities(
      pool,
      unresolvedNumbers,
    );
    const rows = rowsResult.rows.map((row) => ({
      ...row,
      interaction_duration_seconds: resolveInteractionDurationSeconds(row),
      from_name:
        row.from_name ||
        (row.interaction_type === "voice" ? callerIdentities.get(normalizeCallerPhone(row.from_number))?.name : null) ||
        null,
      agent_name:
        row.first_name || row.last_name
          ? `${row.first_name || ""} ${row.last_name || ""}`.trim()
          : row.agent_username || null,
      required_skills: row.required_skills || {},
      routing_metadata: row.routing_metadata || { timeline: [] },
      transfer_history: row.transfer_history || [],
      tags: row.tags || [],
      wrapup_codes: row.wrapup_codes || [],
      metadata: row.metadata || {},
    }));

    return NextResponse.json({
      ok: true,
      rows,
      count: asNumber(countResult.rows[0]?.count),
      totals: countResult.rows[0],
      scope: {from,to,timezone,cohort:"closed"},
      filters: {
        queues: queuesResult.rows.map((row) => row.queue_name),
        agents: agentsResult.rows.map((row) => ({
          username: row.username,
          name:
            row.first_name || row.last_name
              ? `${row.first_name || ""} ${row.last_name || ""}`.trim()
              : row.username,
        })),
      },
    });
  } catch (error) {
    contactCenterRuntimeLogger.error("runtime_error", {
      ...runtimePayload({ error }),
    });
    return NextResponse.json(
      { ok: false, error: error.status ? error.message : "Failed to fetch interaction history" },
      { status: error.status || 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("interactions_history:read", GET_handler, { route: "/api/contact-center/interactions/history" });
