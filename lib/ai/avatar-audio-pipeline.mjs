export const DEFAULT_LEADING_SILENCE_THRESHOLD = 128;
export const DEFAULT_LEADING_SILENCE_PREROLL_MS = 2;

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return parsed;
}

export function normalizeAssistantPcm16Format(format = {}) {
  if (String(format.encoding || "").toLowerCase() !== "pcm16") {
    throw new TypeError("Avatar audio passthrough requires PCM16 audio");
  }

  const sampleRate = requirePositiveInteger(format.sampleRate, "sampleRate");
  const channels = requirePositiveInteger(format.channels, "channels");
  if (channels !== 1 && channels !== 2) {
    throw new TypeError("channels must be 1 or 2");
  }

  return {
    encoding: "pcm_s16le",
    sampleRate,
    channels,
  };
}

export function pcm16FormatsMatch(left, right) {
  return Boolean(
    left &&
      right &&
      left.encoding === right.encoding &&
      left.sampleRate === right.sampleRate &&
      left.channels === right.channels
  );
}

export function concatUint8Arrays(left, right) {
  if (!left?.byteLength) return right || new Uint8Array();
  if (!right?.byteLength) return left;
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

function validatePcm16Audio(audio, channels) {
  if (!(audio instanceof Uint8Array)) {
    throw new TypeError("PCM16 audio must be a Uint8Array");
  }
  const frameBytes = 2 * requirePositiveInteger(channels, "channels");
  if (audio.byteLength % frameBytes !== 0) {
    throw new TypeError(
      `PCM16 chunk length ${audio.byteLength} is not aligned to ${frameBytes}-byte frames`
    );
  }
  return frameBytes;
}

export function splitPcm16ByDuration(audio, format, maxDurationMs = 500) {
  const sampleRate = requirePositiveInteger(format?.sampleRate, "sampleRate");
  const channels = requirePositiveInteger(format?.channels, "channels");
  const frameBytes = validatePcm16Audio(audio, channels);
  const durationMs = Number(maxDurationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new TypeError("maxDurationMs must be positive");
  }

  const maxFrames = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const maxBytes = maxFrames * frameBytes;
  const chunks = [];
  for (let offset = 0; offset < audio.byteLength; offset += maxBytes) {
    chunks.push(
      audio.subarray(offset, Math.min(offset + maxBytes, audio.byteLength))
    );
  }
  return chunks;
}

export function createLeadingSilenceTrimmer({
  sampleRate,
  channels,
  threshold = DEFAULT_LEADING_SILENCE_THRESHOLD,
  prerollMs = DEFAULT_LEADING_SILENCE_PREROLL_MS,
} = {}) {
  const normalizedRate = requirePositiveInteger(sampleRate, "sampleRate");
  const normalizedChannels = requirePositiveInteger(channels, "channels");
  const normalizedThreshold = Number(threshold);
  if (
    !Number.isInteger(normalizedThreshold) ||
    normalizedThreshold < 0 ||
    normalizedThreshold > 32767
  ) {
    throw new TypeError("threshold must be an integer from 0 to 32767");
  }
  const normalizedPrerollMs = Number(prerollMs);
  if (!Number.isFinite(normalizedPrerollMs) || normalizedPrerollMs < 0) {
    throw new TypeError("prerollMs must be non-negative");
  }

  return {
    channels: normalizedChannels,
    threshold: normalizedThreshold,
    prerollFrames: Math.round((normalizedRate * normalizedPrerollMs) / 1000),
    pending: true,
    tail: new Uint8Array(),
    trimmedBytes: 0,
  };
}

export function trimLeadingSilencePcm16(state, audio) {
  if (!state || !Number.isInteger(state.channels) || state.channels < 1) {
    throw new TypeError("A valid leading-silence trimmer is required");
  }
  const frameBytes = validatePcm16Audio(audio, state.channels);
  if (!state.pending) return { audio, foundAudio: true };

  const combined = concatUint8Arrays(state.tail, audio);
  const view = new DataView(
    combined.buffer,
    combined.byteOffset,
    combined.byteLength
  );
  const frameCount = combined.byteLength / frameBytes;
  let firstAudibleFrame = -1;

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < state.channels; channel += 1) {
      const offset = frame * frameBytes + channel * 2;
      if (Math.abs(view.getInt16(offset, true)) > state.threshold) {
        firstAudibleFrame = frame;
        break;
      }
    }
    if (firstAudibleFrame !== -1) break;
  }

  if (firstAudibleFrame !== -1) {
    const firstOutputFrame = Math.max(
      0,
      firstAudibleFrame - state.prerollFrames
    );
    const firstOutputByte = firstOutputFrame * frameBytes;
    state.trimmedBytes += firstOutputByte;
    state.pending = false;
    state.tail = new Uint8Array();
    return {
      audio: combined.subarray(firstOutputByte),
      foundAudio: true,
    };
  }

  const retainedBytes = Math.min(
    combined.byteLength,
    state.prerollFrames * frameBytes
  );
  state.trimmedBytes += combined.byteLength - retainedBytes;
  state.tail = retainedBytes
    ? combined.slice(combined.byteLength - retainedBytes)
    : new Uint8Array();
  return { audio: new Uint8Array(), foundAudio: false };
}

export function discardPendingLeadingSilence(state) {
  if (!state) return 0;
  if (state.pending) {
    state.trimmedBytes += state.tail.byteLength;
    state.tail = new Uint8Array();
  }
  return state.trimmedBytes;
}

function encodePcm16(samples) {
  const output = new Uint8Array(samples.length * 2);
  const view = new DataView(output.buffer);
  samples.forEach((sample, index) => {
    view.setInt16(
      index * 2,
      Math.max(-32768, Math.min(32767, Math.round(sample))),
      true
    );
  });
  return output;
}

export class StreamingPcm16MonoResampler {
  constructor(format, targetRate) {
    this.inputRate = requirePositiveInteger(format?.sampleRate, "sampleRate");
    this.channels = requirePositiveInteger(format?.channels, "channels");
    this.targetRate = requirePositiveInteger(targetRate, "targetRate");
    this.samples = [];
    this.baseInputFrame = 0;
    this.totalInputFrames = 0;
    this.nextOutputFrame = 0;
  }

  push(audio) {
    const frameBytes = validatePcm16Audio(audio, this.channels);
    const frameCount = audio.byteLength / frameBytes;
    if (!frameCount) return new Uint8Array();

    if (this.inputRate === this.targetRate && this.channels === 1) {
      this.totalInputFrames += frameCount;
      this.nextOutputFrame += frameCount;
      return audio;
    }

    const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
    const mono = [];
    for (let frame = 0; frame < frameCount; frame += 1) {
      let total = 0;
      for (let channel = 0; channel < this.channels; channel += 1) {
        total += view.getInt16(frame * frameBytes + channel * 2, true);
      }
      mono.push(total / this.channels);
    }
    this.totalInputFrames += frameCount;

    if (this.inputRate === this.targetRate) {
      this.nextOutputFrame += frameCount;
      return encodePcm16(mono);
    }

    for (const sample of mono) {
      this.samples.push(sample);
    }
    return this.drain(false);
  }

  flush() {
    if (this.inputRate === this.targetRate || !this.totalInputFrames) {
      return new Uint8Array();
    }
    return this.drain(true);
  }

  drain(final) {
    const output = [];
    const ratio = this.inputRate / this.targetRate;
    const expectedOutputFrames = final
      ? Math.round((this.totalInputFrames * this.targetRate) / this.inputRate)
      : Number.POSITIVE_INFINITY;
    const lastAvailableFrame =
      this.baseInputFrame + this.samples.length - 1;

    while (this.nextOutputFrame < expectedOutputFrames) {
      const sourcePosition = this.nextOutputFrame * ratio;
      const leftFrame = Math.floor(sourcePosition);
      if (!final && leftFrame + 1 > lastAvailableFrame) break;
      if (final && leftFrame > lastAvailableFrame) break;

      const rightFrame = Math.min(leftFrame + 1, lastAvailableFrame);
      const left = this.samples[leftFrame - this.baseInputFrame];
      const right = this.samples[rightFrame - this.baseInputFrame];
      const fraction = sourcePosition - leftFrame;
      output.push(left + (right - left) * fraction);
      this.nextOutputFrame += 1;
    }

    if (final) {
      this.samples = [];
      this.baseInputFrame = this.totalInputFrames;
    } else if (this.samples.length) {
      const nextSourceFrame = Math.floor(this.nextOutputFrame * ratio);
      const dropCount = Math.max(
        0,
        Math.min(this.samples.length, nextSourceFrame - this.baseInputFrame)
      );
      if (dropCount) {
        this.samples = this.samples.slice(dropCount);
        this.baseInputFrame += dropCount;
      }
    }

    return encodePcm16(output);
  }
}
