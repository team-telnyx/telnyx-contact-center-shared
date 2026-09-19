import test from "node:test";
import assert from "node:assert/strict";

import {
  cancelQueueAudioSession,
  clearAllSessions,
  getActiveSession,
  getQueueAudioMarker,
  isQueuePositionClientState,
  markQueuePositionStarted,
  resumeQueueMedia,
  startQueueAudio,
  stopQueueAudio,
} from "../lib/contact-center/queue-audio-service.js";

// This file exercises the provider command and local session state in isolation.
// CI supplies PostgreSQL variables globally, so explicitly disable the runtime
// database guard for this unit-test process instead of depending on an empty DB.
process.env.POSTGRES_HOST = "";

const queueConfig = {
  queue_audio_media_name: "queue-music",
  queue_audio_enable_position: true,
  queue_audio_tts_voice: "AWS.Polly.Joanna",
  queue_audio_position_interval_secs: 3600,
};

function providerResponse(ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => ({}) };
}

function encodeClientState(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function decodeClientState(value) {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

test("queue audio stop is provider-authoritative even without a local session", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TELNYX_API_KEY;
  const calls = [];
  process.env.TELNYX_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({}) };
  };
  clearAllSessions();

  try {
    await stopQueueAudio("v3:customer-leg");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalApiKey;
  }

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /actions\/playback_stop$/);
  assert.deepEqual(calls[0].body, { stop: "all" });
});
test("queue position is announced before music starts", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TELNYX_API_KEY;
  const calls = [];
  let resolveSpeak;
  process.env.TELNYX_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    const action = String(url).split("/").at(-1);
    calls.push({ action, body: JSON.parse(options.body) });
    if (action === "speak") {
      return new Promise((resolve) => {
        resolveSpeak = resolve;
      });
    }
    return providerResponse();
  };
  clearAllSessions();

  try {
    const starting = startQueueAudio(
      "v3:position-first",
      "queue-1",
      queueConfig,
      2,
      { clientState: encodeClientState({ call_priority: 4 }) },
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls.map(({ action }) => action), ["speak"]);
    assert.equal(
      calls[0].body.payload,
      "your current position in a queue is 2",
    );

    // A late speak.ended from an earlier IVR prompt must not start queue music
    // while the queue position action has not yet been accepted.
    assert.equal(await resumeQueueMedia("v3:position-first"), null);
    assert.deepEqual(calls.map(({ action }) => action), ["speak"]);

    resolveSpeak(providerResponse());
    await starting;
    assert.deepEqual(calls.map(({ action }) => action), ["speak"]);
    const announcementClientState = calls[0].body.client_state;
    const decodedClientState = decodeClientState(announcementClientState);
    assert.equal(decodedClientState.call_priority, 4);
    assert.equal(decodedClientState.__cc_queue_audio.type, "queue_position");
    assert.equal(decodedClientState.__cc_queue_audio.queue_id, "queue-1");
    assert.equal(
      decodedClientState.__cc_queue_audio.media_name,
      "queue-music",
    );
    assert.equal(
      calls[0].body.command_id,
      decodedClientState.__cc_queue_audio.announcement_id,
    );
    assert.notEqual(
      calls[0].body.command_id,
      decodedClientState.__cc_queue_audio.resume_command_id,
    );
    assert.ok(getQueueAudioMarker(announcementClientState));
    assert.equal(isQueuePositionClientState(announcementClientState), true);

    // Telnyx accepted the command, but an older queued prompt may still be the
    // one ending. We only associate ended after our speak.started arrives.
    assert.equal(await resumeQueueMedia("v3:position-first"), null);
    assert.deepEqual(calls.map(({ action }) => action), ["speak"]);

    const unrelatedClientState = encodeClientState({
      __cc_queue_audio: {
        type: "queue_position",
        announcement_id: "an-older-announcement",
      },
    });
    assert.equal(
      await markQueuePositionStarted(
        "v3:position-first",
        unrelatedClientState,
      ),
      null,
    );
    assert.ok(
      await markQueuePositionStarted(
        "v3:position-first",
        announcementClientState,
      ),
    );
    assert.equal(
      await resumeQueueMedia("v3:position-first", unrelatedClientState),
      null,
    );
    assert.ok(
      await resumeQueueMedia("v3:position-first", announcementClientState),
    );
    assert.deepEqual(calls.map(({ action }) => action), [
      "speak",
      "playback_start",
    ]);
    assert.deepEqual(calls[1].body, {
      media_name: "queue-music",
      loop: "infinity",
      overlay: false,
      target_legs: "self",
      client_state: encodeClientState({ call_priority: 4 }),
      command_id: decodedClientState.__cc_queue_audio.resume_command_id,
    });
    assert.equal(getQueueAudioMarker(calls[1].body.client_state), null);

    // playback_start restores the original call-wide state. A later unrelated
    // speak.ended therefore no longer carries a queue marker and cannot be
    // consumed as another position announcement.
    assert.equal(
      await resumeQueueMedia(
        "v3:position-first",
        calls[1].body.client_state,
      ),
      null,
    );

    // Duplicate/unrelated speak.ended events cannot restart the loop.
    assert.equal(
      await resumeQueueMedia("v3:position-first", announcementClientState),
      null,
    );
    assert.equal(
      calls.filter(({ action }) => action === "playback_start").length,
      1,
    );
  } finally {
    clearAllSessions();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalApiKey;
  }
});

test("duplicate queue-audio start does not repeat the initial position announcement", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TELNYX_API_KEY;
  const calls = [];
  process.env.TELNYX_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    calls.push({
      action: String(url).split("/").at(-1),
      body: JSON.parse(options.body),
    });
    return providerResponse();
  };
  clearAllSessions();

  try {
    await Promise.all([
      startQueueAudio("v3:idempotent-start", "queue-1", queueConfig, 1, {
        deduplicate: true,
      }),
      startQueueAudio("v3:idempotent-start", "queue-1", queueConfig, 1, {
        deduplicate: true,
      }),
    ]);
    await startQueueAudio(
      "v3:idempotent-start",
      "queue-1",
      queueConfig,
      1,
      { deduplicate: true },
    );

    assert.deepEqual(calls.map(({ action }) => action), ["speak"]);
    assert.equal(
      calls[0].body.payload,
      "your current position in a queue is 1",
    );
  } finally {
    clearAllSessions();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalApiKey;
  }
});

test("duplicate music-only start retries when the first provider start failed", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TELNYX_API_KEY;
  const calls = [];
  let playbackStarts = 0;
  process.env.TELNYX_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    const action = String(url).split("/").at(-1);
    calls.push({ action, body: JSON.parse(options.body) });
    if (action === "playback_start") {
      playbackStarts += 1;
      return providerResponse(playbackStarts > 1, playbackStarts > 1 ? 200 : 500);
    }
    return providerResponse();
  };
  clearAllSessions();

  try {
    const musicOnlyConfig = {
      ...queueConfig,
      queue_audio_enable_position: false,
      queue_audio_tts_voice: null,
    };
    await startQueueAudio(
      "v3:retry-failed-start",
      "queue-1",
      musicOnlyConfig,
      1,
      { deduplicate: true },
    );
    assert.equal(getActiveSession("v3:retry-failed-start").mediaStarted, false);

    await startQueueAudio(
      "v3:retry-failed-start",
      "queue-1",
      musicOnlyConfig,
      1,
      { deduplicate: true },
    );

    assert.deepEqual(calls.map(({ action }) => action), [
      "playback_start",
      "playback_stop",
      "playback_start",
    ]);
    assert.equal(getActiveSession("v3:retry-failed-start").mediaStarted, true);
  } finally {
    clearAllSessions();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalApiKey;
  }
});

test("queue music is used as a fallback when position TTS is rejected", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TELNYX_API_KEY;
  const calls = [];
  process.env.TELNYX_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    const action = String(url).split("/").at(-1);
    calls.push({ action, body: JSON.parse(options.body) });
    return action === "speak"
      ? providerResponse(false, 422)
      : providerResponse();
  };
  clearAllSessions();

  try {
    await startQueueAudio(
      "v3:tts-fallback",
      "queue-1",
      queueConfig,
      1,
    );
    assert.deepEqual(calls.map(({ action }) => action), [
      "speak",
      "playback_start",
    ]);
  } finally {
    clearAllSessions();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalApiKey;
  }
});

test("matching speak.ended can arrive before speak.started without leaving silence", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TELNYX_API_KEY;
  const calls = [];
  process.env.TELNYX_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    const action = String(url).split("/").at(-1);
    calls.push({ action, body: JSON.parse(options.body) });
    return providerResponse();
  };
  clearAllSessions();

  try {
    await startQueueAudio(
      "v3:ended-first",
      "queue-1",
      queueConfig,
      1,
    );
    const announcementClientState = calls[0].body.client_state;

    assert.ok(
      await resumeQueueMedia("v3:ended-first", announcementClientState),
    );
    assert.equal(
      await markQueuePositionStarted(
        "v3:ended-first",
        announcementClientState,
      ),
      null,
    );
    assert.deepEqual(calls.map(({ action }) => action), [
      "speak",
      "playback_start",
    ]);
  } finally {
    clearAllSessions();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalApiKey;
  }
});

test("cross-node resume requires durable proof and reuses the marker command id", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TELNYX_API_KEY;
  const calls = [];
  process.env.TELNYX_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    calls.push({
      action: String(url).split("/").at(-1),
      body: JSON.parse(options.body),
    });
    return providerResponse();
  };
  clearAllSessions();

  try {
    await startQueueAudio("v3:cross-node", "queue-1", queueConfig, 1);
    const clientState = calls[0].body.client_state;
    const marker = getQueueAudioMarker(clientState);
    assert.ok(marker);

    // Simulate call.speak.ended reaching a different process.
    cancelQueueAudioSession("v3:cross-node");
    calls.length = 0;

    const unknown = await resumeQueueMedia("v3:cross-node", clientState, {
      loadContext: async () => ({
        known: false,
        allowed: true,
        queueId: "queue-1",
        mediaName: "queue-music",
      }),
    });
    assert.equal(unknown, null);
    assert.equal(calls.length, 0);

    const loadContext = async () => ({
      known: true,
      allowed: true,
      queueId: "queue-1",
      mediaName: "queue-music",
    });
    assert.ok(
      await resumeQueueMedia("v3:cross-node", clientState, { loadContext }),
    );
    assert.ok(
      await resumeQueueMedia("v3:cross-node", clientState, { loadContext }),
    );
    assert.deepEqual(calls.map(({ action }) => action), [
      "playback_start",
      "playback_start",
    ]);
    assert.equal(calls[0].body.media_name, "queue-music");
    assert.equal(calls[0].body.command_id, marker.resumeCommandId);
    assert.equal(calls[1].body.command_id, marker.resumeCommandId);
    assert.equal(getQueueAudioMarker(calls[0].body.client_state), null);
    assert.notEqual(marker.resumeCommandId, marker.announcementId);

    calls.length = 0;
    let contextRead = 0;
    const raced = await resumeQueueMedia("v3:cross-node", clientState, {
      loadContext: async () => {
        contextRead += 1;
        return {
          known: true,
          allowed: contextRead === 1,
          queueId: "queue-1",
          mediaName: "queue-music",
        };
      },
    });
    assert.equal(raced, null);
    assert.deepEqual(calls.map(({ action }) => action), [
      "playback_start",
      "playback_stop",
    ]);
  } finally {
    clearAllSessions();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalApiKey;
  }
});

test("cross-node playback failure remains retryable with an idempotent command id", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TELNYX_API_KEY;
  const calls = [];
  let permitFreshSuccess = false;
  process.env.TELNYX_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    const action = String(url).split("/").at(-1);
    const body = JSON.parse(options.body);
    calls.push({ action, body });
    if (action !== "playback_start") return providerResponse();
    if (!permitFreshSuccess) {
      return providerResponse(false, 503);
    }
    return providerResponse();
  };
  clearAllSessions();

  try {
    await startQueueAudio("v3:cross-node-retry", "queue-1", queueConfig, 1);
    const clientState = calls[0].body.client_state;
    const marker = getQueueAudioMarker(clientState);
    cancelQueueAudioSession("v3:cross-node-retry");
    calls.length = 0;

    const loadContext = async () => ({
      known: true,
      allowed: true,
      queueId: "queue-1",
      mediaName: "queue-music",
    });
    const failed = await resumeQueueMedia(
      "v3:cross-node-retry",
      clientState,
      { loadContext },
    );
    assert.deepEqual(
      {
        matched: failed?.matched,
        resumed: failed?.resumed,
        retryable: failed?.retryable,
      },
      { matched: true, resumed: false, retryable: true },
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.command_id, marker.resumeCommandId);
    assert.equal(calls[1].body.command_id, marker.resumeCommandId);

    permitFreshSuccess = true;
    const recovered = await resumeQueueMedia(
      "v3:cross-node-retry",
      clientState,
      { loadContext },
    );
    assert.equal(recovered?.matched, true);
    assert.equal(recovered?.resumed, true);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].body.command_id, marker.resumeCommandId);
    assert.equal(getQueueAudioMarker(calls[2].body.client_state), null);
  } finally {
    clearAllSessions();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalApiKey;
  }
});

test("remote permanent playback 4xx clears the marker without retrying", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TELNYX_API_KEY;
  const calls = [];
  process.env.TELNYX_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    const action = String(url).split("/").at(-1);
    const body = JSON.parse(options.body);
    calls.push({ action, body });
    if (action === "playback_start") return providerResponse(false, 404);
    return providerResponse();
  };
  clearAllSessions();

  try {
    await startQueueAudio("v3:remote-permanent", "queue-1", queueConfig, 1);
    const clientState = calls[0].body.client_state;
    cancelQueueAudioSession("v3:remote-permanent");
    calls.length = 0;

    const result = await resumeQueueMedia(
      "v3:remote-permanent",
      clientState,
      {
        loadContext: async () => ({
          known: true,
          allowed: true,
          queueId: "queue-1",
          mediaName: "queue-music",
        }),
      },
    );

    assert.deepEqual(
      {
        matched: result?.matched,
        resumed: result?.resumed,
        retryable: result?.retryable,
        terminal: result?.terminal,
        markerCleared: result?.markerCleared,
      },
      {
        matched: true,
        resumed: false,
        retryable: false,
        terminal: true,
        markerCleared: true,
      },
    );
    assert.deepEqual(calls.map(({ action }) => action), [
      "playback_start",
      "client_state_update",
    ]);
    assert.equal(getQueueAudioMarker(calls[1].body.client_state), null);
  } finally {
    clearAllSessions();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalApiKey;
  }
});

test("local permanent playback 4xx stops recovery timers after marker cleanup", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TELNYX_API_KEY;
  const calls = [];
  process.env.TELNYX_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    const action = String(url).split("/").at(-1);
    const body = JSON.parse(options.body);
    calls.push({ action, body });
    if (action === "playback_start") return providerResponse(false, 422);
    return providerResponse();
  };
  clearAllSessions();

  try {
    await startQueueAudio(
      "v3:local-permanent",
      "queue-1",
      queueConfig,
      1,
      { announcementRecoveryMs: 10 },
    );
    const clientState = calls[0].body.client_state;
    const result = await resumeQueueMedia(
      "v3:local-permanent",
      clientState,
    );

    assert.equal(result?.matched, true);
    assert.equal(result?.resumed, false);
    assert.equal(result?.retryable, false);
    assert.equal(result?.terminal, true);
    assert.equal(result?.markerCleared, true);
    assert.equal(getActiveSession("v3:local-permanent"), null);
    assert.deepEqual(calls.map(({ action }) => action), [
      "speak",
      "playback_start",
      "client_state_update",
    ]);
    assert.equal(getQueueAudioMarker(calls[2].body.client_state), null);

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.length, 3);
  } finally {
    clearAllSessions();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalApiKey;
  }
});

test("origin watchdog releases pending state when another node misses the resume", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TELNYX_API_KEY;
  const calls = [];
  let playbackAttempt = 0;
  process.env.TELNYX_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    const action = String(url).split("/").at(-1);
    const body = JSON.parse(options.body);
    calls.push({ action, body });
    if (action === "playback_start") {
      playbackAttempt += 1;
      return providerResponse(playbackAttempt >= 3, playbackAttempt >= 3 ? 200 : 503);
    }
    return providerResponse();
  };
  clearAllSessions();

  try {
    await startQueueAudio(
      "v3:origin-watchdog",
      "queue-1",
      queueConfig,
      1,
      { announcementRecoveryMs: 10 },
    );
    const marker = getQueueAudioMarker(calls[0].body.client_state);
    assert.equal(getActiveSession("v3:origin-watchdog")?.announcementPending, true);

    // No speak.ended is delivered to this process. The first watchdog attempt
    // gets two transient failures; the next watchdog attempt recovers. Wait for
    // the third attempt itself rather than for a fixed delay, so a loaded
    // machine cannot turn a timing margin into a failure.
    const deadline = Date.now() + 5000;
    const playbackAttempts = () => calls.filter(({ action }) => action === "playback_start");
    while (playbackAttempts().length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const playbackCalls = playbackAttempts();
    assert.equal(playbackCalls.length, 3);
    assert.equal(playbackCalls[0].body.command_id, marker.resumeCommandId);
    assert.equal(
      playbackCalls[0].body.command_id,
      playbackCalls[1].body.command_id,
    );
    assert.equal(
      playbackCalls[1].body.command_id,
      playbackCalls[2].body.command_id,
    );
    assert.equal(getQueueAudioMarker(playbackCalls[2].body.client_state), null);
    assert.equal(getActiveSession("v3:origin-watchdog")?.announcementPending, false);
    assert.equal(getActiveSession("v3:origin-watchdog")?.isSpeaking, false);
  } finally {
    clearAllSessions();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalApiKey;
  }
});

test("a cancelled replacement generation cannot restart queue media", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TELNYX_API_KEY;
  const calls = [];
  let resolveStop;
  let observeStop;
  const stopObserved = new Promise((resolve) => {
    observeStop = resolve;
  });
  process.env.TELNYX_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    const action = String(url).split("/").at(-1);
    calls.push({ action, body: JSON.parse(options.body) });
    if (action === "playback_stop") {
      observeStop();
      return new Promise((resolve) => {
        resolveStop = resolve;
      });
    }
    return providerResponse();
  };
  clearAllSessions();

  const musicOnly = {
    queue_audio_media_name: "queue-music",
    queue_audio_enable_position: false,
  };
  try {
    await startQueueAudio("v3:generation", "queue-1", musicOnly, 1);
    const restarting = startQueueAudio(
      "v3:generation",
      "queue-1",
      musicOnly,
      1,
    );
    await stopObserved;
    cancelQueueAudioSession("v3:generation");
    resolveStop(providerResponse());
    await restarting;

    assert.deepEqual(calls.map(({ action }) => action), [
      "playback_start",
      "playback_stop",
    ]);
  } finally {
    clearAllSessions();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalApiKey;
  }
});

test("pending position announcement is rescheduled instead of overwritten", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TELNYX_API_KEY;
  const calls = [];
  process.env.TELNYX_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    calls.push({
      action: String(url).split("/").at(-1),
      body: JSON.parse(options.body),
    });
    return providerResponse();
  };
  clearAllSessions();

  try {
    await startQueueAudio(
      "v3:pending-announcement",
      "queue-1",
      { ...queueConfig, queue_audio_position_interval_secs: 0.01 },
      1,
    );
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(
      calls.filter(({ action }) => action === "speak").length,
      1,
    );
  } finally {
    clearAllSessions();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalApiKey;
  }
});

test("cancellation during playback_stop prevents a late position speak", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TELNYX_API_KEY;
  const calls = [];
  let resolveStop;
  let observeStop;
  const stopObserved = new Promise((resolve) => {
    observeStop = resolve;
  });
  process.env.TELNYX_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    const action = String(url).split("/").at(-1);
    calls.push({ action, body: JSON.parse(options.body) });
    if (action === "playback_stop") {
      observeStop();
      return new Promise((resolve) => {
        resolveStop = resolve;
      });
    }
    return providerResponse();
  };
  clearAllSessions();

  try {
    await startQueueAudio(
      "v3:cancel-announcement",
      "queue-1",
      { ...queueConfig, queue_audio_position_interval_secs: 0.01 },
      1,
    );
    const clientState = calls[0].body.client_state;
    assert.ok(
      await resumeQueueMedia("v3:cancel-announcement", clientState),
    );
    await stopObserved;
    cancelQueueAudioSession("v3:cancel-announcement");
    resolveStop(providerResponse());
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(
      calls.filter(({ action }) => action === "speak").length,
      1,
    );
  } finally {
    clearAllSessions();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalApiKey;
  }
});

test("provider stop is bounded while local cancellation is immediate", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TELNYX_API_KEY;
  process.env.TELNYX_API_KEY = "test-key";
  globalThis.fetch = async (_url, options) =>
    new Promise((resolve, reject) => {
      const abort = () => reject(options.signal.reason || new Error("aborted"));
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    });
  clearAllSessions();

  try {
    const startedAt = Date.now();
    assert.equal(
      await stopQueueAudio("v3:bounded-stop", { timeoutMs: 10 }),
      false,
    );
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    clearAllSessions();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalApiKey;
  }
});
