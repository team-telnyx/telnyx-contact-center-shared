import { StreamingPcm16MonoResampler } from "./avatar-audio-pipeline.mjs";

function pcm16Base64(pcm) {
  let binary = "";
  for (let offset = 0; offset < pcm.length; offset += 8192) binary += String.fromCharCode.apply(null, pcm.subarray(offset, offset + 8192));
  return btoa(binary);
}

// The same small event surface as TelnyxAIAgent lets the existing widget keep
// its transcript, call controls, session reporting, and expanded avatar layout.
export class TelnyxAvatarClient {
  constructor() {
    this.listeners = new Map(); this.generation = 0; this.isAuthenticated = false;
    this.held = false; this.sources = new Set(); this.nextAudioTime = 0;
  }
  on(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  off(name, fn) { this.listeners.get(name)?.delete(fn); }
  emit(name, value) { for (const fn of this.listeners.get(name) || []) fn(value); }
  async connect() { this.isAuthenticated = true; this.sessionId = "widget-avatar"; this.emit("agent.connected"); }
  async disconnect() { await this.endConversation(); this.isAuthenticated = false; }
  attachVideo(element) {
    this.video = element;
    if (element) {
      element.srcObject = this.stream || null; element.muted = this.held;
      if (this.stream) void element.play().then(() => this.acknowledgeMedia()).catch(() => this.fail(new Error("Avatar playback was blocked")));
    }
  }
  setPlaybackHeld(held) {
    this.held = Boolean(held);
    if (this.video) this.video.muted = this.held;
    if (this.gain) this.gain.gain.value = this.held ? 0 : 1;
  }
  send(frame) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Avatar connection is not ready");
    if (this.socket.bufferedAmount > 128000) {
      if (frame.type === "input_audio_buffer.append") return;
      throw new Error("The call connection is too slow. Try again.");
    }
    this.socket.send(JSON.stringify(frame));
  }
  async acknowledgeMedia() {
    if (this.mediaReady || this.acknowledging || this.pc?.connectionState !== "connected" || this.stream?.getTracks().filter((track) => track.readyState === "live").length !== 2 || !this.video) return;
    this.acknowledging = true;
    const generation = this.generation;
    try {
      await this.video.play();
      if (generation !== this.generation || this.fallback || !this.video || this.video.readyState < 2) return;
      await this.beforeMediaReady?.();
      if (generation !== this.generation || this.fallback) return;
      this.mediaReady = true;
      this.send({ type: "avatar.media.ready" });
      this.emit("avatar.phase", "ready");
    } finally { this.acknowledging = false; }
  }
  // capture: "microphone" streams the browser microphone (default); "none" opens
  // the conversation without any capture so the caller can push PCM16 frames
  // through appendInputAudio (the workflow voice test injects synthesized speech).
  async startConversation({ avatarSession, capture = "microphone", beforeMediaReady }) {
    await this.endConversation();
    const generation = ++this.generation;
    this.ending = false; this.fallback = false; this.mediaReady = false; this.active = false; this.conversationId = null;
    this.beforeMediaReady = beforeMediaReady;
    this.emit("avatar.phase", "starting");
    const stale = () => generation !== this.generation;
    try {
      const context = this.context = new AudioContext({ sampleRate: 16000 });
      await context.resume();
      this.gain = context.createGain(); this.gain.gain.value = this.held ? 0 : 1; this.gain.connect(context.destination);
      if (context.createMediaStreamDestination) {
        this.playbackDestination = context.createMediaStreamDestination();
        this.gain.connect(this.playbackDestination); this.playbackStream = this.playbackDestination.stream;
      }
      if (capture === "microphone") {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (stale()) { stream.getTracks().forEach((track) => track.stop()); return; }
        this.microphone = stream;
        await context.audioWorklet.addModule("/audio/telnyx-avatar-input.js");
        if (stale()) return;
        this.input = context.createMediaStreamSource(stream);
        this.worklet = new AudioWorkletNode(context, "telnyx-avatar-input");
        const resampler = new StreamingPcm16MonoResampler({ sampleRate: context.sampleRate, channels: 1 }, 16000);
        this.worklet.port.onmessage = ({ data }) => {
          if (!this.active || stale()) return;
          const bytes = new Uint8Array(data.length * 2), view = new DataView(bytes.buffer);
          for (let i = 0; i < data.length; i++) view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(data[i] * 32768))), true);
          const pcm = resampler.push(bytes);
          if (!pcm.length) return;
          try { this.send({ type: "input_audio_buffer.append", audio: pcm16Base64(pcm) }); } catch (error) { this.fail(error); }
        };
        this.input.connect(this.worklet).connect(context.destination); // Worklet output is silence.
      }
      const session = await avatarSession();
      if (stale()) return;
      this.fallback = session.avatarEnabled === false;
      // Audio-only conversations can greet immediately after authentication.
      if (this.fallback) await this.beforeMediaReady?.();
      if (stale()) return;
      await new Promise((resolve, reject) => {
        this.resolveStart = resolve; this.rejectStart = reject;
        this.setupTimer = setTimeout(() => this.fail(new Error("Avatar preparation timed out")), 70000);
        const socket = this.socket = new WebSocket(session.url);
        let delivery = Promise.resolve();
        socket.onopen = () => { if (!stale()) this.send({ type: session.authentication || "widget.authenticate", token: session.token, ...(session.publicId ? { publicId: session.publicId } : {}) }); };
        socket.onmessage = ({ data }) => {
          delivery = delivery.then(() => stale() ? undefined : this.receive(JSON.parse(data), generation)).catch((error) => { if (!stale()) this.fail(error); });
        };
        socket.onerror = () => { if (!stale()) this.fail(new Error("Avatar connection failed")); };
        socket.onclose = (event) => {
          // Let queued terminal frames finish before interpreting the close.
          void delivery.then(() => {
            if (stale() || this.ending) return;
            if (event.code !== 1000 || !this.active) this.fail(new Error("Avatar service unavailable"));
            else void this.endConversation();
          });
        };
      });
    } catch (error) {
      if (!stale()) await this.endConversation();
      throw error;
    }
  }
  // Push one PCM16 mono 16 kHz chunk as the caller's voice. Only valid while the
  // conversation is active; congested uploads are dropped by send() like the
  // microphone path.
  appendInputAudio(pcm) {
    if (!this.active) throw new Error("Conversation not ready");
    if (!(pcm instanceof Uint8Array) || !pcm.length || pcm.length % 2) throw new Error("Invalid PCM16 audio");
    this.send({ type: "input_audio_buffer.append", audio: pcm16Base64(pcm) });
  }
  async receive(frame, generation) {
    // Every upstream frame is also exposed raw, so callers can run their own
    // turn logic on the documented Telnyx events without re-deriving them from
    // the simplified agent/user state events below.
    this.emit("assistant.event", frame);
    if (frame.type === "avatar.session.ready") {
      const pc = this.pc = new RTCPeerConnection(frame.ice_configuration);
      this.stream = new MediaStream();
      let offered = false;
      const pending = [];
      pc.onicecandidate = ({ candidate }) => {
        if (generation !== this.generation || this.fallback) return;
        const frame = { type: "avatar.ice_candidate", candidate: candidate?.toJSON() || null };
        if (offered) { try { this.send(frame); } catch (error) { this.fail(error); } } else pending.push(frame);
      };
      pc.ontrack = ({ track }) => {
        if (generation !== this.generation) return;
        this.stream.addTrack(track);
        if (this.video) { this.video.srcObject = this.stream; this.video.onplaying = () => void this.acknowledgeMedia().catch((error) => this.fail(error)); }
        void this.acknowledgeMedia().catch((error) => this.fail(error));
      };
      pc.onconnectionstatechange = () => {
        if (generation !== this.generation || this.fallback) return;
        if (pc.connectionState === "failed") {
          if (this.active) this.useAudioFallback("Avatar WebRTC connection failed");
          else this.fail(new Error("Avatar media connection failed"));
        }
        else void this.acknowledgeMedia().catch((error) => this.fail(error));
      };
      pc.addTransceiver("audio", { direction: "recvonly" }); pc.addTransceiver("video", { direction: "recvonly" });
      await pc.setLocalDescription(await pc.createOffer());
      if (generation !== this.generation) return;
      this.send({ type: "avatar.webrtc.offer", offer: { type: "offer", sdp: pc.localDescription.sdp } });
      offered = true; for (const candidate of pending) this.send(candidate);
    } else if (frame.type === "avatar.webrtc.answer") {
      await this.pc.setRemoteDescription(frame.answer);
    } else if (frame.type === "session.created") {
      const rate = frame.session?.audio?.output?.format?.rate;
      if (!Number.isFinite(rate) || rate < 8000 || rate > 96000) throw new Error("Unsupported assistant audio format");
      this.outputRate = rate; this.active = true; this.conversationId = frame.session?.conversation_id || null;
      clearTimeout(this.setupTimer);
      this.call = { state: "active", localStream: this.microphone, muteAudio: () => this.microphone?.getAudioTracks().forEach((track) => { track.enabled = false; }), unmuteAudio: () => this.microphone?.getAudioTracks().forEach((track) => { track.enabled = true; }) };
      this.emit("conversation.update", { call: this.call });
      this.emit("conversation.agent.state", { state: "listening" });
      this.resolveStart?.(); this.resolveStart = null; this.rejectStart = null;
    } else if (frame.type === "avatar.error") {
      if (frame.error?.fatal === false && this.active) {
        this.useAudioFallback(frame.error?.message || "Avatar provider degraded to audio");
      } else throw new Error(frame.error?.message || "Avatar unavailable");
    } else if (frame.type === "error") {
      throw new Error(frame.error?.message || "Assistant request failed");
    } else if (frame.type === "response.output_audio.delta") {
      if (this.fallback) this.playPcm(frame.delta);
    } else if (frame.type === "response.output_audio_transcript.delta") {
      const itemId = frame.item_id || frame.response_id || "assistant";
      this.emit("transcript.item", { id: itemId, role: "assistant", content: frame.delta || "", timestamp: new Date().toISOString() });
      this.emit("conversation.agent.state", { state: "speaking", itemId });
    } else if (frame.type === "conversation.item.input_audio_transcription.completed") {
      this.emit("conversation.user.state", { state: "idle" });
      this.emit("transcript.item", { id: frame.item_id || crypto.randomUUID(), role: "user", content: frame.transcript || "", timestamp: new Date().toISOString() });
      this.emit("conversation.agent.state", { state: "thinking" });
    } else if (frame.type === "input_audio_buffer.speech_started") {
      this.clearPcm(); this.emit("conversation.agent.state", { state: "listening" });
      this.emit("conversation.user.state", { state: "speaking" });
    } else if (frame.type === "input_audio_buffer.speech_stopped") {
      this.emit("conversation.user.state", { state: "transcribing" });
    } else if (frame.type === "response.created") {
      this.emit("conversation.agent.state", { state: "thinking" });
    } else if (frame.type === "response.done") {
      this.emit("conversation.agent.state", { state: "listening" });
    } else if (frame.type === "session.ended") {
      await this.endConversation();
    }
  }
  useAudioFallback(reason = "Avatar media unavailable") {
    if (this.fallback) return;
    this.fallbackReason = reason;
    this.fallback = true; this.closeMedia(); this.clearPcm();
    this.emit("avatar.unavailable", "audio_only");
  }
  playPcm(encoded) {
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    if (!bytes.length || bytes.length % 2) return;
    const buffer = this.context.createBuffer(1, bytes.length / 2, this.outputRate), view = new DataView(bytes.buffer);
    for (let i = 0; i < buffer.length; i++) buffer.getChannelData(0)[i] = view.getInt16(i * 2, true) / 32768;
    const start = Math.max(this.context.currentTime + 0.02, this.nextAudioTime);
    // Telnyx can generate a spoken answer much faster than real-time playback.
    // A normal paragraph can queue over 15 seconds; that is not a network error.
    // Keep a bounded queue to prevent an unbounded response consuming memory.
    if (start + buffer.duration - this.context.currentTime > 120) throw new Error("The assistant's response is too long to play. Try a shorter request.");
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.gain);
    this.sources.add(source); source.onended = () => { this.sources.delete(source); source.disconnect(); };
    source.start(start); this.nextAudioTime = start + buffer.duration;
  }
  clearPcm() { for (const source of this.sources) { try { source.stop(); } catch {} source.disconnect(); } this.sources.clear(); this.nextAudioTime = 0; }
  sendConversationMessage(text) {
    if (!this.active) throw new Error("Conversation not ready");
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  }
  closeMedia() {
    if (this.pc) { this.pc.onconnectionstatechange = null; this.pc.onicecandidate = null; this.pc.ontrack = null; this.pc.close(); this.pc = null; }
    this.stream?.getTracks().forEach((track) => track.stop()); this.stream = null;
    if (this.video) { this.video.onplaying = null; this.video.pause(); this.video.srcObject = null; }
  }
  fail(error) {
    if (this.ending) return;
    // An error listener may synchronously disconnect. Preserve the original
    // startup failure before that teardown can replace it with "cancelled".
    this.rejectStart?.(error); this.rejectStart = null; this.resolveStart = null;
    this.emit("agent.error", error);
    void this.endConversation({ failed: true });
  }
  async endConversation({ failed = false } = {}) {
    this.ending = true; this.generation += 1; clearTimeout(this.setupTimer);
    this.rejectStart?.(new Error("Conversation cancelled")); this.rejectStart = null; this.resolveStart = null;
    const active = this.active; this.active = false;
    // Browser WebSockets allow application codes in 3000–4999, not 1011.
    if (this.socket) { this.socket.onopen = null; this.socket.onmessage = null; this.socket.onclose = null; this.socket.onerror = null; this.socket.close(failed ? 4000 : 1000, failed ? "Avatar client failed" : "Call ended"); this.socket = null; }
    this.closeMedia(); this.clearPcm();
    this.playbackStream?.getTracks().forEach((track) => track.stop()); this.playbackStream = null;
    this.playbackDestination?.disconnect(); this.playbackDestination = null;
    this.microphone?.getTracks().forEach((track) => track.stop()); this.microphone = null;
    if (this.worklet) { this.worklet.port.onmessage = null; this.worklet.disconnect(); this.worklet = null; }
    this.input?.disconnect(); this.input = null;
    const context = this.context; this.context = null;
    if (context && context.state !== "closed") await context.close();
    this.emit("avatar.phase", "idle");
    this.emit("conversation.user.state", { state: "idle" });
    this.emit("conversation.agent.state", { state: "listening" });
    if (active) this.emit("conversation.update", { call: { state: "hangup" } });
  }
}
