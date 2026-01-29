/**
 * API endpoint for updating agent status
 * POST /api/contact-center/routing/agent-status
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import {
  updateAgentStatus,
  updateAgentQueues,
} from "@/lib/contact-center/state-manager";
import { offerQueuedCallForAgent } from "@/lib/contact-center/queued-call-router";
import { getPostgresPool } from "@/lib/postgres.mjs";

export async function POST(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;
    const body = await request.json();
    const { status, queueIds, isActive, system } = body;

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not available" },
        { status: 500 },
      );
    }

    // Get user info
    const userResult = await pool.query(
      `SELECT username, agent_status FROM users WHERE id = $1`,
      [userId],
    );

    if (!userResult.rows || userResult.rows.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const user = userResult.rows[0];
    const username = user.username;

    // Update agent status if provided
    const effectiveStatus = status || user.agent_status;
    if (status) {
      // Validate status
      // Get valid statuses from database
      // Offline is system-only and not user-selectable
      let validStatuses = system
        ? ["Available", "Busy", "Away", "Offline"] // System can set any status including Offline
        : ["Available", "Busy", "Away"]; // Users can only select user-selectable statuses (Offline excluded)
      if (pool) {
        try {
          const statusResult = await pool.query(
            system
              ? `SELECT name FROM cc_user_statuses WHERE is_active = true ORDER BY display_order ASC, name ASC`
              : `SELECT name FROM cc_user_statuses WHERE is_active = true AND user_selectable = true ORDER BY display_order ASC, name ASC`,
          );
          if (statusResult.rows.length > 0) {
            validStatuses = statusResult.rows.map((row) => row.name);
          }
        } catch (error) {
          console.error("[AgentStatus] Error fetching statuses:", error);
          // Use fallback statuses
        }
      }
      if (!validStatuses.includes(status)) {
        return NextResponse.json(
          {
            error: `Invalid status. Must be one of: ${validStatuses.join(
              ", ",
            )}`,
          },
          { status: 400 },
        );
      }

      // Update in database
      await pool.query(
        `UPDATE users SET agent_status = $1, updated_at = NOW() WHERE id = $2`,
        [status, userId],
      );

      // Update in state manager
      await updateAgentStatus(userId, status, username);

      // Update agent state table
      await pool.query(
        `INSERT INTO cc_agent_state (user_id, username, agent_status, last_status_change, last_activity)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           agent_status = EXCLUDED.agent_status,
           last_status_change = NOW(),
           last_activity = NOW()`,
        [userId, username, status],
      );
    }

    // Update queue assignments if provided
    if (queueIds !== undefined && Array.isArray(queueIds)) {
      updateAgentQueues(userId, queueIds, isActive !== false);

      // Update agent state table
      await pool.query(
        `UPDATE cc_agent_state 
         SET active_queue_ids = $1, last_activity = NOW()
         WHERE user_id = $2`,
        [queueIds, userId],
      );
    }

    const shouldOfferQueuedCalls =
      ["Available", "Busy"].includes(effectiveStatus) &&
      (Boolean(status) || (Array.isArray(queueIds) && isActive !== false));

    if (shouldOfferQueuedCalls) {
      try {
        await offerQueuedCallForAgent({
          userId,
          queueIds: status ? null : queueIds,
        });
      } catch (error) {
        console.error(
          "[AgentStatus] Failed to offer queued calls after status change:",
          error,
        );
      }
    }

    return NextResponse.json({
      success: true,
      userId,
      status: status || user.agent_status,
      queueIds: queueIds || [],
    });
  } catch (error) {
    console.error("[Routing] Error updating agent status:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error.message,
      },
      { status: 500 },
    );
  }
}
