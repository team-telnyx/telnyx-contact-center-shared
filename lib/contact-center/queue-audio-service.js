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
    return;
  }

  const mediaName = queueConfig?.queue_audio_media_name;
  if (!mediaName) {
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
      firstAnnouncement: true, // Track if this is the first position announcement
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
      // Play position announcement first with 2-second delay for the first announcement
      // Media will start after call.speak.ended webhook
      setTimeout(() => {
        announceQueuePosition(
          callControlId,
          normalizedPosition,
          session.ttsVoice,
          session.ttsVoiceApiKeyRef
        ).catch((err) => {
          // If position announcement fails, start media anyway
          startMediaPlayback(callControlId, session);
        });
        // Mark that first announcement has been made
        const currentSession = activeSessions.get(callControlId);
        if (currentSession) {
          currentSession.firstAnnouncement = false;
        }
      }, 2000); // 2-second delay before first position announcement

      // Schedule recurring announcements
      schedulePositionAnnouncement(callControlId, session, normalizedPosition);
    } else {
      // No position announcements, start media immediately
      await startMediaPlayback(callControlId, session);
    }
  } catch (err) {
    // Error starting queue audio
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
      // Failed to stop playback
    }

    // Remove session
    activeSessions.delete(callControlId);
  } catch (err) {
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
      return;
    }

    session.mediaStarted = true;
  } catch (err) {
    // Error starting media playback
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
    return;
  }

  // Clear existing timer
  if (session.positionTimer) {
    clearTimeout(session.positionTimer);
    session.positionTimer = null;
  }

  const intervalMs = session.positionInterval * 1000;

  // Schedule next announcement
  session.positionTimer = setTimeout(async () => {
    const currentSession = activeSessions.get(callControlId);
    if (!currentSession) {
      return; // Session was stopped
    }

    let positionToAnnounce = currentSession.currentPosition;

    // Normalize position: ensure it's at least 1 (not 0)
    // If position is 0, null, or undefined, set it to 1 for a single call in queue
    if (
      positionToAnnounce === null ||
      positionToAnnounce === undefined ||
      positionToAnnounce === 0
    ) {
      positionToAnnounce = 1;
      currentSession.currentPosition = 1;
    }

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
        }
      } catch (err) {
        // Error stopping media before announcement
      }
    }

    await announceQueuePosition(
      callControlId,
      positionToAnnounce,
      currentSession.ttsVoice,
      currentSession.ttsVoiceApiKeyRef
    );

    // Schedule next announcement
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
    return null;
  }

  const session = activeSessions.get(callControlId);
  if (!session) {
    return null; // No active session
  }

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
    const voiceId =
      parts.length >= 3 ? parts.slice(2).join(".") : parts[1] || "";

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
      // If speak failed, resume playback
      session.isSpeaking = false;
      if (session.playbackPaused) {
        await resumeQueueMedia(callControlId);
      }
    } else {
      // Note: We don't resume playback here - we wait for call.speak.ended webhook
      // The webhook handler will call resumeQueueMedia when speak ends
    }
  } catch (err) {
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
