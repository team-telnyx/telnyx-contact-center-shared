import { defineSaga, startSaga } from "../saga-engine.mjs";

const HOLD_GUARD_MS = 8 * 60 * 60 * 1000;

function mediaName(ctx) {
  return ctx.data.mediaName || null;
}

function hasAnnouncement(ctx) {
  return Boolean(
    ctx.data.announcementEnabled &&
      ctx.data.announcementText &&
      ctx.data.announcementVoice,
  );
}

function announcementIntervalMs(ctx) {
  const seconds = Number(ctx.data.announcementIntervalSeconds) || 60;
  return Math.min(300, Math.max(10, seconds)) * 1000;
}

function speakRequest(ctx) {
  const request = {
    payload: String(ctx.data.announcementText || "").slice(0, 3000),
    voice: ctx.data.announcementVoice,
    target_legs: "self",
  };
  if (ctx.data.announcementLanguage) {
    request.language = ctx.data.announcementLanguage;
  }
  if (
    /^ElevenLabs\./i.test(String(ctx.data.announcementVoice || "")) &&
    ctx.data.announcementVoiceApiKeyRef
  ) {
    request.voice_settings = {
      type: "elevenlabs",
      api_key_ref: ctx.data.announcementVoiceApiKeyRef,
    };
  }
  return request;
}

function playbackRequest(ctx) {
  return {
    media_name: mediaName(ctx),
    loop: "infinity",
    overlay: false,
    target_legs: "self",
  };
}

const ended = {
  "leg.ended:customer": "succeeded",
  "leg.ended:agent_device": "succeeded",
};

export const agentHoldSaga = defineSaga("agent_hold", {
  initialStep: "route_initial_audio",
  steps: {
    route_initial_audio: {
      run: async (_tx, ctx) => {
        if (hasAnnouncement(ctx)) return "speak_announcement";
        return mediaName(ctx) ? "start_music" : "held";
      },
    },
    speak_announcement: {
      cmd: (ctx) => ({
        operation: "agent_hold_speak_announcement",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/speak`,
        request: speakRequest(ctx),
      }),
      on: {
        accepted: "await_announcement",
        "media.speak_ended:customer": "route_after_announcement",
        "intent.unhold": "stop_audio",
        ...ended,
      },
      deadlineMs: 10_000,
      onFailure: "route_after_announcement",
      onDeadline: "route_after_announcement",
    },
    await_announcement: {
      on: {
        "media.speak_ended:customer": "route_after_announcement",
        "intent.unhold": "stop_audio",
        ...ended,
      },
      deadlineMs: 30_000,
      onDeadline: "route_after_announcement",
    },
    route_after_announcement: {
      run: async (_tx, ctx) => (mediaName(ctx) ? "start_music" : "held"),
    },
    start_music: {
      cmd: (ctx) => ({
        operation: "agent_hold_start_music",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/playback_start`,
        request: playbackRequest(ctx),
      }),
      on: { accepted: "held", "intent.unhold": "stop_audio", ...ended },
      deadlineMs: 5_000,
      onFailure: "held",
      onDeadline: "held",
    },
    held: {
      on: { "intent.unhold": "stop_audio", ...ended },
      deadlineMs: (ctx) =>
        hasAnnouncement(ctx) ? announcementIntervalMs(ctx) : HOLD_GUARD_MS,
      onDeadline: "route_repeat_announcement",
    },
    route_repeat_announcement: {
      run: async (_tx, ctx) => {
        if (!hasAnnouncement(ctx)) return "held";
        return mediaName(ctx) ? "pause_music" : "speak_announcement";
      },
    },
    pause_music: {
      cmd: (ctx) => ({
        operation: "agent_hold_pause_music",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/playback_stop`,
        request: { stop: "all" },
      }),
      on: { accepted: "speak_announcement", "intent.unhold": "stop_audio", ...ended },
      deadlineMs: 5_000,
      onFailure: "speak_announcement",
      onDeadline: "speak_announcement",
    },
    stop_audio: {
      cmd: (ctx) => ({
        operation: "agent_hold_stop_audio",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/playback_stop`,
        request: { stop: "all" },
      }),
      on: { accepted: "succeeded", ...ended },
      deadlineMs: 5_000,
      onFailure: "succeeded",
      onDeadline: "succeeded",
    },
  },
});

export function startAgentHoldSaga(db, {
  workItemId,
  customerProviderCallId,
  settings,
}) {
  return startSaga(db, {
    type: "agent_hold",
    workItemId,
    conflictKey: "agent-hold",
    data: {
      customerProviderCallId,
      mediaName: settings.media_name || null,
      announcementEnabled: settings.announcement_enabled === true,
      announcementText: settings.announcement_text || null,
      announcementVoice: settings.announcement_voice || null,
      announcementLanguage: settings.announcement_language || null,
      announcementVoiceApiKeyRef:
        settings.announcement_voice_api_key_ref || null,
      announcementIntervalSeconds: Math.min(
        300,
        Math.max(10, Number(settings.announcement_interval_seconds) || 60),
      ),
    },
    actor: "agent:hold",
  });
}
