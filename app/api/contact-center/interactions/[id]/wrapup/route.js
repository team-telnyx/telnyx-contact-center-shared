import { NextResponse } from "next/server";
import { PgDb } from "@/lib/pgdb";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { wrapupLogger, callPayload, agentPayload, contactCenterErrorPayload } from "@/lib/contact-center/logging.mjs";
import {
  addTimelineEvent,
  TimelineEventTypes,
} from "@/lib/contact-center/call-timeline-tracker";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { handleAgentCallLifecycleStatus } from "@/lib/contact-center/agent-call-lifecycle-status";

async function getUsernameForUserId(userId) {
  const pool = getPostgresPool();
  if (!pool) return null;
  const userResult = await pool.query(
    "SELECT username FROM users WHERE id = $1 LIMIT 1",
    [userId],
  );
  return userResult.rows?.[0]?.username || null;
}

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "Interaction ID is required" },
        { status: 400 },
      );
    }

    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const interaction = await PgDb.findInteractionById(id);
    if (!interaction) {
      return NextResponse.json(
        { ok: false, error: "Interaction not found" },
        { status: 404 },
      );
    }

    if (interaction.agent_username) {
      const username = await getUsernameForUserId(user.id);
      if (username && interaction.agent_username !== username) {
        return NextResponse.json(
          {
            ok: false,
            error: "Unauthorized - interaction belongs to different agent",
          },
          { status: 403 },
        );
      }
    }

    const body = await request.json();
    const action = body?.action;
    if (!["start", "end"].includes(action)) {
      return NextResponse.json(
        { ok: false, error: "Invalid wrapup action" },
        { status: 400 },
      );
    }

    const wasAnswered = Boolean(interaction.answered_at);
    if (action === "start" && !wasAnswered) {
      return NextResponse.json(
        { ok: false, error: "Wrapup requires an answered call" },
        { status: 409 },
      );
    }

    const updates = {};
    const metadata = {
      ...(interaction.metadata || {}),
    };
    let updatedRoutingMetadata = interaction.routing_metadata || {};

    if (action === "start") {
      if (!metadata.wrapup_started_at) {
        const timeline = Array.isArray(updatedRoutingMetadata.timeline)
          ? updatedRoutingMetadata.timeline
          : [];
        const disconnectedEvent = timeline.find(
          (event) => event.type === TimelineEventTypes.DISCONNECTED,
        );
        const completedAt =
          interaction.completed_at ||
          interaction.abandoned_at ||
          disconnectedEvent?.timestamp ||
          null;

        // Check if call is in a terminal state (completed/abandoned) even if timestamp isn't set yet
        const isTerminalState =
          interaction.state === "completed" ||
          interaction.state === "abandoned" ||
          interaction.state === "failed";

        if (!completedAt && !isTerminalState) {
          return NextResponse.json(
            { ok: false, error: "Call not disconnected yet", retry: true },
            { status: 409 },
          );
        }

        const nowMs = Date.now();
        // If we have a completedAt timestamp, use it; otherwise use current time for terminal states
        const completedMs = completedAt
          ? new Date(completedAt).getTime()
          : nowMs;
        const startedAt = new Date(
          Math.max(nowMs, Number.isNaN(completedMs) ? nowMs : completedMs),
        ).toISOString();
        metadata.wrapup_started_at = startedAt;
        updatedRoutingMetadata = addTimelineEvent(
          updatedRoutingMetadata,
          TimelineEventTypes.WRAPUP_START,
          {
            timestamp: startedAt,
            agentUsername: interaction.agent_username || null,
          },
        );
        updates.metadata = metadata;
        updates.routingMetadata = updatedRoutingMetadata;
      }
    } else {
      const endedAt = new Date().toISOString();
      metadata.wrapup_ended_at = endedAt;
      let durationSeconds = null;
      if (metadata.wrapup_started_at) {
        const startMs = new Date(metadata.wrapup_started_at).getTime();
        const endMs = new Date(endedAt).getTime();
        if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) {
          durationSeconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
        }
      }
      if (durationSeconds != null) {
        metadata.wrapup_duration_seconds = durationSeconds;
      }
      updatedRoutingMetadata = addTimelineEvent(
        updatedRoutingMetadata,
        TimelineEventTypes.WRAPUP_END,
        {
          timestamp: endedAt,
          wrapupDurationSeconds: durationSeconds,
          agentUsername: interaction.agent_username || null,
        },
      );
      updates.metadata = metadata;
      updates.routingMetadata = updatedRoutingMetadata;
    }

    await PgDb.updateInteractionById(id, updates);

    if (interaction.agent_username) {
      await handleAgentCallLifecycleStatus({
        event: action === "start" ? "disconnected" : "wrapup-ended",
        userId: user.id,
        username: interaction.agent_username,
        interaction,
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    wrapupLogger.error("wrapup_error_0", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof hangupError !== "undefined" ? hangupError : typeof e !== "undefined" ? e : undefined) });
    return NextResponse.json(
      { ok: false, error: "Failed to update wrapup status" },
      { status: 500 },
    );
  }
}
