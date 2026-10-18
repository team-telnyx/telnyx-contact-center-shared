import test from "node:test";
import assert from "node:assert/strict";
import {
  floatToPcm16, mixToMono, resampleLinear, silencePcm16, framePcm16, buildInjection,
  decodeToPcm16Mono, createPacedSender,
} from "../lib/ai/pcm16-injection.mjs";

const int16At = (bytes, index) => new DataView(bytes.buffer, bytes.byteOffset).getInt16(index * 2, true);

test("float samples become clamped little-endian PCM16", () => {
  const pcm = floatToPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
  assert.equal(pcm.length, 12);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => int16At(pcm, i)), [0, 32767, -32768, 32767, -32768, 16384]);
});

test("stereo buffers are mixed to mono and resampled linearly", () => {
  const buffer = { numberOfChannels: 2, length: 4, getChannelData: (c) => Float32Array.from(c === 0 ? [1, 1, 1, 1] : [0, 0, 0, 0]) };
  assert.deepEqual([...mixToMono(buffer)], [0.5, 0.5, 0.5, 0.5]);
  const down = resampleLinear(Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]), 16000, 8000);
  assert.equal(down.length, 4);
  assert.deepEqual([...down], [0, 2, 4, 6]);
  assert.equal(resampleLinear(Float32Array.from([1, 2]), 16000, 16000).length, 2);
});

test("frames carry whole 20 ms chunks and the tail is zero-padded", () => {
  const speech = new Uint8Array(640 * 2 + 10).fill(7);
  const frames = framePcm16(speech, { rate: 16000, frameMs: 20 });
  assert.equal(frames.length, 3);
  assert.ok(frames.every((frame) => frame.length === 640));
  assert.equal(frames[2][9], 7);
  assert.equal(frames[2][10], 0);
  assert.equal(silencePcm16(800, 16000).length, 16000 * 0.8 * 2);
});

test("an injection wraps speech in lead-in and trailing silence so server VAD closes the turn", () => {
  const speech = new Uint8Array(16000 * 2).fill(1); // one second
  const { frames, durationMs, speechMs } = buildInjection(speech, { rate: 16000, leadSilenceMs: 100, trailSilenceMs: 800 });
  assert.equal(speechMs, 1000);
  assert.equal(durationMs, 1900);
  assert.equal(frames.length, 95);
  assert.ok(frames[0].every((byte) => byte === 0), "first frame is silence");
  assert.ok(frames.at(-1).every((byte) => byte === 0), "last frame is silence");
  assert.throws(() => buildInjection(new Uint8Array(3)), /Invalid PCM16/);
  assert.throws(() => buildInjection(new Uint8Array(0)), /Invalid PCM16/);
});

test("decoding resamples to the socket rate through the offline context", async () => {
  class OfflineAudioContext {
    constructor(channels, length, rate) { this.sampleRate = rate; }
    async decodeAudioData() { return { sampleRate: 48000, numberOfChannels: 1, length: 6, getChannelData: () => Float32Array.from([0, 0.5, 0.5, 0.5, 0.5, 0.5]) }; }
  }
  const pcm = await decodeToPcm16Mono(new ArrayBuffer(8), { rate: 16000, OfflineAudioContext });
  assert.equal(pcm.length, 4); // 6 samples at 48 kHz → 2 samples at 16 kHz
  await assert.rejects(decodeToPcm16Mono(new ArrayBuffer(8), { rate: 16000, OfflineAudioContext: undefined }), /not available/);
});

function fakeClock() {
  let time = 0; const timers = [];
  return {
    now: () => time,
    setTimer: (fn, ms) => { const timer = { at: time + ms, fn, cancelled: false }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.cancelled = true; },
    async advance(ms) {
      const target = time + ms;
      for (;;) {
        const due = timers.filter((t) => !t.cancelled && t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        time = due.at;
        due.fn();
        await Promise.resolve();
      }
      time = target;
    },
  };
}

test("frames leave at real-time pace with a small lead and bounded catch-up bursts", async () => {
  const clock = fakeClock(), sentAt = [];
  const frames = Array.from({ length: 50 }, (_, i) => Uint8Array.of(i));
  const sender = createPacedSender(frames, { send: (frame, index) => sentAt.push({ index, at: clock.now() }), frameMs: 20, leadMs: 100, maxBurst: 10, ...clock });
  assert.equal(sentAt.length, 6, "lead window sends the first 100 ms at once");
  await clock.advance(200);
  assert.equal(sentAt.length, 16);
  assert.equal(sentAt[15].at, 200, "frame 15 (due at 300 ms) leaves 100 ms early");
  // A throttled timer (e.g. background tab) catches up in bounded bursts, not all at once.
  await clock.advance(1000);
  const result = await sender.done;
  assert.deepEqual(result, { sent: 50, cancelled: false });
  const perTick = new Map(); for (const { at } of sentAt) perTick.set(at, (perTick.get(at) || 0) + 1);
  assert.ok(Math.max(...perTick.values()) <= 10, "never more than maxBurst frames per tick");
  assert.deepEqual(sentAt.map((s) => s.index), frames.map((_, i) => i), "order preserved");
});

test("a cancelled injection stops sending and a failing send rejects", async () => {
  const clock = fakeClock(), sent = [];
  const sender = createPacedSender(Array.from({ length: 20 }, () => new Uint8Array(2)), { send: (f) => sent.push(f), frameMs: 20, leadMs: 0, maxBurst: 1, ...clock });
  await clock.advance(40);
  sender.cancel();
  await clock.advance(1000);
  assert.deepEqual(await sender.done, { sent: 3, cancelled: true });
  assert.equal(sent.length, 3);

  const failing = createPacedSender([new Uint8Array(2)], { send: () => { throw new Error("socket closed"); }, ...clock });
  await assert.rejects(failing.done, /socket closed/);
});

test("the silence streamer keeps the line alive between utterances and pauses during injection", async () => {
  const { createSilenceStreamer } = await import("../lib/ai/pcm16-injection.mjs");
  const sent = []; let paused = false, tick = null;
  const stop = createSilenceStreamer({ send: (f) => sent.push(f), isPaused: () => paused, rate: 16000, frameMs: 20, intervalMs: 100, setTimer: (fn) => { tick = fn; return "timer"; }, clearTimer: (id) => { assert.equal(id, "timer"); tick = null; } });
  tick();
  assert.equal(sent.length, 5, "100 ms of 20 ms frames per tick");
  assert.ok(sent.every((f) => f.length === 640 && f.every((b) => b === 0)));
  paused = true; tick();
  assert.equal(sent.length, 5, "nothing while an utterance is being injected");
  paused = false;
  const throwing = createSilenceStreamer({ send: () => { throw new Error("closed"); }, setTimer: (fn) => { fn(); return 1; }, clearTimer: () => {} });
  throwing();
  stop(); stop();
  assert.equal(tick, null);
});
