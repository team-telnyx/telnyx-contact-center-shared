/**
 * Queue Audio Service
 * Manages audio playback for calls waiting in queues
 */

import { buildTelnyxV2Url } from "@/lib/telnyx";
import { getPostgresPool } from "@/lib/postgres.mjs";

// Store active queue audio sessions
// Format: { callControlId: { queueId, mediaName, positionInterval, positionTimer, audioTimer } }
const activeSessions = new Map();

function getApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY environment variable is required");
  }
  return apiKey;
}

/**
 * Start queue audio for a call
 * @param {string} callControlId - Call control ID
 * @param {string} queueId - Queue ID
 * @param {Object} queueConfig - Queue configuration with audio settings
 * @param {number} currentPosition - Current position in queue
 */
export async function startQueueAudio(
  callControlId,
  queueId,
  queueConfig,
  currentPosition = null
) {
  if (!callControlId || !queueId) {
    console.warn("[QueueAudio] Missing callControlId or queueId");
    return;
  }

  const mediaName = queueConfig?.queue_audio_media_name;
  if (!mediaName) {
    console.log("[QueueAudio] No media configured for queue:", queueId);
    return;
  }

  try {
    // Store session info first
    const session = {
      queueId,
      mediaName,
      callControlId,
      positionInterval: queueConfig?.queue_audio_position_interval_secs || 60,
      enablePosition: queueConfig?.queue_audio_enable_position || false,
      ttsVoice: queueConfig?.queue_audio_tts_voice || null,
      ttsVoiceApiKeyRef: queueConfig?.queue_audio_tts_voice_api_key_ref || null,
      currentPosition: currentPosition,
      positionTimer: null,
      isSpeaking: false, // Track if position announcement is currently playing
      playbackPaused: false, // Track if playback was paused for announcement
      mediaStarted: false, // Track if media playback has been started
    };

    activeSessions.set(callControlId, session);

    // Normalize position: ensure it's at least 1 (not 0)
    const normalizedPosition =
      currentPosition !== null &&
      currentPosition !== undefined &&
      currentPosition > 0
        ? currentPosition
        : 1; // Default to 1 if position is 0, null, or undefined
    
    session.currentPosition = normalizedPosition;

    // If position announcements are enabled, play position first, then start media
    if (session.enablePosition && session.ttsVoice) {
      console.log(
        `[QueueAudio] Position announcements enabled. Playing position first, then starting media for call ${callControlId}`
      );
      
      // Play position announcement first (don't await, let it run in background)
      // Media will start after call.speak.ended webhook
      announceQueuePosition(
        callControlId,
        normalizedPosition,
        session.ttsVoice,
        session.ttsVoiceApiKeyRef
      ).catch((err) => {
        console.error(
          `[QueueAudio] Error in initial position announcement:`,
          err
        );
        // If position announcement fails, start media anyway
        startMediaPlayback(callControlId, session);
      });
      
      // Schedule recurring announcements
      schedulePositionAnnouncement(callControlId, session, normalizedPosition);
    } else {
      // No position announcements, start media immediately
      console.log(
        `[QueueAudio] Position announcements disabled or TTS voice not configured. Starting media immediately. enablePosition: ${session.enablePosition}, ttsVoice: ${session.ttsVoice ? "set" : "not set"}`
      );
      await startMediaPlayback(callControlId, session);
    }
  } catch (err) {
    console.error("[QueueAudio] Error starting queue audio:", err);
  }
}

/**
 * Stop queue audio for a call
 * @param {string} callControlId - Call control ID
 */
export async function stopQueueAudio(callControlId) {
  if (!callControlId) return;

  const session = activeSessions.get(callControlId);
  if (!session) {
    return; // No active session
  }

  try {
    // Clear position announcement timer
    if (session.positionTimer) {
      clearTimeout(session.positionTimer);
      session.positionTimer = null;
    }

    // Stop playback
    const apiKey = getApiKey();
    const url = buildTelnyxV2Url(
      `/calls/${encodeURIComponent(callControlId)}/actions/playback_stop`
    );

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        stop: "all", // Stop all audio
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error(
        "[QueueAudio] Failed to stop playback:",
        errorData?.errors?.[0]?.detail || errorData?.message || response.statusText
      );
    } else {
      console.log(
        `[QueueAudio] Stopped queue audio for call ${callControlId}`
      );
    }

    // Remove session
    activeSessions.delete(callControlId);
  } catch (err) {
    console.error("[QueueAudio] Error stopping queue audio:", err);
    // Remove session even on error
    activeSessions.delete(callControlId);
  }
}

/**
 * Start media playback for a queue session
 * @param {string} callControlId - Call control ID
 * @param {Object} session - Session object
 */
async function startMediaPlayback(callControlId, session) {
  if (!callControlId || !session) {
    return;
  }

  try {
    const apiKey = getApiKey();
    const url = buildTelnyxV2Url(
      `/calls/${encodeURIComponent(callControlId)}/actions/playback_start`
    );

    // Start playing media in loop
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        media_name: session.mediaName,
        loop: "infinity", // Loop indefinitely
        overlay: false,
        target_legs: "self", // Play to the caller
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error(
        "[QueueAudio] Failed to start media playback:",
        errorData?.errors?.[0]?.detail || errorData?.message || response.statusText
      );
      return;
    }

    console.log(
      `[QueueAudio] Started media playback for call ${callControlId}`
    );
    session.mediaStarted = true;
  } catch (err) {
    console.error("[QueueAudio] Error starting media playback:", err);
  }
}

/**
 * Update queue position for a call
 * @param {string} callControlId - Call control ID
 * @param {number} newPosition - New position in queue
 */
export async function updateQueuePosition(callControlId, newPosition) {
  if (!callControlId) return;

  const session = activeSessions.get(callControlId);
  if (!session || !session.enablePosition) {
    return; // No active session or position announcements disabled
  }

  const oldPosition = session.currentPosition;
  // Normalize position: ensure it's at least 1 (not 0)
  const normalizedPosition =
    newPosition !== null && newPosition !== undefined && newPosition > 0
      ? newPosition
      : 1; // Default to 1 if position is 0, null, or undefined
  session.currentPosition = normalizedPosition;

  console.log(
    `[QueueAudio] Updated position for call ${callControlId}: ${oldPosition} -> ${normalizedPosition}`
  );

  // Position announcements are scheduled, so we just update the stored position
  // The next scheduled announcement will use the updated position
}

/**
 * Schedule position announcement
 * @param {string} callControlId - Call control ID
 * @param {Object} session - Session object
 * @param {number} position - Current position
 */
async function schedulePositionAnnouncement(callControlId, session, position) {
  if (!session.enablePosition || !session.ttsVoice) {
    console.log(
      `[QueueAudio] Cannot schedule announcement: enablePosition=${session.enablePosition}, ttsVoice=${session.ttsVoice ? "set" : "not set"}`
    );
    return;
  }

  // Clear existing timer
  if (session.positionTimer) {
    clearTimeout(session.positionTimer);
    session.positionTimer = null;
  }

  const intervalMs = session.positionInterval * 1000;
  console.log(
    `[QueueAudio] Scheduling position announcement in ${session.positionInterval}s for call ${callControlId}, current position: ${position}`
  );

  // Schedule next announcement
  session.positionTimer = setTimeout(async () => {
    const currentSession = activeSessions.get(callControlId);
    if (!currentSession) {
      console.log(
        `[QueueAudio] Session not found for call ${callControlId}, stopping announcements`
      );
      return; // Session was stopped
    }

    let positionToAnnounce = currentSession.currentPosition;
    const originalPosition = positionToAnnounce;
    console.log(
      `[QueueAudio] Timer fired for call ${callControlId}, position to announce: ${positionToAnnounce}`
    );

    // Normalize position: ensure it's at least 1 (not 0)
    // If position is 0, null, or undefined, set it to 1 for a single call in queue
    if (
      positionToAnnounce === null ||
      positionToAnnounce === undefined ||
      positionToAnnounce === 0
    ) {
      positionToAnnounce = 1;
      currentSession.currentPosition = 1;
      console.log(
        `[QueueAudio] Position normalized to 1 for call ${callControlId} (was: ${originalPosition})`
      );
    }

    console.log(
      `[QueueAudio] Announcing position ${positionToAnnounce} for call ${callControlId}`
    );
    
    // Stop media playback before announcing position
    if (currentSession.mediaStarted && !currentSession.playbackPaused) {
      try {
        const apiKey = getApiKey();
        const stopUrl = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/playback_stop`
        );

        const stopResponse = await fetch(stopUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            stop: "all", // Stop all audio
          }),
        });

        if (stopResponse.ok) {
          currentSession.playbackPaused = true;
          console.log(
            `[QueueAudio] Stopped media before position announcement for call ${callControlId}`
          );
        }
      } catch (err) {
        console.error("[QueueAudio] Error stopping media before announcement:", err);
      }
    }
    
    await announceQueuePosition(
      callControlId,
      positionToAnnounce,
      currentSession.ttsVoice,
      currentSession.ttsVoiceApiKeyRef
    );

    // Schedule next announcement
    console.log(
      `[QueueAudio] Scheduling next position announcement in ${currentSession.positionInterval}s for call ${callControlId}`
    );
    schedulePositionAnnouncement(
      callControlId,
      currentSession,
      positionToAnnounce
    );
  }, intervalMs);
}

/**
 * Resume media playback after position announcement
 * @param {string} callControlId - Call control ID
 */
export async function resumeQueueMedia(callControlId) {
  if (!callControlId) {
    console.log(`[QueueAudio] resumeQueueMedia called with no callControlId`);
    return null;
  }

  const session = activeSessions.get(callControlId);
  if (!session) {
    console.log(
      `[QueueAudio] No active session found for call ${callControlId} when trying to resume media`
    );
    return null; // No active session
  }

  console.log(
    `[QueueAudio] Resuming media for call ${callControlId}, isSpeaking: ${session.isSpeaking}, playbackPaused: ${session.playbackPaused}, mediaStarted: ${session.mediaStarted}`
  );

  // Clear speaking flag
  session.isSpeaking = false;

  // Start or resume media playback (always start/resume, regardless of state)
  await startMediaPlayback(callControlId, session);
  
  session.playbackPaused = false;
  return session;
}

/**
 * Announce queue position using TTS
 * @param {string} callControlId - Call control ID
 * @param {number} position - Position in queue
 * @param {string} ttsVoice - TTS voice string
 * @param {string} ttsVoiceApiKeyRef - API key reference for voice provider
 */
async function announceQueuePosition(
  callControlId,
  position,
  ttsVoice,
  ttsVoiceApiKeyRef
) {
  if (!callControlId || position === null || position === undefined) {
    return;
  }

  const session = activeSessions.get(callControlId);
  if (!session) {
    console.warn(
      `[QueueAudio] No session found for call ${callControlId} when trying to announce position`
    );
    return;
  }

  // Mark that we're about to speak
  session.isSpeaking = true;

  try {
    const apiKey = getApiKey();
    
    // Stop playback before speaking (if media is playing)
    if (session.mediaStarted && !session.playbackPaused) {
      const stopUrl = buildTelnyxV2Url(
        `/calls/${encodeURIComponent(callControlId)}/actions/playback_stop`
      );

      const stopResponse = await fetch(stopUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          stop: "all", // Stop all audio
        }),
      });

      if (stopResponse.ok) {
        session.playbackPaused = true;
        console.log(
          `[QueueAudio] Stopped playback before position announcement for call ${callControlId}`
        );
      } else {
        const errorData = await stopResponse.json().catch(() => ({}));
        console.warn(
          "[QueueAudio] Failed to stop playback before announcement:",
          errorData?.errors?.[0]?.detail || errorData?.message || stopResponse.statusText
        );
      }
    }
    
    // Get API key reference value if needed
    let voiceApiKey = null;
    if (ttsVoiceApiKeyRef) {
      const pool = getPostgresPool();
      if (pool) {
        const secretRes = await pool.query(
          `SELECT value FROM secrets WHERE identifier = $1 AND type = 'api_key'`,
          [ttsVoiceApiKeyRef]
        );
        if (secretRes.rows?.[0]?.value) {
          voiceApiKey = secretRes.rows[0].value;
        }
      }
    }

    // Parse voice string (Provider.Model.VoiceId format)
    const parts = ttsVoice.split(".");
    const provider = parts[0] || "";
    const model = parts.length >= 3 ? parts[1] : "";
    const voiceId = parts.length >= 3 ? parts.slice(2).join(".") : parts[1] || "";

    // Build speak payload
    const speakPayload = {
      payload: `your current position in a queue is ${position}`,
      voice: ttsVoice,
    };

    // Add API key if provided (for ElevenLabs)
    if (voiceApiKey && provider === "ElevenLabs") {
      speakPayload.voice_api_key = voiceApiKey;
    }
    const url = buildTelnyxV2Url(
      `/calls/${encodeURIComponent(callControlId)}/actions/speak`
    );

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(speakPayload),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error(
        "[QueueAudio] Failed to announce position:",
        errorData?.errors?.[0]?.detail || errorData?.message || response.statusText
      );
      // If speak failed, resume playback
      session.isSpeaking = false;
      if (session.playbackPaused) {
        await resumeQueueMedia(callControlId);
      }
    } else {
      console.log(
        `[QueueAudio] Announced position ${position} for call ${callControlId}. Waiting for call.speak.ended to resume playback.`
      );
      // Note: We don't resume playback here - we wait for call.speak.ended webhook
      // The webhook handler will call resumeQueueMedia when speak ends
    }
  } catch (err) {
    console.error("[QueueAudio] Error announcing position:", err);
    // If speak failed, resume playback
    session.isSpeaking = false;
    if (session.playbackPaused) {
      await resumeQueueMedia(callControlId);
    }
  }
}

/**
 * Get active session for a call
 * @param {string} callControlId - Call control ID
 * @returns {Object|null} Session object or null
 */
export function getActiveSession(callControlId) {
  return activeSessions.get(callControlId) || null;
}

/**
 * Clean up all sessions (for testing/debugging)
 */
export function clearAllSessions() {
  activeSessions.clear();
}

