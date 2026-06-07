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
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

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
        let closed = false;
        let updateInterval = null;

        // Cleanup function
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
          } catch (error) {
            // Ignore close errors
          }
        };

        // Send initial connection message
        const send = (data, eventType = null) => {
          if (closed) return;
          try {
            const message = eventType
              ? `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
              : `data: ${JSON.stringify(data)}\n\n`;
            controller.enqueue(encoder.encode(message));
          } catch (error) {
            // Controller might be closed, cleanup if needed
            if (
              error.code === "ERR_INVALID_STATE" ||
              error.message?.includes("closed")
            ) {
              cleanup();
            } else {
              contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
            }
          }
        };

        // Send initial data
        send({ type: "connected", timestamp: new Date().toISOString() });

        // Store writer for broadcasting
        const writer = {
          write: (data) => {
            if (closed) return;
            try {
              controller.enqueue(data);
            } catch (error) {
              // Controller might be closed, cleanup if needed
              if (
                error.code === "ERR_INVALID_STATE" ||
                error.message?.includes("closed")
              ) {
                cleanup();
              } else {
                contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
              }
            }
          },
        };

        addSseClient(key, writer);

        // Function to send monitor update
        const sendMonitorUpdate = async () => {
          if (closed) return;
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

            // Check again before sending (might have closed during async operations)
            if (closed) return;

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
            // If error is due to closed controller, cleanup
            if (
              error.code === "ERR_INVALID_STATE" ||
              error.message?.includes("closed")
            ) {
              cleanup();
            } else {
              contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
            }
          }
        };

        // Send initial update
        sendMonitorUpdate();

        // Send periodic updates
        updateInterval = setInterval(sendMonitorUpdate, 3000); // Update every 3 seconds for more responsive updates

        // Cleanup on close
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
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return new Response("Internal server error", { status: 500 });
  }
}
