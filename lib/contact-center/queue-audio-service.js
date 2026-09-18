/**
 * Queue Audio Service
 * Manages audio playback for calls waiting in queues
 */

import { randomUUID } from "node:crypto";

import { buildTelnyxV2Url } from "../telnyx.js";
import { getPostgresPool } from "../postgres.mjs";
import {
  callPayload,
  contactCenterErrorPayload,
  queuePayload,
  queuesLogger,
} from "./logging.mjs";

// Store active queue audio sessions
// Format: { callControlId: { queueId, mediaName, positionInterval, positionTimer, audioTimer } }
const activeSessions = new Map();
const QUEUE_AUDIO_CLIENT_STATE_KEY = "__cc_queue_audio";
const PROVIDER_AUDIO_COMMAND_TIMEOUT_MS = 2_000;
const ANNOUNCEMENT_RECOVERY_TIMEOUT_MS = 15_000;

function decodeClientState(clientState) {
  if (!clientState || typeof clientState !== "string") return {};
  try {
    const decoded = JSON.parse(Buffer.from(clientState, "base64").toString("utf8"));
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? decoded
      : {};
  } catch {
    return {};
  }
}

function buildAnnouncementClientState(
  baseClientState,
  { announcementId, resumeCommandId, queueId, mediaName },
) {
  const state = decodeClientState(baseClientState);
  return Buffer.from(
    JSON.stringify({
      ...state,
      [QUEUE_AUDIO_CLIENT_STATE_KEY]: {
        type: "queue_position",
        announcement_id: announcementId,
        resume_command_id: resumeCommandId,
        queue_id: queueId,
        media_name: mediaName,
      },
    }),
  ).toString("base64");
}

function removeQueueAudioMarker(clientState) {
  const state = decodeClientState(clientState);
  delete state[QUEUE_AUDIO_CLIENT_STATE_KEY];
  return Buffer.from(JSON.stringify(state)).toString("base64");
}

export function getQueueAudioMarker(clientState) {
  const marker = decodeClientState(clientState)[QUEUE_AUDIO_CLIENT_STATE_KEY];
  if (
    marker?.type !== "queue_position" ||
    !marker?.announcement_id ||
    !marker?.resume_command_id ||
    !marker?.queue_id ||
    !marker?.media_name
  ) {
    return null;
  }
  return {
    announcementId: String(marker.announcement_id),
    resumeCommandId: String(marker.resume_command_id),
    queueId: String(marker.queue_id),
    mediaName: String(marker.media_name),
  };
}

export function isQueuePositionClientState(clientState) {
  return Boolean(getQueueAudioMarker(clientState));
}

async function fetchProviderAudio(
  url,
  options,
  timeoutMs = PROVIDER_AUDIO_COMMAND_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    const error = new Error("Provider audio command timed out");
    error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableProviderStatus(status) {
  const numericStatus = Number(status);
  return numericStatus === 429 || numericStatus >= 500;
}

function isRetryableProviderError(error) {
  if (!error) return false;
  if (["TimeoutError", "AbortError", "TypeError"].includes(error.name)) {
    return true;
  }
  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ETIMEDOUT",
  ].includes(error.code);
}

function providerFailure(response = null, error = null) {
  return {
    ok: false,
    retryable: error
      ? isRetryableProviderError(error)
      : isRetryableProviderStatus(response?.status),
    status: response?.status ?? null,
    error,
  };
}

async function updateProviderClientState(callControlId, clientState) {
  const apiKey = getApiKey();
  const url = buildTelnyxV2Url(
    `/calls/${encodeURIComponent(callControlId)}/actions/client_state_update`,
  );
  let failure = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response = null;
    let requestError = null;
    try {
      response = await fetchProviderAudio(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ client_state: clientState }),
      });
    } catch (err) {
      requestError = err;
    }

    if (response?.ok) return { ok: true, retryable: false };
    failure = providerFailure(response, requestError);
    if (!failure.retryable || attempt === 1) return failure;
  }

  return failure || { ok: false, retryable: false };
}

// Read the caller and the waiting population in one database snapshot. The
// queue is shared by voice and messaging; offered/active work no longer waits.
export async function readQueueAudioContext(db, callControlId) {
  const result = await db.query(
    `SELECT w.state, w.queue_id, q.queue_audio_media_name AS media_name,
            CASE WHEN w.state = 'queued' THEN (
              SELECT count(*)::int + 1 FROM acd_work_items waiting
               WHERE waiting.queue_id = w.queue_id AND waiting.state = 'queued'
                 AND waiting.enqueued_at < w.enqueued_at
            ) END AS position
       FROM acd_legs l
       JOIN acd_work_items w ON w.id = l.work_item_id
       LEFT JOIN cc_queues q ON q.id = w.queue_id
      WHERE l.provider_call_id = $1 AND l.role = 'customer'
        AND l.ended_at IS NULL
      ORDER BY l.created_at DESC LIMIT 1`,
    [callControlId],
  );
  const row = result.rows[0];
  return {
    allowed: row?.state === 'queued',
    known: Boolean(row),
    queueId: row?.queue_id ? String(row.queue_id) : null,
    mediaName: row?.media_name ? String(row.media_name) : null,
    position: row?.position ?? null,
  };
}

async function loadQueueAudioContext(callControlId) {
  const pool = getPostgresPool();
  if (!pool || !callControlId) {
    return { allowed: true, known: false, queueId: null, mediaName: null };
  }
  try {
    return await readQueueAudioContext(pool, callControlId);
  } catch (err) {
    queuesLogger.warn("queue_audio_guard_failed", {
      ...callPayload({ callControlId }),
      ...contactCenterErrorPayload(err),
    });
    return { allowed: false, known: false, queueId: null, mediaName: null };
  }
}

function contextAllowsQueueAudio(context, expected = null) {
  if (!context.allowed) return false;
  if (!expected || !context.known) return true;
  return (
    context.queueId === expected.queueId &&
    context.mediaName === expected.mediaName
  );
}

async function isQueueAudioAllowed(callControlId, expected = null) {
  const context = await (expected?.loadContext || loadQueueAudioContext)(callControlId);
  return contextAllowsQueueAudio(context, expected);
}

async function ensureCurrentAndAllowed(callControlId, session) {
  if (activeSessions.get(callControlId) !== session) return false;
  const context = await (session.loadContext || loadQueueAudioContext)(callControlId);
  if (activeSessions.get(callControlId) !== session) return false;
  if (!contextAllowsQueueAudio(context, session)) {
    cancelQueueAudioSession(callControlId);
    return false;
  }
  if (Number.isInteger(context.position) && context.position > 0) {
    session.currentPosition = context.position;
  }
  return true;
}

function getApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY environment variable is required");
  }
  return apiKey;
}

async function stopProviderAudio(
  callControlId,
  timeoutMs = PROVIDER_AUDIO_COMMAND_TIMEOUT_MS,
) {
  const apiKey = getApiKey();
  const url = buildTelnyxV2Url(
    `/calls/${encodeURIComponent(callControlId)}/actions/playback_stop`,
  );
  const response = await fetchProviderAudio(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ stop: "all" }),
  }, timeoutMs);
  return response.ok;
}

function stopLateProviderAudio(callControlId) {
  void stopProviderAudio(callControlId).catch((err) => {
    queuesLogger.warn("queue_audio_late_effect_cleanup_failed", {
      ...callPayload({ callControlId }),
      ...contactCenterErrorPayload(err),
    });
  });
}

function clearAnnouncementRecoveryTimer(session) {
  if (!session?.announcementRecoveryTimer) return;
  clearTimeout(session.announcementRecoveryTimer);
  session.announcementRecoveryTimer = null;
}

function resetAnnouncementLifecycle(session) {
  clearAnnouncementRecoveryTimer(session);
  session.announcementPending = false;
  session.pendingAnnouncementId = null;
  session.activeAnnouncementId = null;
  session.pendingAnnouncementClientState = null;
  session.pendingResumeCommandId = null;
  session.terminalResumeFailure = false;
  session.terminalResumeStatus = null;
  session.isSpeaking = false;
}

function sessionMatchesMarker(session, marker) {
  return Boolean(
    session &&
      marker &&
      marker.queueId === session.queueId &&
      marker.mediaName === session.mediaName &&
      (marker.announcementId === session.pendingAnnouncementId ||
        marker.announcementId === session.activeAnnouncementId),
  );
}

function scheduleAnnouncementRecovery(callControlId, session) {
  clearAnnouncementRecoveryTimer(session);
  if (!session?.pendingAnnouncementClientState) return;

  session.announcementRecoveryTimer = setTimeout(async () => {
    session.announcementRecoveryTimer = null;
    if (activeSessions.get(callControlId) !== session) return;

    const marker = getQueueAudioMarker(session.pendingAnnouncementClientState);
    if (!sessionMatchesMarker(session, marker)) return;

    try {
      const result = await resumeQueueMedia(
        callControlId,
        session.pendingAnnouncementClientState,
      );
      if (
        result?.matched &&
        !result.resumed &&
        result.retryable &&
        activeSessions.get(callControlId) === session &&
        sessionMatchesMarker(session, marker)
      ) {
        scheduleAnnouncementRecovery(callControlId, session);
      }
    } catch (err) {
      queuesLogger.warn("queue_announcement_recovery_failed", {
        ...callPayload({ callControlId }),
        ...queuePayload({ queueId: session.queueId }),
        ...contactCenterErrorPayload(err),
      });
      if (
        activeSessions.get(callControlId) === session &&
        sessionMatchesMarker(session, marker)
      ) {
        scheduleAnnouncementRecovery(callControlId, session);
      }
    }
  }, session.announcementRecoveryMs);
  session.announcementRecoveryTimer.unref?.();
}

async function finishLocalPermanentResume(
  callControlId,
  session,
  marker,
  restoredClientState,
  { status = null, cleanupAttempted = false } = {},
) {
  let cleanup = { ok: false, retryable: false };
  if (!cleanupAttempted) {
    try {
      cleanup = await updateProviderClientState(
        callControlId,
        restoredClientState,
      );
    } catch (err) {
      cleanup = { ok: false, retryable: false, error: err };
    }
  }

  if (activeSessions.get(callControlId) !== session) return null;
  if (cleanup.retryable) {
    session.terminalResumeFailure = true;
    session.terminalResumeStatus = status;
    scheduleAnnouncementRecovery(callControlId, session);
    return {
      matched: true,
      resumed: false,
      retryable: true,
      remote: false,
      cleanupOnly: true,
      ...marker,
    };
  }

  // A permanent provider rejection means this audio session cannot recover.
  // Remove all local timers/state after the best-effort marker cleanup while
  // leaving call routing itself untouched.
  cancelQueueAudioSession(callControlId);
  return {
    matched: true,
    resumed: false,
    retryable: false,
    terminal: true,
    markerCleared: cleanup.ok,
    providerStatus: status,
    remote: false,
    ...marker,
  };
}

/**
 * Start queue audio for a call
 * @param {string} callControlId - Call control ID
 * @param {string} queueId - Queue ID
 * @param {Object} queueConfig - Queue configuration with audio settings
 * @param {number} currentPosition - Current position in queue
 * @param {Object} options - Optional call context used to correlate provider webhooks
 */
export async function startQueueAudio(
  callControlId,
  queueId,
  queueConfig,
  currentPosition = null,
  {
    clientState = null,
    announcementRecoveryMs = ANNOUNCEMENT_RECOVERY_TIMEOUT_MS,
    deduplicate = false,
    loadContext = loadQueueAudioContext,
  } = {},
) {
  if (!callControlId || !queueId) {
    return;
  }

  const mediaName = queueConfig?.queue_audio_media_name;
  if (!mediaName) {
    return;
  }

  const normalizedPosition =
    currentPosition !== null &&
    currentPosition !== undefined &&
    currentPosition > 0
      ? currentPosition
      : 1;

  let startingSession = null;
  try {
    const existingSession = activeSessions.get(callControlId);
    const requestedInterval =
      queueConfig?.queue_audio_position_interval_secs ?? 60;
    const sameConfiguration =
      existingSession &&
      String(existingSession.queueId) === String(queueId) &&
      existingSession.mediaName === mediaName &&
      existingSession.enablePosition ===
        Boolean(queueConfig?.queue_audio_enable_position) &&
      existingSession.ttsVoice ===
        (queueConfig?.queue_audio_tts_voice || null) &&
      existingSession.ttsVoiceApiKeyRef ===
        (queueConfig?.queue_audio_tts_voice_api_key_ref || null) &&
      Number(existingSession.positionInterval) === Number(requestedInterval);

    // The no-answer saga starts queue audio as soon as the requeue commits.
    // Telnyx then delivers call.enqueued evidence for the same transition.
    // Treat that second, identical start as an update so it cannot interrupt
    // the first announcement and enqueue the position prompt twice.
    const hasActiveAudioEffect =
      existingSession?.startPending ||
      existingSession?.mediaStarted ||
      existingSession?.announcementPending ||
      existingSession?.isSpeaking;
    if (deduplicate && sameConfiguration && hasActiveAudioEffect) {
      existingSession.currentPosition = normalizedPosition;
      return existingSession;
    }

    if (existingSession) {
      if (existingSession.positionTimer) {
        clearTimeout(existingSession.positionTimer);
        existingSession.positionTimer = null;
      }
      clearAnnouncementRecoveryTimer(existingSession);
    }

    // Install the replacement before provider I/O. The object identity is the
    // generation fence: a concurrent stop/restart makes every older await
    // continuation harmless.
    const session = {
      generation: randomUUID(),
      loadContext,
      queueId,
      mediaName,
      callControlId,
      positionInterval: requestedInterval,
      enablePosition: queueConfig?.queue_audio_enable_position || false,
      ttsVoice: queueConfig?.queue_audio_tts_voice || null,
      ttsVoiceApiKeyRef: queueConfig?.queue_audio_tts_voice_api_key_ref || null,
      currentPosition: normalizedPosition,
      positionTimer: null,
      announcementPending: false,
      pendingAnnouncementId: null,
      activeAnnouncementId: null,
      pendingAnnouncementClientState: null,
      pendingResumeCommandId: null,
      terminalResumeFailure: false,
      terminalResumeStatus: null,
      announcementRecoveryTimer: null,
      announcementRecoveryMs:
        Number.isFinite(Number(announcementRecoveryMs)) &&
        Number(announcementRecoveryMs) > 0
          ? Number(announcementRecoveryMs)
          : ANNOUNCEMENT_RECOVERY_TIMEOUT_MS,
      isSpeaking: false,
      playbackPaused: false,
      mediaStarted: false,
      startPending: true,
      baseClientState: clientState,
    };
    startingSession = session;
    activeSessions.set(callControlId, session);

    // Re-enqueue may replace an older generation whose media is still active.
    if (existingSession) {
      try {
        const apiKey = getApiKey();
        const stopUrl = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}/actions/playback_stop`,
        );
        await fetchProviderAudio(stopUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            stop: "all",
          }),
        });
      } catch {}
      if (!(await ensureCurrentAndAllowed(callControlId, session))) return;
    } else if (!(await ensureCurrentAndAllowed(callControlId, session))) {
      return;
    }

    // If position announcements are enabled, play position first, then start media
    if (session.enablePosition && session.ttsVoice) {
      // Start the first position announcement immediately. Music starts only
      // after the matching call.speak.ended webhook is received.
      const announced = await announceQueuePosition(
        callControlId,
        normalizedPosition,
        session.ttsVoice,
        session.ttsVoiceApiKeyRef,
      );

      if (activeSessions.get(callControlId) !== session) {
        return;
      }

      // Do not leave the caller in silence if the provider rejected TTS.
      if (!announced) {
        await startMediaPlayback(callControlId, session);
      }

      if (activeSessions.get(callControlId) !== session) return;

      // Schedule recurring announcements
      schedulePositionAnnouncement(callControlId, session, normalizedPosition);
    } else {
      // No position announcements, start media immediately
      await startMediaPlayback(callControlId, session);
    }
    session.startPending = false;
    return session;
  } catch (err) {
    if (activeSessions.get(callControlId) === startingSession) {
      startingSession.startPending = false;
    }
    // Error starting queue audio
  }
}

/**
 * Stop queue audio for a call
 * @param {string} callControlId - Call control ID
 * @param {Object} options - Provider command options
 */
export async function stopQueueAudio(
  callControlId,
  { timeoutMs = PROVIDER_AUDIO_COMMAND_TIMEOUT_MS } = {},
) {
  if (!callControlId) return false;

  // Delete before provider I/O so local timers/webhooks cannot resume media.
  cancelQueueAudioSession(callControlId);

  try {
    return await stopProviderAudio(callControlId, timeoutMs);
  } catch (err) {
    queuesLogger.warn("queue_audio_stop_failed", {
      ...callPayload({ callControlId }),
      ...contactCenterErrorPayload(err),
    });
    return false;
  }
}

/** Cancel only this process's queue-audio work; durable sagas stop provider media. */
export function cancelQueueAudioSession(callControlId) {
  if (!callControlId) return;
  const session = activeSessions.get(callControlId);
  if (session?.positionTimer) {
    clearTimeout(session.positionTimer);
    session.positionTimer = null;
  }
  clearAnnouncementRecoveryTimer(session);
  activeSessions.delete(callControlId);
}

/**
 * Start media playback for a queue session
 * @param {string} callControlId - Call control ID
 * @param {Object} session - Session object
 */
async function startMediaPlayback(
  callControlId,
  session,
  { commandId = null, clientState = null, retryOnFailure = false } = {},
) {
  if (!callControlId || !session) {
    return { started: false, retryable: false, terminal: false };
  }

  try {
    if (activeSessions.get(callControlId) !== session) {
      return { started: false, retryable: false, terminal: false };
    }
    if (session.mediaStarted && !session.playbackPaused) {
      // A successful playback command can atomically restore the call's base
      // client_state. If media never paused, explicitly clear the short-lived
      // queue marker so it cannot tag unrelated later speak webhooks.
      if (clientState) {
        const stateResult = await updateProviderClientState(
          callControlId,
          clientState,
        );
        if (!stateResult.ok) {
          return {
            started: false,
            retryable: stateResult.retryable,
            terminal: !stateResult.retryable,
            status: stateResult.status,
            cleanupAttempted: true,
          };
        }
        const stillAllowed = await isQueueAudioAllowed(callControlId, session);
        if (activeSessions.get(callControlId) !== session) {
          return { started: false, retryable: false, terminal: false };
        }
        if (!stillAllowed) {
          cancelQueueAudioSession(callControlId);
          return { started: false, retryable: false, terminal: false };
        }
        session.baseClientState = clientState;
      }
      return { started: true, retryable: false, terminal: false };
    }
    if (!(await ensureCurrentAndAllowed(callControlId, session))) {
      return { started: false, retryable: false, terminal: false };
    }
    const apiKey = getApiKey();
    const url = buildTelnyxV2Url(
      `/calls/${encodeURIComponent(callControlId)}/actions/playback_start`,
    );

    const maxAttempts = retryOnFailure ? 2 : 1;
    let response = null;
    let requestError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        response = await fetchProviderAudio(url, {
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
            ...(clientState ? { client_state: clientState } : {}),
            ...(commandId ? { command_id: commandId } : {}),
          }),
        });
        requestError = null;
      } catch (err) {
        response = null;
        requestError = err;
      }

      const currentSession = activeSessions.get(callControlId);
      if (currentSession !== session) {
        if (!currentSession) stopLateProviderAudio(callControlId);
        return { started: false, retryable: false, terminal: false };
      }
      if (response?.ok) break;
      const failure = providerFailure(response, requestError);
      if (!failure.retryable) break;
      if (attempt + 1 >= maxAttempts) break;
      if (!(await ensureCurrentAndAllowed(callControlId, session))) {
        return { started: false, retryable: false, terminal: false };
      }
    }

    if (!response?.ok) {
      const failure = providerFailure(response, requestError);
      queuesLogger.warn("queue_music_start_failed", {
        ...callPayload({ callControlId }),
        ...queuePayload({ queueId: session.queueId }),
        ...(response ? { providerStatus: response.status } : {}),
        ...(requestError ? contactCenterErrorPayload(requestError) : {}),
      });
      return {
        started: false,
        retryable: failure.retryable,
        terminal: !failure.retryable,
        status: failure.status,
      };
    }

    const stillAllowed = await isQueueAudioAllowed(callControlId, session);
    const currentSession = activeSessions.get(callControlId);
    if (currentSession !== session) {
      if (!currentSession) stopLateProviderAudio(callControlId);
      return { started: false, retryable: false, terminal: false };
    }
    if (!stillAllowed) {
      cancelQueueAudioSession(callControlId);
      stopLateProviderAudio(callControlId);
      return { started: false, retryable: false, terminal: false };
    }

    session.mediaStarted = true;
    if (clientState) session.baseClientState = clientState;
    queuesLogger.info("queue_music_started", {
      ...callPayload({ callControlId }),
      ...queuePayload({ queueId: session.queueId }),
    });
    return { started: true, retryable: false, terminal: false };
  } catch (err) {
    if (!activeSessions.has(callControlId)) stopLateProviderAudio(callControlId);
    queuesLogger.warn("queue_music_start_failed", {
      ...callPayload({ callControlId }),
      ...queuePayload({ queueId: session.queueId }),
      ...contactCenterErrorPayload(err),
    });
    return {
      started: false,
      retryable: false,
      terminal: true,
      error: err,
    };
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
    if (!currentSession || currentSession !== session) {
      return; // Session was stopped
    }
    if (!(await ensureCurrentAndAllowed(callControlId, currentSession))) return;

    // Telnyx queues speak commands. Do not replace our single tracked marker
    // while the previous announcement is pending or active; try again later.
    if (currentSession.announcementPending || currentSession.isSpeaking) {
      schedulePositionAnnouncement(
        callControlId,
        currentSession,
        currentSession.currentPosition,
      );
      return;
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

    const announced = await announceQueuePosition(
      callControlId,
      positionToAnnounce,
      currentSession.ttsVoice,
      currentSession.ttsVoiceApiKeyRef,
    );

    if (
      !announced &&
      activeSessions.get(callControlId) === currentSession
    ) {
      const playbackResult = await startMediaPlayback(
        callControlId,
        currentSession,
      );
      if (activeSessions.get(callControlId) !== currentSession) return;
      if (playbackResult.started) currentSession.playbackPaused = false;
    }

    // Schedule next announcement
    if (activeSessions.get(callControlId) === currentSession) {
      schedulePositionAnnouncement(
        callControlId,
        currentSession,
        positionToAnnounce,
      );
    }
  }, intervalMs);
}

/**
 * Resume media playback after position announcement
 * @param {string} callControlId - Call control ID
 */
export async function resumeQueueMedia(
  callControlId,
  clientState = null,
  { loadContext = loadQueueAudioContext } = {},
) {
  if (!callControlId) {
    return null;
  }

  const marker = getQueueAudioMarker(clientState);
  if (!marker) return null;
  const restoredClientState = removeQueueAudioMarker(clientState);

  const session = activeSessions.get(callControlId);
  if (!session) {
    // Webhooks are load-balanced without stickiness. A marked speak.ended may
    // land on a node that never owned the timer, so the durable marker carries
    // everything required to resume media safely on that node.
    const context = await loadContext(callControlId);
    if (
      !context.known ||
      !context.allowed ||
      context.queueId !== marker.queueId ||
      context.mediaName !== marker.mediaName
    ) {
      return null;
    }

    // A local generation may have appeared while the DB guard was in flight.
    if (activeSessions.has(callControlId)) {
      return resumeQueueMedia(callControlId, clientState, { loadContext });
    }

    try {
      const apiKey = getApiKey();
      const url = buildTelnyxV2Url(
        `/calls/${encodeURIComponent(callControlId)}/actions/playback_start`,
      );
      let response = null;
      let requestError = null;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetchProviderAudio(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              media_name: marker.mediaName,
              loop: "infinity",
              overlay: false,
              target_legs: "self",
              client_state: restoredClientState,
              command_id: marker.resumeCommandId,
            }),
          });
          requestError = null;
        } catch (err) {
          response = null;
          requestError = err;
        }

        if (response?.ok) break;
        const failure = providerFailure(response, requestError);
        if (!failure.retryable) {
          let cleanup = { ok: false, retryable: false };
          try {
            cleanup = await updateProviderClientState(
              callControlId,
              restoredClientState,
            );
          } catch (err) {
            cleanup = { ok: false, retryable: false, error: err };
          }
          if (cleanup.retryable) {
            return {
              matched: true,
              resumed: false,
              retryable: true,
              cleanupOnly: true,
              remote: true,
              ...marker,
            };
          }
          return {
            matched: true,
            resumed: false,
            retryable: false,
            terminal: true,
            markerCleared: cleanup.ok,
            providerStatus: failure.status,
            remote: true,
            ...marker,
          };
        }
        if (attempt === 1) break;

        const retryContext = await loadContext(callControlId);
        if (
          !retryContext.known ||
          !retryContext.allowed ||
          retryContext.queueId !== marker.queueId ||
          retryContext.mediaName !== marker.mediaName
        ) {
          return null;
        }
        if (activeSessions.has(callControlId)) {
          return resumeQueueMedia(callControlId, clientState, { loadContext });
        }
      }

      if (!response?.ok) {
        queuesLogger.warn("queue_music_resume_failed", {
          ...callPayload({ callControlId }),
          ...queuePayload({ queueId: marker.queueId }),
          ...(response ? { providerStatus: response.status } : {}),
          ...(requestError ? contactCenterErrorPayload(requestError) : {}),
        });
        return {
          matched: true,
          resumed: false,
          retryable: true,
          remote: true,
          ...marker,
        };
      }

      // Routing may have moved queued -> offered while playback_start was in
      // flight on this otherwise stateless node. Revalidate the durable owner
      // before treating the resume as successful, and undo a late effect.
      const currentContext = await loadContext(callControlId);
      if (
        !currentContext.known ||
        !currentContext.allowed ||
        currentContext.queueId !== marker.queueId ||
        currentContext.mediaName !== marker.mediaName
      ) {
        stopLateProviderAudio(callControlId);
        return null;
      }
      return {
        matched: true,
        resumed: true,
        retryable: false,
        remote: true,
        ...marker,
      };
    } catch (err) {
      queuesLogger.warn("queue_music_resume_failed", {
        ...callPayload({ callControlId }),
        ...queuePayload({ queueId: marker.queueId }),
        ...contactCenterErrorPayload(err),
      });
      const retryable = isRetryableProviderError(err);
      return {
        matched: true,
        resumed: false,
        retryable,
        terminal: !retryable,
        markerCleared: false,
        remote: true,
        ...marker,
      };
    }
  }

  // call.speak.ended is shared by all prompts on the call. The announcement ID
  // makes it safe to accept the matching ended event even if Telnyx delivers it
  // before speak.started (webhook ordering is not guaranteed).
  const matchesAnnouncement = () => sessionMatchesMarker(session, marker);
  if (!matchesAnnouncement()) {
    queuesLogger.debug("queue_media_resume_ignored", {
      ...callPayload({ callControlId }),
      ...queuePayload({ queueId: session.queueId }),
      reason: "no_queue_position_announcement_in_progress",
    });
    return null;
  }

  if (!(await ensureCurrentAndAllowed(callControlId, session))) return null;
  if (
    activeSessions.get(callControlId) !== session ||
    !matchesAnnouncement()
  ) {
    return null;
  }

  if (session.terminalResumeFailure) {
    return finishLocalPermanentResume(
      callControlId,
      session,
      marker,
      restoredClientState,
      { status: session.terminalResumeStatus },
    );
  }

  // Keep the lifecycle pending until both playback and marker cleanup succeed.
  // This lets a provider redelivery or the origin-node watchdog retry instead
  // of turning a transient playback_start failure into permanent silence.
  const playbackResult = await startMediaPlayback(callControlId, session, {
    commandId: session.pendingResumeCommandId || marker.resumeCommandId,
    clientState: restoredClientState,
    retryOnFailure: true,
  });

  if (playbackResult.started && activeSessions.get(callControlId) === session) {
    session.playbackPaused = false;
    resetAnnouncementLifecycle(session);
    return {
      matched: true,
      resumed: true,
      retryable: false,
      remote: false,
      session,
      ...marker,
    };
  }

  if (
    playbackResult.terminal &&
    activeSessions.get(callControlId) === session &&
    matchesAnnouncement()
  ) {
    session.terminalResumeFailure = true;
    session.terminalResumeStatus = playbackResult.status;
    return finishLocalPermanentResume(
      callControlId,
      session,
      marker,
      restoredClientState,
      {
        status: playbackResult.status,
        cleanupAttempted: playbackResult.cleanupAttempted,
      },
    );
  }

  if (
    playbackResult.retryable &&
    activeSessions.get(callControlId) === session &&
    matchesAnnouncement() &&
    (await isQueueAudioAllowed(callControlId, session))
  ) {
    scheduleAnnouncementRecovery(callControlId, session);
    return {
      matched: true,
      resumed: false,
      retryable: true,
      remote: false,
      ...marker,
    };
  }
  return null;
}

/**
 * Mark that the provider started the queue position announcement.
 * A speak.ended event is allowed to resume music only after this transition.
 * @param {string} callControlId - Call control ID
 */
export async function markQueuePositionStarted(callControlId, clientState = null) {
  if (!callControlId) {
    return null;
  }

  const session = activeSessions.get(callControlId);
  const marker = getQueueAudioMarker(clientState);
  if (
    !session ||
    !session.announcementPending ||
    !marker ||
    marker.queueId !== session.queueId ||
    marker.mediaName !== session.mediaName ||
    marker.announcementId !== session.pendingAnnouncementId
  ) {
    return null;
  }
  if (!(await ensureCurrentAndAllowed(callControlId, session))) return null;
  if (
    activeSessions.get(callControlId) !== session ||
    !session.announcementPending ||
    marker.announcementId !== session.pendingAnnouncementId
  ) {
    return null;
  }

  session.announcementPending = false;
  session.pendingAnnouncementId = null;
  session.activeAnnouncementId = marker.announcementId;
  session.isSpeaking = true;
  queuesLogger.info("queue_position_announcement_started", {
    ...callPayload({ callControlId }),
    ...queuePayload({ queueId: session.queueId }),
    position: session.currentPosition,
  });
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
  ttsVoiceApiKeyRef,
) {
  if (!callControlId || position === null || position === undefined) {
    return false;
  }

  const session = activeSessions.get(callControlId);
  if (!session) {
    return false;
  }
  if (session.announcementPending || session.isSpeaking) return true;
  if (!(await ensureCurrentAndAllowed(callControlId, session))) return false;

  try {
    const apiKey = getApiKey();

    // Stop playback before speaking (if media is playing)
    if (session.mediaStarted && !session.playbackPaused) {
      const stopUrl = buildTelnyxV2Url(
        `/calls/${encodeURIComponent(callControlId)}/actions/playback_stop`,
      );

      const stopResponse = await fetchProviderAudio(stopUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          stop: "all", // Stop all audio
        }),
      });

      if (!(await ensureCurrentAndAllowed(callControlId, session))) return false;
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
          [ttsVoiceApiKeyRef],
        );
        if (!(await ensureCurrentAndAllowed(callControlId, session))) return false;
        if (secretRes.rows?.[0]?.value) {
          voiceApiKey = secretRes.rows[0].value;
        }
      }
    }

    // Parse voice string (Provider.Model.VoiceId format)
    const parts = ttsVoice.split(".");
    const provider = parts[0] || "";

    // The speak action and the later resume are separate intended effects and
    // must never share a command_id.
    const announcementId = randomUUID();
    const resumeCommandId = randomUUID();
    const announcementClientState = buildAnnouncementClientState(
      session.baseClientState,
      {
        announcementId,
        resumeCommandId,
        queueId: session.queueId,
        mediaName: session.mediaName,
      },
    );
    const speakPayload = {
      payload: `your current position in a queue is ${position}`,
      voice: ttsVoice,
      client_state: announcementClientState,
      command_id: announcementId,
    };

    // Add API key if provided (for ElevenLabs)
    if (voiceApiKey && provider === "ElevenLabs") {
      speakPayload.voice_api_key = voiceApiKey;
    }
    const url = buildTelnyxV2Url(
      `/calls/${encodeURIComponent(callControlId)}/actions/speak`,
    );

    // Last durable-state check is deliberately adjacent to the provider speak.
    if (!(await ensureCurrentAndAllowed(callControlId, session))) return false;
    // Use the just-refreshed value, not the position captured when this timer
    // was scheduled or when the caller first entered the queue.
    position = session.currentPosition;
    speakPayload.payload = `your current position in a queue is ${position}`;
    session.announcementPending = true;
    session.pendingAnnouncementId = announcementId;
    session.activeAnnouncementId = null;
    session.pendingAnnouncementClientState = announcementClientState;
    session.pendingResumeCommandId = resumeCommandId;
    session.isSpeaking = false;
    const response = await fetchProviderAudio(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(speakPayload),
    });

    let currentSession = activeSessions.get(callControlId);
    if (currentSession !== session) {
      if (!currentSession) stopLateProviderAudio(callControlId);
      return false;
    }

    if (!response.ok) {
      resetAnnouncementLifecycle(session);
      queuesLogger.warn("queue_position_announcement_failed", {
        ...callPayload({ callControlId }),
        ...queuePayload({ queueId: session.queueId }),
        providerStatus: response.status,
      });
      return false;
    }

    const stillAllowed = await isQueueAudioAllowed(callControlId, session);
    currentSession = activeSessions.get(callControlId);
    if (currentSession !== session) {
      if (!currentSession) stopLateProviderAudio(callControlId);
      return false;
    }
    if (!stillAllowed) {
      cancelQueueAudioSession(callControlId);
      stopLateProviderAudio(callControlId);
      return false;
    }

    if (
      sessionMatchesMarker(session, {
        announcementId,
        queueId: session.queueId,
        mediaName: session.mediaName,
      })
    ) {
      scheduleAnnouncementRecovery(callControlId, session);
    }

    // Wait for call.speak.started before accepting call.speak.ended. Consecutive
    // Telnyx speak commands are queued, so the accepted action may not be the
    // speech that produced a late webhook currently in flight.
    queuesLogger.debug("queue_position_announcement_requested", {
      ...callPayload({ callControlId }),
      ...queuePayload({ queueId: session.queueId }),
      position,
    });
    return true;
  } catch (err) {
    if (!activeSessions.has(callControlId)) stopLateProviderAudio(callControlId);
    if (activeSessions.get(callControlId) === session) {
      resetAnnouncementLifecycle(session);
    }
    queuesLogger.warn("queue_position_announcement_failed", {
      ...callPayload({ callControlId }),
      ...queuePayload({ queueId: session.queueId }),
      ...contactCenterErrorPayload(err),
    });
    return false;
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
  for (const session of activeSessions.values()) {
    if (session.positionTimer) {
      clearTimeout(session.positionTimer);
      session.positionTimer = null;
    }
    clearAnnouncementRecoveryTimer(session);
  }
  activeSessions.clear();
}
