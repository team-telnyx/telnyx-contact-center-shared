import assert from "node:assert/strict";
import test from "node:test";

import {
  concatUint8Arrays,
  createLeadingSilenceTrimmer,
  discardPendingLeadingSilence,
  normalizeAssistantPcm16Format,
  splitPcm16ByDuration,
  StreamingPcm16MonoResampler,
  trimLeadingSilencePcm16,
} from "../lib/ai/avatar-audio-pipeline.mjs";

function pcm16(samples) {
  const output = new Uint8Array(samples.length * 2);
  const view = new DataView(output.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return output;
}

function pcm16Samples(audio) {
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  return Array.from(
    { length: audio.byteLength / 2 },
    (_, index) => view.getInt16(index * 2, true)
  );
}

test("normalizes valid assistant PCM16 metadata and rejects invalid layouts", () => {
  assert.deepEqual(
    normalizeAssistantPcm16Format({
      encoding: "PCM16",
      sampleRate: 24000,
      channels: 2,
    }),
    { encoding: "pcm_s16le", sampleRate: 24000, channels: 2 }
  );
  assert.throws(
    () =>
      normalizeAssistantPcm16Format({
        encoding: "opus",
        sampleRate: 24000,
        channels: 1,
      }),
    /requires PCM16/
  );
  assert.throws(
    () =>
      normalizeAssistantPcm16Format({
        encoding: "pcm16",
        sampleRate: 24000,
        channels: 3,
      }),
    /channels must be 1 or 2/
  );
});

test("leading-silence trimming retains pre-roll across source chunks", () => {
  const state = createLeadingSilenceTrimmer({
    sampleRate: 1000,
    channels: 1,
    threshold: 128,
    prerollMs: 2,
  });

  const silence = trimLeadingSilencePcm16(state, pcm16([0, 0, 0, 0, 0]));
  assert.equal(silence.foundAudio, false);
  assert.equal(silence.audio.byteLength, 0);

  const onset = trimLeadingSilencePcm16(state, pcm16([0, 1000, 2000]));
  assert.equal(onset.foundAudio, true);
  assert.deepEqual(pcm16Samples(onset.audio), [0, 0, 1000, 2000]);
  assert.equal(state.trimmedBytes, 8);
});

test("a wholly silent response is discarded and counted", () => {
  const state = createLeadingSilenceTrimmer({
    sampleRate: 16000,
    channels: 1,
  });
  trimLeadingSilencePcm16(state, pcm16([0, 0, 0, 0]));
  assert.equal(discardPendingLeadingSilence(state), 8);
});

test("Anam chunks never exceed 500ms and preserve complete PCM frames", () => {
  const format = { sampleRate: 16000, channels: 2 };
  const source = new Uint8Array(16000 * 4 * 1.2);
  const chunks = splitPcm16ByDuration(source, format, 500);

  assert.deepEqual(
    chunks.map((chunk) => chunk.byteLength),
    [32000, 32000, 12800]
  );
  assert.ok(chunks.every((chunk) => chunk.byteLength % 4 === 0));
  assert.deepEqual(
    concatUint8Arrays(
      concatUint8Arrays(chunks[0], chunks[1]),
      chunks[2]
    ),
    source
  );
});

test("streaming resampling is continuous across uneven source chunks", () => {
  const samples = Array.from({ length: 320 }, (_, index) =>
    Math.round(Math.sin(index / 13) * 12000)
  );
  const source = pcm16(samples);

  const whole = new StreamingPcm16MonoResampler(
    { sampleRate: 16000, channels: 1 },
    24000
  );
  const expected = concatUint8Arrays(whole.push(source), whole.flush());

  const streaming = new StreamingPcm16MonoResampler(
    { sampleRate: 16000, channels: 1 },
    24000
  );
  let actual = new Uint8Array();
  for (const [start, end] of [
    [0, 74],
    [74, 246],
    [246, source.byteLength],
  ]) {
    actual = concatUint8Arrays(actual, streaming.push(source.subarray(start, end)));
  }
  actual = concatUint8Arrays(actual, streaming.flush());

  assert.equal(actual.byteLength, 480 * 2);
  assert.deepEqual(actual, expected);
});

test("streaming resampler downmixes stereo without resetting between deltas", () => {
  const stereo = pcm16([8000, -2000, 6000, 2000]);
  const resampler = new StreamingPcm16MonoResampler(
    { sampleRate: 24000, channels: 2 },
    24000
  );
  assert.deepEqual(pcm16Samples(resampler.push(stereo)), [3000, 4000]);
  assert.equal(resampler.flush().byteLength, 0);
});
