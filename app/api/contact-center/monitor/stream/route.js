/**
 * SSE endpoint for real-time monitoring updates
 * GET /api/contact-center/monitor/stream
 * Streams real-time updates for supervisory console
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { PgDb } from "@/lib/pgdb";
import { addSseClient, removeSseClient, broadcastToKey } from "@/lib/sse";

// Disable timeout for SSE streams (they should stay open indefinitely)
export const maxDuration = 300; // 5 minutes (max allowed by Vercel, but effectively unlimited for SSE)

export async function GET(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Supervisors and admins can access the monitoring stream
    const user = await PgDb.findUserById(session.user.id);
    if (!user || !isSupervisorOrAdmin(user)) {
      return new Response("Access denied", { status: 403 });
    }

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const key = `monitor:${session.user.id}`;

        // Send initial connection message
        const send = (data, eventType = null) => {
          try {
            const message = eventType
              ? `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
              : `data: ${JSON.stringify(data)}\n\n`;
            controller.enqueue(encoder.encode(message));
          } catch (error) {
            console.error("[MonitorStream] Error sending message:", error);
          }
        };

        // Send initial data
        send({ type: "connected", timestamp: new Date().toISOString() });

        // Store writer for broadcasting
        const writer = {
          write: (data) => {
            try {
              controller.enqueue(data);
            } catch (error) {
              console.error("[MonitorStream] Error writing:", error);
            }
          },
        };

        addSseClient(key, writer);

        // Function to send monitor update
        const sendMonitorUpdate = async () => {
          try {
            const {
              getQueueStatistics,
              getAgentStatistics,
              getOverallStatistics,
            } = await import("@/lib/contact-center/stats-aggregator");
            const { getAllQueueStates, getAllAgentStates } = await import(
              "@/lib/contact-center/state-manager"
            );

            const [queueStats, agentStats, overallStats] = await Promise.all([
              getQueueStatistics(),
              getAgentStatistics(),
              getOverallStatistics(),
            ]);

            send(
              {
                type: "update",
                overall: overallStats,
                queues: {
                  stats: Array.isArray(queueStats)
                    ? queueStats
                    : [queueStats].filter(Boolean),
                  states: getAllQueueStates(),
                },
                agents: {
                  stats: Array.isArray(agentStats)
                    ? agentStats
                    : [agentStats].filter(Boolean),
                  states: getAllAgentStates(),
                },
                timestamp: new Date().toISOString(),
              },
              "monitor_update"
            );
          } catch (error) {
            console.error("[MonitorStream] Error in update:", error);
          }
        };

        // Send initial update
        sendMonitorUpdate();

        // Send periodic updates
        const updateInterval = setInterval(sendMonitorUpdate, 3000); // Update every 3 seconds for more responsive updates

        // Cleanup on close
        request.signal.addEventListener("abort", () => {
          clearInterval(updateInterval);
          removeSseClient(key, writer);
          try {
            controller.close();
          } catch (error) {
            // Ignore close errors
          }
        });
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
    console.error("[MonitorStream] Error:", error);
    return new Response("Internal server error", { status: 500 });
  }
}
