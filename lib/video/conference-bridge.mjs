// Runs only in the media worker's isolated Chromium context. No account key,
// customer browser lifetime or Next.js request owns this participant.
import { joinVideoRoom } from "./room-client.mjs";
import { TelnyxAvatarClient } from "../ai/telnyx-avatar-client.mjs";
import { StreamingPcm16MonoResampler } from "../ai/avatar-audio-pipeline.mjs";
import { chooseVisionSource, sourceKey, visionImageFrame } from "./vision-policy.mjs";
import { waitForRoomPlayback } from "./playback-gate.mjs";

export async function startConferenceBridge(config) {
  let stopped = false, snapshot = { remote: [], participants: [] }, state = config.state;
  let lastContact = Date.now(), timer, frameTimer, safetyTimer, publishedAudio, publishedVideo, muted = state.desiredState !== "active";
  let current = null, transitionUntil = 0, lastRequest = state.vision.requestId, generation = 0, upload = null, lastImageAt = 0;
  let fallbackReason = null;
  const publications = new Map(), inputs = new Map();
  const playbackReceipts = new Map();
  let publishing = Promise.resolve();
  const client = new TelnyxAvatarClient();
  const video = document.createElement("video"); video.autoplay = true; video.playsInline = true; video.volume = 0; document.body.append(video);
  client.attachVideo(video);
  const capture = document.createElement("video"); capture.muted = true; capture.autoplay = true; capture.playsInline = true; document.body.append(capture);
  const canvas = document.createElement("canvas"), drawing = canvas.getContext("2d");
  const audio = new AudioContext({ sampleRate: 16000 }); await audio.resume();
  await audio.audioWorklet.addModule("/audio/telnyx-avatar-input.js");
  const worklet = new AudioWorkletNode(audio, "telnyx-avatar-input"); worklet.connect(audio.destination);
  const resampler = new StreamingPcm16MonoResampler({ sampleRate: audio.sampleRate, channels: 1 }, 16000);
  worklet.port.onmessage = ({ data }) => {
    if (stopped || muted || upload || Date.now() < transitionUntil || !client.active) return;
    const bytes = new Uint8Array(data.length * 2), view = new DataView(bytes.buffer);
    for (let i = 0; i < data.length; i++) view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(data[i] * 32768))), true);
    const pcm = resampler.push(bytes); if (pcm.length) client.appendInputAudio(pcm);
  };
  const memberFor = stream => state.members.find(m => m.participant_id === stream.participantId && m.id === stream.admissionId && ["customer", "agent"].includes(m.role));
  const room = await joinVideoRoom({ roomId: config.roomId, token: config.token, context: { role: "ai", name: config.name || "AI assistant" },
    shouldSubscribe: stream => Boolean(state.members.find(m => m.participant_id === stream.participantId)),
    onChange: next => { snapshot = next; reconcileAudio(); },
    onMessage: (message, from) => { if (message?.type === "ai.media.playing") playbackReceipts.set(from, message.nonce); },
    onDisconnected: () => void stop("room_disconnected") });
  function reconcileAudio() {
    const wanted = new Set();
    for (const stream of snapshot.remote) {
      const member = memberFor(stream);
      if (!member || stream.key !== "self" || !stream.audioTrack || !stream.audioEnabled) continue;
      const key = `${stream.participantId}/${stream.key}`; wanted.add(key);
      if (inputs.get(key)?.track === stream.audioTrack) continue;
      inputs.get(key)?.node.disconnect();
      const node = audio.createMediaStreamSource(new MediaStream([stream.audioTrack])); node.connect(worklet);
      inputs.set(key, { track: stream.audioTrack, node });
    }
    for (const [key, input] of inputs) if (!wanted.has(key)) { input.node.disconnect(); inputs.delete(key); }
  }
  function sources() {
    const result = [], live = new Set();
    for (const stream of snapshot.remote) {
      const member = memberFor(stream);
      if (!member || !["self", "screen"].includes(stream.key) || !stream.videoTrack) continue;
      const identity = `${stream.participantId}/${stream.key}`; live.add(identity);
      let publication = publications.get(identity);
      if (!publication || publication.track !== stream.videoTrack) { publication = { generation: ++generation, track: stream.videoTrack }; publications.set(identity, publication); }
      const kind = stream.key === "screen" ? "screen" : "camera";
      const source = { participantId: stream.participantId, streamKey: stream.key, generation: publication.generation,
        name: member.name || null, role: member.role, type: `${member.role}-${kind}`, available: stream.videoEnabled && stream.videoTrack.readyState === "live" && !stream.videoTrack.muted,
        consented: member.consent?.[kind] === true, track: stream.videoTrack };
      source.key = sourceKey(source); result.push(source);
    }
    for (const key of publications.keys()) if (!live.has(key)) publications.delete(key);
    return result;
  }
  function cancel() { if (client.active) { client.send({ type: "response.cancel" }); client.clearPcm(); } }
  function selectSource(next) {
    if (sourceKey(next) === sourceKey(current)) { current = next; return; }
    const hadPrevious = Boolean(current); if (hadPrevious) cancel(); current = next;
    capture.srcObject = next ? new MediaStream([next.track]) : null;
    if (next) void capture.play().catch(() => undefined);
    // No documented provider buffer-clear command. Stop visual turns until
    // frames from the previous source have expired on the provider.
    if (hadPrevious) transitionUntil = Date.now() + 10500;
  }
  function captureFrame() {
    if (!current || !current.available || !current.consented || capture.readyState < 2 || !capture.videoWidth) return null;
    const screen = current.type.endsWith("-screen"), limit = screen ? 1280 : 640;
    const scale = Math.min(1, limit / capture.videoWidth, (screen ? 960 : 480) / capture.videoHeight);
    canvas.width = Math.round(capture.videoWidth * scale); canvas.height = Math.round(capture.videoHeight * scale) + 28;
    drawing.fillStyle = "#111"; drawing.fillRect(0, 0, canvas.width, canvas.height);
    drawing.drawImage(capture, 0, 28, canvas.width, canvas.height - 28);
    drawing.fillStyle = "white"; drawing.font = "16px sans-serif"; drawing.fillText(`Vision source: ${current.type}`, 8, 20);
    for (const quality of [0.8, 0.6, 0.4]) { try { return visionImageFrame(canvas.toDataURL("image/jpeg", quality)); } catch { /* Try a smaller encoded frame. */ } }
    return null;
  }
  function publishOutput() {
    publishing = publishing.then(publishOutputNow);
    return publishing;
  }
  async function publishOutputNow() {
    const output = client.fallback ? client.playbackStream : client.stream;
    const nextAudio = output?.getAudioTracks()[0] || null;
    const nextVideo = client.fallback ? null : output?.getVideoTracks()[0] || null;
    if (!nextAudio) return;
    if (publishedAudio?.source !== nextAudio) {
      const old = publishedAudio; publishedAudio = { source: nextAudio, track: nextAudio.clone() };
      publishedAudio.track.enabled = !muted && Date.now() >= transitionUntil;
      await room.setAudioTrack(publishedAudio.track); old?.track.stop();
    }
    if (publishedVideo?.source !== nextVideo) {
      const old = publishedVideo; publishedVideo = nextVideo ? { source: nextVideo, track: nextVideo.clone() } : null;
      await room.setVideoTrack(publishedVideo?.track || null); old?.track.stop();
    }
    publishedAudio.track.enabled = !muted && Date.now() >= transitionUntil;
  }
  client.on("assistant.event", frame => {
    if (frame.type === "avatar.error") fallbackReason = frame.error?.message || "Avatar provider error";
    if (frame.type === "response.done" && upload?.stage === "answering") {
      upload = { stage: "cooldown", until: Date.now() + 10500 };
    }
  });
  client.on("agent.error", () => void stop("assistant_unavailable"));
  // Refresh admissions while the customer is still joining; playback readiness
  // must not wait on a stale, initially empty membership snapshot.
  void tick();
  await client.connect();
  await client.startConversation({ capture: "none",
    beforeMediaReady: () => waitForRoomPlayback({ publish: publishOutput, stopped: () => stopped,
      participants: () => snapshot.participants.filter(p => !p.self && ["customer", "agent"].includes(p.role) && state.members.some(m => m.participant_id === p.participantId && m.id === p.admissionId)).map(p => p.participantId),
      send: (message, recipients) => room.sendMessage(message, recipients), received: playbackReceipts }),
    avatarSession: async () => ({ url: config.relayUrl, token: config.capability, authentication: "conference.authenticate", avatarEnabled: config.avatarEnabled }) });
  await publishOutput();
  async function tick() {
    if (stopped) return;
    try {
      const available = sources();
      const report = { sources: available.map(({ track, ...source }) => source), effectiveSourceKey: sourceKey(current), transitionUntil,
        participants: snapshot.participants.map(({participantId, admissionId, self}) => ({participantId, admissionId, self})),
        providerConversationId: client.conversationId, fallback: client.fallback, fallbackReason: client.fallbackReason || fallbackReason, inputCount: inputs.size, uploadStage: upload?.stage || null };
      state = await window.conferenceHostState(client.active ? report : undefined);
      lastContact = Date.now();
      if (state.stop) return stop("stopped");
      await room.applySubscriptions(); reconcileAudio();
      if (!client.active) { if (!stopped) timer = setTimeout(tick, 1000); return; }
      if (muted !== (state.desiredState !== "active")) {
        muted = state.desiredState !== "active";
        if (muted) { cancel(); upload = null; transitionUntil = Date.now() + 10500; }
      }
      const policy = { ...state.visionConfig, selection: state.vision.selection || state.visionConfig.selection };
      const selected = chooseVisionSource({ sources: sources(), config: policy, current,
        pinned: policy.selection === "manual" ? state.vision.requestedSourceKey || "paused" : null });
      if (lastRequest !== state.vision.requestId) {
        lastRequest = state.vision.requestId;
        if (upload) { upload = null; cancel(); transitionUntil = Date.now() + 10500; }
      }
      if (upload && Date.now() >= upload.until) {
        if (upload.stage === "draining") {
          const command = upload.command;
          upload = { ...upload, stage: "answering", until: Date.now() + 60000 };
          client.send(visionImageFrame(command.payload.imageUrl));
          client.sendConversationMessage(command.payload.prompt); lastImageAt = Date.now();
        } else { upload = null; }
      }
      if (!upload) selectSource(selected);
      await publishOutput();
      if (!muted && !upload && Date.now() >= transitionUntil) {
        for (const command of state.commands || []) {
          if (command.kind === "image") {
            const hadFrames = Boolean(current); selectSource(null); cancel();
            // Expire previous frames before the request. Keep the uploaded
            // image only in memory until this one response has finished.
            upload = { stage: "draining", command, until: Date.now() + (hadFrames ? 10500 : 0) };
          } else {
            const frame = command.payload.sourceKey === sourceKey(current) ? captureFrame() : null;
            if (frame) { client.send(frame); client.sendConversationMessage(command.payload.prompt); }
          }
          await window.conferenceHostComplete(command.id);
        }
      }
    } catch { if (Date.now() - lastContact > 8000) return stop("control_unavailable"); }
    if (!stopped) timer = setTimeout(tick, 1000);
  }
  frameTimer = setInterval(() => {
    if (stopped || muted || Date.now() < transitionUntil || !client.active) return;
    if (upload) {
      if (upload.stage === "answering" && Date.now() - lastImageAt >= 2000) {
        client.send(visionImageFrame(upload.command.payload.imageUrl)); lastImageAt = Date.now();
      }
      return;
    }
    const frame = captureFrame(); if (frame) client.send(frame);
  }, 2000);
  safetyTimer = setInterval(() => { if (Date.now() - lastContact > 10000) void stop("lease_unavailable"); }, 1000);
  async function stop(reason) {
    if (stopped) return; stopped = true; clearTimeout(timer); clearInterval(frameTimer); clearInterval(safetyTimer);
    for (const input of inputs.values()) input.node.disconnect(); inputs.clear();
    await client.disconnect().catch(() => undefined); await room.leave().catch(() => undefined); await audio.close().catch(() => undefined);
    publishedAudio?.track.stop(); publishedVideo?.track.stop(); capture.srcObject = null; upload = null;
    await window.conferenceHostStopped(reason).catch(() => undefined);
  }
  window.conferenceRefreshToken = token => room.updateToken(token);
  window.stopConferenceBridge = stop;
  window.conferenceBridgeStats = () => ({ participants: snapshot.participants.length, inputs: inputs.size, currentSource: sourceKey(current), active: client.active, fallback: client.fallback, fallbackReason: client.fallbackReason || fallbackReason, uploadStage: upload?.stage || null });
}
