import assert from "node:assert/strict";
import test from "node:test";

import {
  ANAM_AVATAR_PROVIDER,
  AVATAR_EXPAND_FULLSCREEN,
  AVATAR_EXPAND_MODAL,
  calculatePcm16Rms,
  convertPcm16ToMono16k,
  convertPcm16ToMono24k,
  getAvatarDisplayAspectRatio,
  getAvatarExpandGeometry,
  getPcm16DurationMs,
  isHeyGenPublicAvatarId,
  normalizeAvatarDisplayFormat,
  normalizeAvatarExpandMode,
  normalizeAvatarModalWidthPercent,
  normalizeAIMediaSettings,
  publicAIMediaSettings,
} from "../lib/ai/avatar-config.mjs";

const AVATAR_ID = "513fd1b7-7ef9-466d-9af2-344e51eeb833";

test("media settings accept provider-scoped UUID avatar IDs", () => {
  assert.equal(isHeyGenPublicAvatarId(AVATAR_ID), true);
  assert.equal(isHeyGenPublicAvatarId("nova"), false);
  assert.deepEqual(
    normalizeAIMediaSettings({ avatar_enabled: true, avatar_id: AVATAR_ID }),
    {
      avatarEnabled: true,
      avatarId: AVATAR_ID,
      avatarConfig: {
        provider: "heygen",
        displayFormat: "portrait",
        expandMode: "fullscreen",
        modalWidthPercent: 75,
      },
    }
  );
  // Widget configuration shape (channels.voice.avatar).
  const fromWidget = normalizeAIMediaSettings({
    enabled: true, provider: "anam", avatarId: AVATAR_ID, name: "Mia", avatarModel: "cara-4",
    displayFormat: "landscape", expandMode: "modal", modalWidthPercent: 25,
  });
  assert.equal(fromWidget.avatarEnabled, true);
  assert.equal(fromWidget.avatarId, AVATAR_ID);
  assert.equal(fromWidget.avatarConfig.avatarModel, "cara-4");
  assert.equal(fromWidget.avatarConfig.modalWidthPercent, 25);
  assert.equal("enabled" in fromWidget.avatarConfig, false);
  assert.equal(normalizeAIMediaSettings({ avatarId: "nova" }).avatarId, null);
  assert.equal(
    normalizeAIMediaSettings({
      avatarId: AVATAR_ID,
      avatarConfig: { provider: ANAM_AVATAR_PROVIDER },
    }).avatarConfig.provider,
    ANAM_AVATAR_PROVIDER
  );
});

test("expanded view mode is fullscreen unless a modal width is chosen", () => {
  assert.equal(normalizeAvatarExpandMode(undefined), AVATAR_EXPAND_FULLSCREEN);
  assert.equal(normalizeAvatarExpandMode("popup"), AVATAR_EXPAND_FULLSCREEN);
  assert.equal(normalizeAvatarExpandMode("modal"), AVATAR_EXPAND_MODAL);
  assert.equal(normalizeAvatarModalWidthPercent(50), 50);
  assert.equal(normalizeAvatarModalWidthPercent("25"), 25);
  assert.equal(normalizeAvatarModalWidthPercent(60), 75);
  assert.equal(
    normalizeAIMediaSettings({ avatarConfig: { expand_mode: "modal" } }).avatarConfig.expandMode,
    AVATAR_EXPAND_MODAL
  );
  assert.deepEqual(getAvatarExpandGeometry({ expandMode: "fullscreen" }), {
    mode: "fullscreen",
    widthPercent: 100,
    heightPercent: 100,
    aspectRatio: null,
    headerHeight: 0,
    backdrop: false,
  });
  const modal = getAvatarExpandGeometry({ expandMode: "modal", modalWidthPercent: 25, displayFormat: "landscape" });
  assert.equal(modal.widthPercent, 25);
  assert.equal(modal.backdrop, true);
  assert.equal(modal.aspectRatio, 16 / 9);
  assert.ok(modal.headerHeight > 0);
  assert.ok(modal.heightPercent > 30 && modal.heightPercent <= 100);
  assert.equal(getAvatarExpandGeometry({ expandMode: "modal" }).widthPercent, 75);
});

test("the public widget payload keeps only presentation fields", () => {
  const stored = {
    avatarEnabled: true,
    avatarId: AVATAR_ID,
    avatarConfig: {
      provider: "anam",
      displayFormat: "landscape",
      expandMode: "modal",
      name: "Mia — studio",
      previewUrl: "https://cdn.example.com/mia.jpg",
      portraitPreviewUrl: "https://cdn.example.com/mia-portrait.jpg",
      landscapePreviewUrl: "javascript:alert(1)",
      videoPreviewUrl: "https://cdn.example.com/mia.mp4",
      avatarModel: "cara-4",
    },
  };
  assert.deepEqual(publicAIMediaSettings(stored), {
    avatarEnabled: true,
    avatarId: AVATAR_ID,
    avatarConfig: {
      provider: "anam",
      displayFormat: "landscape",
      expandMode: "modal",
      modalWidthPercent: 75,
      name: "Mia — studio",
      previewUrl: "https://cdn.example.com/mia.jpg",
      portraitPreviewUrl: "https://cdn.example.com/mia-portrait.jpg",
      landscapePreviewUrl: null,
    },
  });
  assert.equal(publicAIMediaSettings({ ...stored, avatarEnabled: false }).avatarEnabled, false);
  assert.equal(publicAIMediaSettings({ ...stored, avatarEnabled: false }).avatarId, null);
  assert.equal(publicAIMediaSettings(undefined).avatarConfig.provider, "heygen");
});

test("avatar aspect ratio comes only from the persisted display format", () => {
  assert.equal(getAvatarDisplayAspectRatio("portrait"), 9 / 16);
  assert.equal(getAvatarDisplayAspectRatio("landscape"), 16 / 9);
  assert.equal(getAvatarDisplayAspectRatio(undefined), 9 / 16);
  assert.equal(normalizeAvatarDisplayFormat("square"), "portrait");
});

test("PCM16 helpers expose audio energy and duration", () => {
  const silent = new Uint8Array(3200);
  const loud = new Uint8Array(3200);
  const view = new DataView(loud.buffer);
  for (let offset = 0; offset < loud.byteLength; offset += 2) {
    view.setInt16(offset, offset % 4 ? 12000 : -12000, true);
  }

  assert.equal(calculatePcm16Rms(silent), 0);
  assert.ok(calculatePcm16Rms(loud) > 0.9);
  assert.equal(getPcm16DurationMs(loud, { sampleRate: 16000, channels: 1 }), 100);
});

test("Telnyx PCM16 is converted to HeyGen mono 24 kHz and Anam mono 16 kHz audio", () => {
  const stereo16k = new Uint8Array(3200 * 2);
  const view = new DataView(stereo16k.buffer);
  for (let offset = 0; offset < stereo16k.byteLength; offset += 4) {
    view.setInt16(offset, 8000, true);
    view.setInt16(offset + 2, -2000, true);
  }

  const converted = convertPcm16ToMono24k(stereo16k, { sampleRate: 16000, channels: 2 });
  assert.equal(converted.byteLength, 4800);
  assert.equal(new DataView(converted.buffer).getInt16(0, true), 3000);

  const anamConverted = convertPcm16ToMono16k(stereo16k, { sampleRate: 16000, channels: 2 });
  assert.equal(anamConverted.byteLength, 3200);
  assert.equal(new DataView(anamConverted.buffer).getInt16(0, true), 3000);
});
