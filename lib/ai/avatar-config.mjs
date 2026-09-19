// Real-time avatar settings of the web widget voice call. The source of truth
// is the widget configuration (`channels.voice.avatar`, Widget Studio →
// Avatars); the bootstrap exposes the public subset and the voice runtime
// works on the normalized shape below. Ported from the Demo Portal
// (lib/ai/avatar-config.mjs) with the Contact Center expanded-view options.
import {
  concatUint8Arrays,
  StreamingPcm16MonoResampler,
} from "./avatar-audio-pipeline.mjs";

export const HEYGEN_AVATAR_PROVIDER = "heygen";
export const ANAM_AVATAR_PROVIDER = "anam";
export const AVATAR_PROVIDERS = Object.freeze([
  HEYGEN_AVATAR_PROVIDER,
  ANAM_AVATAR_PROVIDER,
]);
export const DEFAULT_AVATAR_ID = null;
export const DEFAULT_AVATAR_DISPLAY_FORMAT = "portrait";
export const LIVEAVATAR_ASPECT_RATIOS = Object.freeze({
  portrait: 9 / 16,
  landscape: 16 / 9,
});
export const DEFAULT_LIVEAVATAR_ASPECT_RATIO =
  LIVEAVATAR_ASPECT_RATIOS[DEFAULT_AVATAR_DISPLAY_FORMAT];

// What the expand button on the embedded avatar opens: the whole screen or a
// centered modal taking 25%, 50% or 75% of the screen width.
export const AVATAR_EXPAND_FULLSCREEN = "fullscreen";
export const AVATAR_EXPAND_MODAL = "modal";
export const AVATAR_EXPAND_MODES = Object.freeze([
  AVATAR_EXPAND_FULLSCREEN,
  AVATAR_EXPAND_MODAL,
]);
export const DEFAULT_AVATAR_EXPAND_MODE = AVATAR_EXPAND_FULLSCREEN;
export const AVATAR_MODAL_WIDTH_OPTIONS = Object.freeze([25, 50, 75]);
export const DEFAULT_AVATAR_MODAL_WIDTH_PERCENT = 75;
export const AVATAR_MODAL_MAX_HEIGHT_PERCENT = 85;
// Control bar of the expanded view (h-24 on desktop), added to the modal
// height so the avatar keeps its aspect ratio below it.
export const AVATAR_EXPANDED_HEADER_HEIGHT = 96;

export const DEFAULT_AI_MEDIA_SETTINGS = Object.freeze({
  avatarEnabled: false,
  avatarId: DEFAULT_AVATAR_ID,
  avatarConfig: {
    provider: HEYGEN_AVATAR_PROVIDER,
    displayFormat: DEFAULT_AVATAR_DISPLAY_FORMAT,
    expandMode: DEFAULT_AVATAR_EXPAND_MODE,
    modalWidthPercent: DEFAULT_AVATAR_MODAL_WIDTH_PERCENT,
  },
});

export function isHeyGenPublicAvatarId(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

export const isAnamAvatarId = isHeyGenPublicAvatarId;

export function normalizeAvatarProvider(value) {
  return value === ANAM_AVATAR_PROVIDER
    ? ANAM_AVATAR_PROVIDER
    : HEYGEN_AVATAR_PROVIDER;
}

export function normalizeAvatarDisplayFormat(value) {
  return value === "landscape" ? "landscape" : DEFAULT_AVATAR_DISPLAY_FORMAT;
}

export function normalizeAvatarExpandMode(value) {
  return value === AVATAR_EXPAND_MODAL
    ? AVATAR_EXPAND_MODAL
    : DEFAULT_AVATAR_EXPAND_MODE;
}

export function normalizeAvatarModalWidthPercent(value) {
  const percent = Number(value);
  return AVATAR_MODAL_WIDTH_OPTIONS.includes(percent)
    ? percent
    : DEFAULT_AVATAR_MODAL_WIDTH_PERCENT;
}

export function getAvatarDisplayAspectRatio(value) {
  return LIVEAVATAR_ASPECT_RATIOS[normalizeAvatarDisplayFormat(value)];
}

// Geometry the widget loader applies to the embedding iframe when the avatar
// is expanded over the host page. A modal follows the avatar's aspect ratio
// (plus the control bar) up to `heightPercent` of the viewport height.
export function getAvatarExpandGeometry(config = {}) {
  const source = config && typeof config === "object" ? config : {};
  if (normalizeAvatarExpandMode(source.expandMode) === AVATAR_EXPAND_MODAL) {
    return {
      mode: AVATAR_EXPAND_MODAL,
      widthPercent: normalizeAvatarModalWidthPercent(source.modalWidthPercent),
      heightPercent: AVATAR_MODAL_MAX_HEIGHT_PERCENT,
      aspectRatio: getAvatarDisplayAspectRatio(source.displayFormat),
      headerHeight: AVATAR_EXPANDED_HEADER_HEIGHT,
      backdrop: true,
    };
  }
  return {
    mode: AVATAR_EXPAND_FULLSCREEN,
    widthPercent: 100,
    heightPercent: 100,
    aspectRatio: null,
    headerHeight: 0,
    backdrop: false,
  };
}

// Accepts the widget configuration shape ({ enabled, provider, avatarId, … }),
// the public bootstrap shape ({ avatarEnabled, avatarId, avatarConfig }) and
// the snake_case variants, and returns the runtime shape.
export function normalizeAIMediaSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const requestedId = source.avatarId || source.avatar_id || source.avatar?.id;
  const requestedConfig =
    source.avatarConfig && typeof source.avatarConfig === "object"
      ? source.avatarConfig
      : source.avatar_config && typeof source.avatar_config === "object"
      ? source.avatar_config
      : source;
  const { enabled, avatarEnabled, avatar_enabled, avatarId, avatar_id, avatar, ...flatConfig } =
    requestedConfig === source ? source : {};
  const config = requestedConfig === source ? flatConfig : requestedConfig;

  return {
    avatarEnabled: Boolean(
      source.avatarEnabled ?? source.avatar_enabled ?? source.enabled ?? source.avatar?.enabled
    ),
    avatarId: isHeyGenPublicAvatarId(requestedId) ? requestedId : null,
    avatarConfig: {
      ...config,
      provider: normalizeAvatarProvider(config.provider),
      displayFormat: normalizeAvatarDisplayFormat(
        config.displayFormat || config.display_format
      ),
      expandMode: normalizeAvatarExpandMode(config.expandMode || config.expand_mode),
      modalWidthPercent: normalizeAvatarModalWidthPercent(
        config.modalWidthPercent ?? config.modal_width_percent
      ),
    },
  };
}

function normalizeHttpsUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

// The subset of the stored settings that an anonymous widget visitor may see.
// Provider credentials never leave the server; preview URLs were normalized
// when the avatar was selected.
export function publicAIMediaSettings(value = {}) {
  const settings = normalizeAIMediaSettings(value);
  if (!settings.avatarEnabled || !settings.avatarId) {
    return { ...DEFAULT_AI_MEDIA_SETTINGS, avatarConfig: { ...DEFAULT_AI_MEDIA_SETTINGS.avatarConfig } };
  }
  const config = settings.avatarConfig;
  return {
    avatarEnabled: true,
    avatarId: settings.avatarId,
    avatarConfig: {
      provider: config.provider,
      displayFormat: config.displayFormat,
      expandMode: config.expandMode,
      modalWidthPercent: config.modalWidthPercent,
      name: typeof config.name === "string" && config.name ? config.name.slice(0, 120) : null,
      previewUrl: normalizeHttpsUrl(config.previewUrl),
      portraitPreviewUrl: normalizeHttpsUrl(config.portraitPreviewUrl),
      landscapePreviewUrl: normalizeHttpsUrl(config.landscapePreviewUrl),
    },
  };
}

function convertPcm16ToMonoRate(audio, format = {}, targetRate) {
  if (!(audio instanceof Uint8Array) || audio.byteLength < 2) {
    return new Uint8Array();
  }

  const sourceRate = Math.max(1, Number(format.sampleRate) || 16000);
  const channels = Math.max(1, Math.floor(Number(format.channels) || 1));
  const resampler = new StreamingPcm16MonoResampler(
    { sampleRate: sourceRate, channels },
    targetRate
  );
  return concatUint8Arrays(resampler.push(audio), resampler.flush());
}

export function convertPcm16ToMono16k(audio, format = {}) {
  return convertPcm16ToMonoRate(audio, format, 16000);
}

export function calculatePcm16Rms(audio) {
  if (!(audio instanceof Uint8Array) || audio.byteLength < 2) return 0;

  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const sampleCount = Math.floor(audio.byteLength / 2);
  const stride = Math.max(1, Math.floor(sampleCount / 2048));
  let sumSquares = 0;
  let measuredSamples = 0;

  for (let sample = 0; sample < sampleCount; sample += stride) {
    const normalized = view.getInt16(sample * 2, true) / 32768;
    sumSquares += normalized * normalized;
    measuredSamples += 1;
  }

  if (!measuredSamples) return 0;
  const rms = Math.sqrt(sumSquares / measuredSamples);
  return Math.min(1, Math.max(0, (rms - 0.012) * 7.5));
}

export function getPcm16DurationMs(audio, format = {}) {
  if (!(audio instanceof Uint8Array)) return 0;
  const sampleRate = Number(format.sampleRate) || 16000;
  const channels = Math.max(1, Number(format.channels) || 1);
  const bytesPerFrame = 2 * channels;
  return (audio.byteLength / bytesPerFrame / sampleRate) * 1000;
}

export function convertPcm16ToMono24k(audio, format = {}) {
  return convertPcm16ToMonoRate(audio, format, 24000);
}

export function pcmBytesToBase64(audio) {
  if (!(audio instanceof Uint8Array) || !audio.byteLength) return "";
  let binary = "";
  const sliceSize = 0x8000;
  for (let offset = 0; offset < audio.byteLength; offset += sliceSize) {
    binary += String.fromCharCode(...audio.subarray(offset, offset + sliceSize));
  }
  return btoa(binary);
}
