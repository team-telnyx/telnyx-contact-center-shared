// Browser-side wrapper around @telnyx/video. Framework-agnostic so the widget
// runtime and the agent desktop share one implementation; a provider swap only
// touches this file (the internal documentation).

export const VIDEO_STREAM_KEY = "self";
export const SCREEN_STREAM_KEY = "screen";

async function loadSdk() {
  const sdk = await import("@telnyx/video");
  return sdk;
}

function participantContext(room, participantId) {
  const participant = room.getState().participants.get(participantId);
  if (!participant?.context) return {};
  try { return JSON.parse(participant.context); } catch { return {}; }
}

/**
 * Join a Telnyx room and keep a small view model in sync.
 *
 * onChange(snapshot) fires after every SDK event with:
 *   { status, localParticipantId, remote: [{ participantId, role, name, key, videoTrack, audioTrack, videoEnabled, audioEnabled }],
 *     mixedAudioTrack, error }
 */
//   participants: [{ participantId, role, name, self }] lists everyone in the
//   room, streams or not (a monitoring supervisor publishes nothing).
//
// `shouldSubscribe({ participantId, role, key })` decides which remote streams
// this client receives; `applySubscriptions()` re-evaluates it (the supervisor
// changed mode). Subscriptions are per receiver, so this is where whisper and
// monitor differ from barge.
// The SDK removes a departed participant from its state but keeps their
// streams and subscriptions, so a supervisor who left after barging (or an
// agent after a transfer) would stay on screen as a black frame, and changing
// the subscription of such a stream throws "No stream registered…". Departed
// participants are tracked here and their streams ignored.
const STALE_STREAM_ERROR = /No stream registered|No participant found|Invalid state update/i;

export async function joinVideoRoom({ roomId, token, context = {}, onChange = () => {}, onMessage = () => {}, onDisconnected = () => {}, shouldSubscribe = () => true, logLevel = "WARN", sdk = null }) {
  const { initialize } = sdk || await loadSdk();
  const room = await initialize({ roomId, clientToken: token, context: JSON.stringify(context), logLevel, enableMessages: true });
  const unsubscribes = [];
  let disposed = false;
  let local = { audio: null, video: null };
  let published = false;
  let policy = shouldSubscribe;
  // Stream ids left behind by departed participants. Tracked per stream, not
  // per participant: someone who reconnects under the same id publishes new
  // streams (new ids), while the old objects must stay hidden.
  const staleStreams = new Set();
  const live = (state, stream) => {
    if (staleStreams.has(stream.id) || !state.participants.get(stream.participantId)) return false;
    const tracks = [stream.videoTrack, stream.audioTrack].filter(Boolean);
    return !(tracks.length && tracks.every((track) => track.readyState === "ended"));
  };
  // Only a failure about a stream or participant confirmed gone is swallowed;
  // the same message for someone still in the room is a real problem.
  const reportFor = (participantId, streamId = null) => (error) => {
    // Gone = marked stale, no longer in the state (unpublished while the
    // request was in flight, e.g. a screen share that stopped), or its owner left.
    const state = room.getState();
    const departed = (streamId && (staleStreams.has(streamId) || !state.streams.has(streamId))) || !state.participants.get(participantId);
    if (departed && STALE_STREAM_ERROR.test(error?.message || "")) snapshot(); else snapshot(error);
  };

  const snapshot = (error = null) => {
    const state = room.getState();
    const remote = [];
    if (state.mixedAudioTrack) state.mixedAudioTrack.enabled = false;
    for (const stream of state.streams.values()) {
      if (stream.origin !== "remote") continue;
      // A stream this client does not subscribe to (a whispering supervisor
      // on the visitor's side) stays out of the view: no tile, no label. The
      // same goes for a stream whose owner left, or that the policy no longer wants.
      const allowed = Boolean(state.subscriptions.get(stream.participantId)?.get(stream.key)) &&
        live(state, stream) && wanted(stream.participantId, stream.key);
      if (stream.audioTrack) stream.audioTrack.enabled = allowed;
      if (!allowed) continue;
      const ctx = participantContext(room, stream.participantId);
      remote.push({ participantId: stream.participantId, role: ctx.role || "unknown", name: ctx.name || null, key: stream.key,
        videoTrack: stream.videoTrack || null, audioTrack: stream.audioTrack || null, videoEnabled: Boolean(stream.isVideoEnabled && stream.videoTrack),
        audioEnabled: Boolean(stream.isAudioEnabled), subscribed: Boolean(state.subscriptions.get(stream.participantId)?.get(stream.key)) });
    }
    const participants = [];
    for (const participant of state.participants.values()) {
      const ctx = participantContext(room, participant.id);
      participants.push({ participantId: participant.id, role: ctx.role || "unknown", name: ctx.name || null, mode: ctx.mode || null, self: participant.id === state.localParticipantId });
    }
    onChange({ status: state.status, localParticipantId: state.localParticipantId, remote, participants, mixedAudioTrack: null, audioTracks: remote.filter(s => s.audioEnabled && s.audioTrack).map(s => ({ id: `${s.participantId}/${s.key}`, track: s.audioTrack })), error });
  };

  const wanted = (participantId, key) => {
    const ctx = participantContext(room, participantId);
    try { return Boolean(policy({ participantId, role: ctx.role || "unknown", key, mode: ctx.mode || null })); } catch { return true; }
  };
  const subscribe = (participantId, key) => {
    const stream = room.getParticipantStream(participantId, key);
    if ((stream && staleStreams.has(stream.id)) || !wanted(participantId, key)) return Promise.resolve();
    return room.addSubscription(participantId, key, { audio: true, video: true }).catch(reportFor(participantId, stream?.id));
  };
  const applySubscriptions = async () => {
    if (disposed) return;
    const state = room.getState();
    for (const stream of state.streams.values()) {
      // Only streams of departed participants are left alone. A stream whose
      // tracks merely ended still belongs to someone in the room: if the
      // policy no longer wants it, the subscription must go, or a track
      // enabled later (a supervisor's microphone in monitor mode) would be heard.
      if (stream.origin !== "remote" || staleStreams.has(stream.id) || !state.participants.get(stream.participantId)) continue;
      const has = Boolean(state.subscriptions.get(stream.participantId)?.get(stream.key));
      const want = wanted(stream.participantId, stream.key) && live(state, stream);
      if (want && !has) await room.addSubscription(stream.participantId, stream.key, { audio: true, video: true }).catch(reportFor(stream.participantId, stream.id));
      else if (!want && has) await room.removeSubscription(stream.participantId, stream.key).catch(reportFor(stream.participantId, stream.id));
    }
    snapshot();
  };

  for (const eventName of ["state_changed", "stream_unpublished", "track_disabled", "subscription_started", "subscription_ended", "subscription_reconfigured"]) {
    unsubscribes.push(room.on(eventName, () => { if (!disposed) snapshot(); }));
  }
  // A track coming (back) on re-checks the policy for that stream.
  unsubscribes.push(room.on("track_enabled", () => { if (!disposed) void applySubscriptions(); }));
  unsubscribes.push(room.on("participant_joined", () => { if (!disposed) snapshot(); }));
  unsubscribes.push(room.on("participant_left", (participantId) => {
    if (disposed) return;
    for (const stream of room.getState().streams.values()) if (stream.participantId === participantId) staleStreams.add(stream.id);
    snapshot();
  }));
  unsubscribes.push(room.on("stream_published", (participantId, key) => {
    if (disposed) return;
    const stream = room.getParticipantStream(participantId, key);
    if (stream?.origin === "remote") subscribe(participantId, key);
    snapshot();
  }));
  unsubscribes.push(room.on("message_received", (participantId, message) => {
    if (disposed || message?.type !== "text") return;
    let payload = null;
    try { payload = JSON.parse(message.payload); } catch { payload = { text: message.payload }; }
    onMessage(payload, participantId);
  }));
  unsubscribes.push(room.on("disconnected", (reason) => { if (!disposed) { snapshot(); onDisconnected(reason); } }));

  await room.connect();
  // Streams published before this client joined never emit stream_published.
  for (const stream of room.getState().streams.values()) {
    if (stream.origin === "remote") subscribe(stream.participantId, stream.key);
  }
  snapshot();

  return {
    room,
    get localTracks() { return local; },
    async publish({ audio = null, video = null } = {}) {
      local = { audio, video };
      await room.addStream(VIDEO_STREAM_KEY, { audio: audio || undefined, video: video ? { track: video, options: { enableSimulcast: false } } : undefined });
      // Only after the room accepted the stream: a rejected first publish must
      // be retried as a publish, not as an update of a stream that never existed.
      published = true;
      snapshot();
    },
    // Camera off must go through updateStream: toggling track.enabled alone
    // does not notify the other side (verified in the spike). A participant
    // who joined without media (a monitoring supervisor) publishes on first use.
    async setVideoTrack(video) {
      local = { ...local, video };
      if (!published) { if (video || local.audio) await this.publish(local); return; }
      await room.updateStream(VIDEO_STREAM_KEY, { audio: local.audio || undefined, video: video ? { track: video, options: { enableSimulcast: false } } : undefined });
      snapshot();
    },
    async setAudioTrack(audio) {
      local = { ...local, audio };
      if (!published) { if (audio || local.video) await this.publish(local); return; }
      await room.updateStream(VIDEO_STREAM_KEY, { audio: audio || undefined, video: local.video ? { track: local.video, options: { enableSimulcast: false } } : undefined });
      snapshot();
    },
    async shareScreen(track) {
      await room.addStream(SCREEN_STREAM_KEY, { video: { track } });
      snapshot();
    },
    async stopScreen() {
      await room.removeStream(SCREEN_STREAM_KEY).catch(() => undefined);
      snapshot();
    },
    sendMessage(payload, recipients) {
      return room.sendMessage({ type: "text", payload: JSON.stringify(payload) }, recipients).catch(() => undefined);
    },
    setSubscriptionPolicy(next) { policy = typeof next === "function" ? next : () => true; return applySubscriptions(); },
    applySubscriptions,
    updateToken(token) { return room.updateClientToken(token); },
    async leave() {
      if (disposed) return;
      disposed = true;
      for (const off of unsubscribes) { try { off(); } catch { /* already gone */ } }
      await room.disconnect().catch(() => undefined);
    },
  };
}

export async function getLocalMedia({ audio = true, video = true, videoDeviceId = null, audioDeviceId = null } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Media devices are unavailable");
  const constraints = {
    audio: audio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {}) } : false,
    video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 }, ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {}) } : false,
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  return { audio: stream.getAudioTracks()[0] || null, video: stream.getVideoTracks()[0] || null };
}

export function stopTracks(...tracks) {
  for (const track of tracks) { try { track?.stop(); } catch { /* ignore */ } }
}
