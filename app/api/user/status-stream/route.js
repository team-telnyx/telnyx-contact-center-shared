import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { addSseClient, removeSseClient } from "@/lib/sse";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { setUserStatus } from "@/lib/contact-center/user-status";
import {
  hasActiveSessionPresence,
  registerSessionPresence,
  removeSessionPresence,
  touchSessionPresence,
} from "@/lib/contact-center/session-presence";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

const globalAny = globalThis;
if (!globalAny.__session_presence_offline_timers) {
  globalAny.__session_presence_offline_timers = new Map();
}
const presenceOfflineTimers = globalAny.__session_presence_offline_timers;
const PRESENCE_OFFLINE_GRACE_MS = 30000;

async function getCurrentAgentStatus(userId) {
  try {
    const pool = getPostgresPool();
    if (!pool || !userId) return null;
    const result = await pool.query(
      `SELECT agent_status FROM cc_agent_state WHERE user_id = $1`,
      [String(userId)],
    );
    return result.rows?.[0]?.agent_status || null;
  } catch (_) {
    return null;
  }
}

function clearPresenceOfflineTimer(userId) {
  const existing = presenceOfflineTimers.get(String(userId));
  if (existing) {
    clearTimeout(existing);
    presenceOfflineTimers.delete(String(userId));
  }
}

function schedulePresenceOffline({ userId, username, statusKey }) {
  clearPresenceOfflineTimer(userId);
  const timer = setTimeout(async function markOfflineAfterDisconnect() {
    presenceOfflineTimers.delete(String(userId));
    if (await hasActiveSessionPresence({ userId, fallbackKey: statusKey })) return;
    const previousStatus = await getCurrentAgentStatus(userId);
    if (previousStatus === "Offline") return;
    await setUserStatus({
      userId: String(userId),
      username,
      status: "Offline",
      previousStatus,
    });
  }, PRESENCE_OFFLINE_GRACE_MS);
  presenceOfflineTimers.set(String(userId), timer);
}

// Disable timeout for SSE streams (they should stay open indefinitely)
export const maxDuration = 300; // 5 minutes (max allowed by Vercel, but effectively unlimited for SSE)

// Server-Sent Events endpoint for real-time status and queue updates
export async function GET(request) {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = String(user.id);
  const statusKey = `user:status:${userId}`;
  const queueKey = `user:queues:${userId}`;
  clearPresenceOfflineTimer(userId);

  // Create a readable stream for SSE
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Create a writer-like object that wraps controller.enqueue
      const writer = {
        write: async (data) => {
          try {
            controller.enqueue(data);
          } catch (error) {
            platformApiLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
            throw error;
          }
        },
        close: async () => {
          try {
            controller.close();
          } catch (_) {}
        },
      };

      // Register this client for status and queue updates
      addSseClient(statusKey, writer);
      addSseClient(queueKey, writer);
      let presenceConnectionId = null;
      try {
        const registeredPresence = await registerSessionPresence({
          userId,
          username: user.username,
        });
        presenceConnectionId = registeredPresence?.connectionId || null;
      } catch (error) {
        platformApiLogger.warn("runtime_warning", { ...runtimePayload({ error }) });
      }

      // Send initial connection event
      const sendEvent = async (event, data) => {
        const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          await writer.write(encoder.encode(message));
        } catch (error) {
          platformApiLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
          throw error;
        }
      };

      // Send connected event
      await sendEvent("connected", { timestamp: new Date().toISOString() });
      const currentStatus = await getCurrentAgentStatus(userId);
      if (currentStatus) {
        await sendEvent("status_changed", {
          type: "status_changed",
          status: currentStatus,
          previousStatus: null,
          userId,
          username: user.username,
          snapshot: true,
          timestamp: new Date().toISOString(),
        });
      }

      // Track last successful ping to detect stale connections
      let lastPingSuccess = Date.now();
      let consecutiveFailures = 0;
      let pingInterval = null;
      let disconnectHandled = false;

      // Handle client disconnect. This user session stream is the server-side
      // presence signal: when all streams for the user are gone for the grace
      // period, the agent is no longer connected and must be marked Offline.
      const handleDisconnect = async () => {
        // Prevent multiple calls
        if (disconnectHandled) {
          return;
        }
        disconnectHandled = true;

        if (pingInterval) {
          clearInterval(pingInterval);
        }
        removeSseClient(statusKey, writer);
        removeSseClient(queueKey, writer);
        try {
          await removeSessionPresence({ userId, connectionId: presenceConnectionId });
        } catch (error) {
          platformApiLogger.warn("runtime_warning", { ...runtimePayload({ error }) });
        }
        try {
          await writer.close();
        } catch (_) {}
        schedulePresenceOffline({
          userId,
          username: user.username,
          statusKey,
        });
      };

      // Send periodic ping to keep connection alive
      // Use shorter interval to prevent any timeout issues
      pingInterval = setInterval(async () => {
        try {
          await sendEvent("ping", { timestamp: new Date().toISOString() });
          try {
            await touchSessionPresence({ userId, connectionId: presenceConnectionId });
          } catch (error) {
            platformApiLogger.warn("runtime_warning", { ...runtimePayload({ error }) });
          }
          lastPingSuccess = Date.now();
          consecutiveFailures = 0;
        } catch (error) {
          consecutiveFailures++;
          // If ping fails, connection is likely dead - trigger cleanup
          if (consecutiveFailures >= 2) {
            clearInterval(pingInterval);
            removeSseClient(statusKey, writer);
            removeSseClient(queueKey, writer);
            try {
              await writer.close();
            } catch (_) {}
            // Trigger disconnect handler
            handleDisconnect();
          }
        }
      }, 15000); // Ping every 15 seconds to keep connection alive

      request.signal.addEventListener("abort", handleDisconnect);
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable buffering for nginx
    },
  });
}
