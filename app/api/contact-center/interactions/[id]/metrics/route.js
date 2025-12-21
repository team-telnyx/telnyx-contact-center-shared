import { NextResponse } from "next/server";
import { PgDb } from "@/lib/pgdb";
import { getAuthenticatedUser } from "@/lib/auth-server";
import {
  addTimelineEvent,
  TimelineEventTypes,
} from "@/lib/contact-center/call-timeline-tracker.js";

/**
 * POST /api/contact-center/interactions/[id]/metrics
 * Update call metrics (hold, transfer, talk time) for an interaction
 */
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "Interaction ID is required" },
        { status: 400 }
      );
    }

    // Verify authentication
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }
    const userId = user.id;

    const body = await request.json();
    const {
      holdCount,
      holdDurationSeconds,
      transferCount,
      transferHistory,
      talkTimeSeconds,
      holdEvents, // Array of {type: 'hold'|'resume', timestamp} from client store
    } = body;

    // Find the interaction
    const interaction = await PgDb.findInteractionById(id);
    if (!interaction) {
      return NextResponse.json(
        { ok: false, error: "Interaction not found" },
        { status: 404 }
      );
    }

    // Verify the interaction belongs to the authenticated user (if agent_username is set)
    if (interaction.agent_username) {
      // Get username from user ID
      const { getPostgresPool } = await import("@/lib/postgres.mjs");
      const pool = getPostgresPool();
      if (pool) {
        const userResult = await pool.query(
          "SELECT username FROM users WHERE id = $1 LIMIT 1",
          [userId]
        );
        const username = userResult.rows?.[0]?.username;
        if (username && interaction.agent_username !== username) {
          return NextResponse.json(
            {
              ok: false,
              error: "Unauthorized - interaction belongs to different agent",
            },
            { status: 403 }
          );
        }
      }
    }

    // Prepare updates
    const updates = {};
    let updatedRoutingMetadata = interaction.routing_metadata || {};

    // Add timeline events for hold/resume if provided
    if (holdEvents && Array.isArray(holdEvents)) {
      holdEvents.forEach((event) => {
        if (event.type === "hold") {
          updatedRoutingMetadata = addTimelineEvent(
            updatedRoutingMetadata,
            TimelineEventTypes.HOLD,
            {
              timestamp: event.timestamp, // Preserve client-side timestamp
              holdNumber: event.holdNumber || null,
            }
          );
        } else if (event.type === "resume") {
          updatedRoutingMetadata = addTimelineEvent(
            updatedRoutingMetadata,
            TimelineEventTypes.RESUME,
            {
              timestamp: event.timestamp, // Preserve client-side timestamp
              holdDuration: event.duration || null,
            }
          );
        }
      });
    }

    if (holdCount !== undefined) updates.holdCount = holdCount;
    if (holdDurationSeconds !== undefined)
      updates.holdDurationSeconds = holdDurationSeconds;
    if (transferCount !== undefined) updates.transferCount = transferCount;
    if (transferHistory !== undefined)
      updates.transferHistory = transferHistory;
    if (talkTimeSeconds !== undefined)
      updates.talkTimeSeconds = talkTimeSeconds;
    if (Object.keys(updatedRoutingMetadata).length > 0) {
      updates.routingMetadata = updatedRoutingMetadata;
    }

    // Update interaction
    await PgDb.updateInteractionById(id, updates);

    console.log(`[Metrics] ✅ Updated metrics for interaction ${id}:`, updates);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[Metrics] Error updating interaction metrics:", err);
    return NextResponse.json(
      { ok: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
