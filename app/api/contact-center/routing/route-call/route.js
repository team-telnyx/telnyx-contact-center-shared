export const dynamic = "force-dynamic";

/**
 * API endpoint for routing calls to agents
 * POST /api/contact-center/routing/route-call
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { routeCall } from "@/lib/contact-center/routing-engine";
import {
  enqueueCall,
  assignCallToAgent,
  refreshQueueState,
} from "@/lib/contact-center/state-manager";
import { PgDb } from "@/lib/pgdb";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { randomUUID } from "crypto";
import { promoteReservation } from "@/lib/contact-center/reservation-manager.js";
import { handleAgentCallLifecycleStatus } from "@/lib/contact-center/agent-call-lifecycle-status.js";

export async function POST(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const {
      queueId,
      callControlId,
      callSessionId,
      fromNumber,
      toNumber,
      fromName,
      toName,
      direction = "inbound",
      requiredSkills,
      priority,
      metadata = {},
    } = body;

    if (!queueId) {
      return NextResponse.json(
        { error: "queueId is required" },
        { status: 400 }
      );
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not available" },
        { status: 500 }
      );
    }

    // Verify queue exists and is enabled
    const queueResult = await pool.query(
      `SELECT * FROM cc_queues WHERE id = $1 AND enabled = true`,
      [queueId]
    );

    if (!queueResult.rows || queueResult.rows.length === 0) {
      return NextResponse.json(
        { error: "Queue not found or disabled" },
        { status: 404 }
      );
    }

    const queue = queueResult.rows[0];

    // Check if queue is at max capacity
    const queueStateResult = await pool.query(
      `SELECT current_size FROM cc_queue_state WHERE queue_id = $1`,
      [queueId]
    );
    const currentSize = parseInt(queueStateResult.rows[0]?.current_size) || 0;

    if (queue.max_size && currentSize >= queue.max_size) {
      // Queue is full, handle overflow
      if (queue.overflow_queue_id) {
        // Route to overflow queue
        return POST({
          ...request,
          json: async () => ({
            ...body,
            queueId: queue.overflow_queue_id,
          }),
        });
      } else if (queue.overflow_action === "hangup") {
        return NextResponse.json(
          {
            success: false,
            reason: "queue_full",
            action: "hangup",
          },
          { status: 200 }
        );
      }
    }

    // Create interaction record
    const interactionId = randomUUID();
    const enqueuedAt = new Date();

    await PgDb.insertInteraction({
      id: interactionId,
      interactionType: "voice",
      queueName: queue.name,
      queueId: queue.id,
      callControlId,
      callSessionId,
      direction,
      state: "queued",
      fromNumber,
      toNumber,
      fromName,
      toName,
      requiredSkills: requiredSkills || queue.skill_requirements || {},
      metadata: {
        ...metadata,
        priority: priority || queue.priority || 0,
      },
      enqueuedAt,
    });

    // Update state manager
    enqueueCall(queueId, interactionId, enqueuedAt, queue.name);

    // Attempt to route the call
    const routingResult = await routeCall(queueId, {
      required_skills: requiredSkills || queue.skill_requirements || {},
      priority: priority || queue.priority || 0,
      interactionId,
      callControlId,
      callSessionId,
    });

    if (routingResult.success && routingResult.agent) {
      // Assign call to agent
      const assignedAt = new Date();

      const metadataUpdates = routingResult.reservationId
        ? { reservationId: routingResult.reservationId }
        : {};

      await pool.query(
        `UPDATE cc_interactions
         SET agent_username = $1,
             state = 'ringing',
             assigned_at = $2,
             metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
             updated_at = NOW()
         WHERE id = $4`,
        [routingResult.agent.username, assignedAt, JSON.stringify(metadataUpdates), interactionId]
      );

      if (routingResult.reservationId) {
        await promoteReservation(routingResult.reservationId, "ringing");
      }

      await handleAgentCallLifecycleStatus({
        event: "ringing",
        userId: routingResult.agent.id,
        username: routingResult.agent.username,
        interaction: { id: interactionId, agent_username: routingResult.agent.username },
      });

      assignCallToAgent(
        queueId,
        interactionId,
        routingResult.agent.id,
        assignedAt
      );

      // Broadcast routing event via SSE
      try {
        const { broadcastToKey } = await import("@/lib/sse");
        await broadcastToKey(
          `user:${routingResult.agent.id}`,
          {
            type: "call_routed",
            interactionId,
            queueId,
            callControlId,
            fromNumber,
            toNumber,
            routingMetadata: routingResult.routingMetadata,
            timestamp: new Date().toISOString(),
          },
          "call_routed"
        );
      } catch (sseError) {
        console.error("[Routing] Failed to broadcast routing event:", sseError);
      }

      return NextResponse.json({
        success: true,
        interactionId,
        agent: routingResult.agent,
        routingMetadata: routingResult.routingMetadata,
      });
    } else {
      // Call is queued, waiting for agent
      return NextResponse.json({
        success: true,
        interactionId,
        queued: true,
        reason: routingResult.reason || "no_available_agents",
        estimatedWaitTime: null, // Could calculate based on queue stats
      });
    }
  } catch (error) {
    console.error("[Routing] Error routing call:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error.message,
      },
      { status: 500 }
    );
  }
}
