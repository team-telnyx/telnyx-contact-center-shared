/**
 * API endpoint for updating agent status
 * POST /api/contact-center/routing/agent-status
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { updateAgentQueues } from "@/lib/contact-center/state-manager";
import { offerQueuedCallForAgent } from "@/lib/contact-center/queued-call-router";
import { ensureAgentStatusState, setUserStatus } from "@/lib/contact-center/user-status";
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

    // Get user identity and Contact Center authoritative status
    const userResult = await pool.query(
      `SELECT
          u.username,
          s.agent_status AS current_agent_status,
          s.active_queue_ids
         FROM users u
         LEFT JOIN cc_agent_state s ON s.user_id = u.id
        WHERE u.id = $1`,
      [userId],
    );

    if (!userResult.rows || userResult.rows.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const user = userResult.rows[0];
    const username = user.username;

    // Update agent status if provided. If no cc_agent_state row exists yet,
    // mirror the users table default so queue-only activation can route calls.
    const effectiveStatus = status || user.current_agent_status || "Available";
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

      await setUserStatus({
        userId,
        username,
        status,
        previousStatus: user.current_agent_status || null,
      });
    }

    // Update queue assignments if provided
    if (queueIds !== undefined && Array.isArray(queueIds)) {
      updateAgentQueues(userId, queueIds, isActive !== false);

      const currentActiveQueueIds = Array.isArray(user.active_queue_ids)
        ? user.active_queue_ids
        : [];
      const updatedActiveQueueIds =
        isActive === false
          ? currentActiveQueueIds.filter((id) => !queueIds.includes(id))
          : [...new Set([...currentActiveQueueIds, ...queueIds])];

      // Ensure agent state exists and update active queues without changing an
      // existing Contact Center status.
      await ensureAgentStatusState({
        userId,
        username,
        status: effectiveStatus,
        activeQueueIds: updatedActiveQueueIds,
      });
    }

    const shouldOfferQueuedCalls =
      effectiveStatus === "Available" &&
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
      status: effectiveStatus,
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
