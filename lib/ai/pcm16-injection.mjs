// Turn synthesized speech into the PCM16 frames the Telnyx conversation
// WebSocket expects from a caller, and send them at real-time pace.
//
// Telnyx accepts base64 PCM16 mono at the negotiated input rate in 20–100 ms
// chunks and rejects uploads that run ahead of its ingress budget, so a decoded
// TTS clip must be chunked and metered instead of pushed in one burst. Trailing
// silence lets the server-side voice activity detector close the caller's turn.
//
// Browser-safe: no Node imports. The decoder takes the OfflineAudioContext
// constructor as a parameter so it can be exercised without a browser.

export const PCM16_FRAME_MS = 20;
export const DEFAULT_INPUT_RATE = 16000;
export const DEFAULT_LEAD_SILENCE_MS = 100;
export const DEFAULT_TRAIL_SILENCE_MS = 800;

export function floatToPcm16(samples) {
  const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i] || 0));
    view.setInt16(i * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
  }
  return bytes;
}

// AudioBuffer-like: { numberOfChannels, length, getChannelData(index) }.
export function mixToMono(buffer) {
  const channels = Math.max(1, buffer.numberOfChannels || 1), mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < channels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < mono.length; i++) mono[i] += data[i] / channels;
  }
  return mono;
}

export function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate || !samples.length) return samples;
  const length = Math.max(1, Math.round((samples.length * toRate) / fromRate)), out = new Float32Array(length), ratio = fromRate / toRate;
  for (let i = 0; i < length; i++) {
    const position = i * ratio, left = Math.floor(position), right = Math.min(left + 1, samples.length - 1), fraction = position - left;
    out[i] = samples[left] + (samples[right] - samples[left]) * fraction;
  }
  return out;
}

export function silencePcm16(ms, rate = DEFAULT_INPUT_RATE) {
  return new Uint8Array(Math.max(0, Math.round((rate * ms) / 1000)) * 2);
}

export function concatPcm16(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0), out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

// Split PCM16 bytes into fixed-duration frames; the last frame is zero-padded
// so every frame carries whole samples of equal length.
export function framePcm16(pcm, { rate = DEFAULT_INPUT_RATE, frameMs = PCM16_FRAME_MS } = {}) {
  const frameBytes = Math.round((rate * frameMs) / 1000) * 2, frames = [];
  if (!frameBytes) throw new Error("Invalid frame size");
  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    const frame = new Uint8Array(frameBytes);
    frame.set(pcm.subarray(offset, offset + frameBytes));
    frames.push(frame);
  }
  return frames;
}

// Lead-in silence gives the detector a clean onset; trailing silence ends the
// caller's turn so the assistant answers without waiting for a timeout.
export function buildInjection(speech, { rate = DEFAULT_INPUT_RATE, frameMs = PCM16_FRAME_MS, leadSilenceMs = DEFAULT_LEAD_SILENCE_MS, trailSilenceMs = DEFAULT_TRAIL_SILENCE_MS } = {}) {
  if (!(speech instanceof Uint8Array) || !speech.length || speech.length % 2) throw new Error("Invalid PCM16 speech");
  const frames = framePcm16(concatPcm16([silencePcm16(leadSilenceMs, rate), speech, silencePcm16(trailSilenceMs, rate)]), { rate, frameMs });
  return { frames, durationMs: frames.length * frameMs, speechMs: Math.round((speech.length / 2 / rate) * 1000) };
}

export async function decodeToPcm16Mono(arrayBuffer, { rate = DEFAULT_INPUT_RATE, OfflineAudioContext: Context = globalThis.OfflineAudioContext } = {}) {
  if (typeof Context !== "function") throw new Error("Audio decoding is not available in this browser");
  // decodeAudioData resamples to the context rate in current browsers; the
  // explicit resample below covers engines that keep the source rate.
  const context = new Context(1, 1, rate);
  const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
  const mono = mixToMono(decoded);
  return floatToPcm16(decoded.sampleRate === rate ? mono : resampleLinear(mono, decoded.sampleRate, rate));
}

// Sends frames so that frame i leaves at i × frameMs after start (minus a small
// lead so the first frames arrive before they are due). Catch-up after a
// throttled timer is bounded by maxBurst frames per tick.
export function createPacedSender(frames, { send, frameMs = PCM16_FRAME_MS, leadMs = 100, maxBurst = 10, now = () => (globalThis.performance?.now?.() ?? Date.now()), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id) } = {}) {
  if (typeof send !== "function") throw new Error("send is required");
  let index = 0, timer = null, finished = false, resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const start = now();
  const finish = (result) => { if (finished) return; finished = true; if (timer !== null) clearTimer(timer); timer = null; resolveDone(result); };
  const tick = () => {
    timer = null;
    if (finished) return;
    const elapsed = now() - start;
    const due = Math.min(frames.length, Math.floor((elapsed + leadMs) / frameMs) + 1);
    let burst = 0;
    try {
      while (index < due && burst < maxBurst) { send(frames[index], index); index++; burst++; }
    } catch (error) {
      finished = true; rejectDone(error); return;
    }
    if (index >= frames.length) return finish({ sent: index, cancelled: false });
    const nextDue = index * frameMs - leadMs - (now() - start);
    timer = setTimer(tick, burst >= maxBurst ? 0 : Math.max(1, nextDue));
  };
  tick();
  return { done, cancel: () => finish({ sent: index, cancelled: true }) };
}

// A caller on a phone line never stops sending audio: between utterances the
// line carries silence. Server-side VAD relies on that stream to measure the
// pause after speech, so the simulated caller keeps sending silent frames
// whenever no utterance is being injected. Returns a stop function.
export function createSilenceStreamer({ send, isPaused = () => false, rate = DEFAULT_INPUT_RATE, frameMs = PCM16_FRAME_MS, intervalMs = 100, setTimer = (fn, ms) => setInterval(fn, ms), clearTimer = (id) => clearInterval(id) } = {}) {
  if (typeof send !== "function") throw new Error("send is required");
  const frame = silencePcm16(frameMs, rate), perTick = Math.max(1, Math.round(intervalMs / frameMs));
  let stopped = false;
  const timer = setTimer(() => {
    if (stopped || isPaused()) return;
    try { for (let i = 0; i < perTick; i++) send(frame); } catch { /* the conversation is closing; the owner stops the streamer */ }
  }, intervalMs);
  return () => { if (stopped) return; stopped = true; clearTimer(timer); };
}
