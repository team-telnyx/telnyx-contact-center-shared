import { PgDb } from "@/lib/pgdb";
import { getPostgresPool } from "@/lib/postgres.mjs";

/**
 * Determine the username (user's email) for a call based on the phone numbers and connection
 * - For incoming calls: find user by voice_number matching the TO field
 * - For outgoing calls: find user by voice_number matching the FROM field
 * - For WebRTC calls: check if the connection_id matches a user's telephony_credentials_id
 */
async function determineCallUsername(payload) {
  const pool = getPostgresPool();
  if (!pool) return "unknown";

  const direction = String(payload?.direction || "").toLowerCase();
  const to = payload?.to || "";
  const from = payload?.from || "";
  const connectionId = payload?.connection_id || "";

  try {
    // Try to find user by voice number
    if (direction === "incoming" && to) {
      const r = await pool.query(
        "SELECT username FROM users WHERE voice_number=$1 LIMIT 1",
        [String(to)]
      );
      if (r.rows?.[0]?.username) return r.rows[0].username;
    }

    if (direction === "outgoing" && from) {
      const r = await pool.query(
        "SELECT username FROM users WHERE voice_number=$1 LIMIT 1",
        [String(from)]
      );
      if (r.rows?.[0]?.username) return r.rows[0].username;
    }

    // Try to find user by telephony credentials (WebRTC calls)
    if (connectionId) {
      const r = await pool.query(
        "SELECT username FROM users WHERE telephony_credentials_id=$1 LIMIT 1",
        [String(connectionId)]
      );
      if (r.rows?.[0]?.username) return r.rows[0].username;
    }
  } catch (err) {
    console.error("[call-logger] Error determining username:", err);
  }

  return "unknown";
}

/**
 * Log or update a call in the database based on webhook events
 *
 * @param {object} webhookData - The full webhook payload from Telnyx
 * @returns {Promise<string|null>} - The call ID or null if failed
 */
export async function logCallEvent(webhookData) {
  try {
    const eventType =
      webhookData?.data?.event_type || webhookData?.event_type || "";
    const payload = webhookData?.data?.payload || webhookData?.data || {};
    const callControlId = payload?.call_control_id || null;

    if (!callControlId) {
      console.warn("[call-logger] No call_control_id in webhook, skipping");
      return null;
    }

    // Determine username for this call
    const username = await determineCallUsername(payload);

    // Check if call already exists (gracefully handle missing calls table)
    let existingCall = null;
    try {
      existingCall = await PgDb.findCallByCallControlId(callControlId);
    } catch (err) {
      // If calls table doesn't exist, that's okay - just skip call logging
      if (err.code === "42P01") {
        console.debug(
          "[call-logger] Calls table not found, skipping call logging"
        );
        return null;
      }
      // Re-throw other errors
      throw err;
    }

    // If table doesn't exist, findCallByCallControlId returns null, but we should check
    // if subsequent operations will fail. For now, if existingCall is null and we can't
    // insert, we'll handle it in the insertCall/updateCallByCallControlId methods

    // Detect if this is a WebRTC call by checking:
    // 1. connection_id against user credentials, OR
    // 2. custom_headers for X-RTC-CALLID (indicates WebRTC call)
    const isWebrtc = await (async () => {
      // Check for X-RTC-CALLID header (definitive WebRTC indicator)
      const customHeaders = payload?.custom_headers || [];
      const hasRtcHeader = customHeaders.some(
        (h) => h?.name === "X-RTC-CALLID" || h?.name === "X-RTC-SESSID"
      );
      if (hasRtcHeader) return true;

      // Also check connection_id against user credentials
      const pool = getPostgresPool();
      if (!pool) return false;
      const connectionId = payload?.connection_id;
      if (!connectionId) return false;
      try {
        const r = await pool.query(
          "SELECT COUNT(*) as c FROM users WHERE telephony_credentials_id=$1",
          [String(connectionId)]
        );
        return Number(r.rows?.[0]?.c || 0) > 0;
      } catch {
        return false;
      }
    })();

    if (eventType === "call.initiated") {
      let callId;
      if (existingCall) {
        // Update existing call with initiated event
        await PgDb.updateCallByCallControlId(callControlId, {
          state: payload?.state || "initiated",
          startTime: payload?.start_time || new Date().toISOString(),
          webhooks: [...(existingCall.webhooks || []), webhookData],
        });
        callId = existingCall.id;
      } else {
        // Create new call record with proper start_time
        const startTime =
          payload?.start_time ||
          payload?.occurred_at ||
          new Date().toISOString();
        callId = await PgDb.insertCall({
          username,
          callControlId,
          callLegId: payload?.call_leg_id || null,
          callSessionId: payload?.call_session_id || null,
          direction: payload?.direction || null,
          state: payload?.state || "initiated",
          to: payload?.to || null,
          from: payload?.from || null,
          startTime,
          connectionId: payload?.connection_id || null,
          isWebrtc,
          webhooks: [webhookData],
        });
      }

      return callId;
    }

    if (eventType === "call.answered") {
      if (existingCall) {
        const answerTime =
          payload?.start_time ||
          payload?.occurred_at ||
          new Date().toISOString();
        await PgDb.updateCallByCallControlId(callControlId, {
          state: payload?.state || "answered",
          answerTime,
          // Ensure start_time is set if it wasn't set during call.initiated
          ...(existingCall.start_time ? {} : { startTime: answerTime }),
          webhooks: [...(existingCall.webhooks || []), webhookData],
        });

        return existingCall.id;
      } else {
        // Create new call record if it doesn't exist (missed call.initiated)
        const timestamp =
          payload?.start_time ||
          payload?.occurred_at ||
          new Date().toISOString();
        const callId = await PgDb.insertCall({
          username,
          callControlId,
          callLegId: payload?.call_leg_id || null,
          callSessionId: payload?.call_session_id || null,
          direction: payload?.direction || null,
          state: payload?.state || "answered",
          to: payload?.to || null,
          from: payload?.from || null,
          startTime: timestamp,
          answerTime: timestamp,
          connectionId: payload?.connection_id || null,
          isWebrtc,
          webhooks: [webhookData],
        });
        return callId;
      }
    }

    if (eventType === "call.hangup") {
      if (existingCall) {
        const endTime =
          payload?.end_time || payload?.occurred_at || new Date().toISOString();
        const startTime = existingCall.start_time || existingCall.created_at;
        const answerTime = existingCall.answer_time || startTime;

        // Calculate duration in seconds
        let durationSeconds = null;
        let talkTimeSeconds = null;
        if (startTime && endTime) {
          const start = new Date(startTime);
          const end = new Date(endTime);
          durationSeconds = Math.floor((end - start) / 1000);
        }
        if (answerTime && endTime) {
          const answered = new Date(answerTime);
          const ended = new Date(endTime);
          talkTimeSeconds = Math.floor((ended - answered) / 1000);
        }

        await PgDb.updateCallByCallControlId(callControlId, {
          state: "hangup",
          endTime,
          durationSeconds,
          hangupCause: payload?.hangup_cause || null,
          hangupSource: payload?.hangup_source || null,
          // Ensure start_time is set if it wasn't set earlier
          ...(existingCall.start_time
            ? {}
            : {
                startTime: new Date(
                  Date.now() - (durationSeconds || 0) * 1000
                ).toISOString(),
              }),
          webhooks: [...(existingCall.webhooks || []), webhookData],
        });

        return existingCall.id;
      } else {
        // Create call record even if we missed earlier events
        const endTime =
          payload?.end_time || payload?.occurred_at || new Date().toISOString();
        const startTime =
          payload?.start_time || new Date(Date.now() - 60000).toISOString(); // Default to 1 min ago
        const callId = await PgDb.insertCall({
          username,
          callControlId,
          callLegId: payload?.call_leg_id || null,
          callSessionId: payload?.call_session_id || null,
          direction: payload?.direction || null,
          state: "hangup",
          to: payload?.to || null,
          from: payload?.from || null,
          startTime,
          endTime,
          hangupCause: payload?.hangup_cause || null,
          hangupSource: payload?.hangup_source || null,
          connectionId: payload?.connection_id || null,
          isWebrtc,
          webhooks: [webhookData],
        });
        return callId;
      }
    }

    // For other events, just append to webhooks if call exists
    if (existingCall) {
      await PgDb.updateCallByCallControlId(callControlId, {
        webhooks: [...(existingCall.webhooks || []), webhookData],
      });
      return existingCall.id;
    }

    return null;
  } catch (err) {
    console.error("[call-logger] Error logging call:", err);
    return null;
  }
}
