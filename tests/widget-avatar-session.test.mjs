import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareAcdTestPool } from "./helpers/acd-test-db.mjs";
import { createWidget, updateWidgetDraft, publishWidget, preflightWidget } from "../lib/widgets/store.js";
import { DEFAULT_WIDGET_CONFIG, parseWidgetConfig, publicWidgetConfig } from "../lib/widgets/config.js";
import { createWidgetBootstrapToken } from "../lib/widgets/session-tokens.js";
import { startWidgetSession, getWidgetSession } from "../lib/widgets/sessions.js";
import { updateWidgetVoiceState } from "../lib/widgets/ai-sessions.js";
import {
  AvatarSessionError,
  assertAvatarSessionAllowed,
  authorizeWidgetAvatarSession,
  avatarErrorResponse,
  createAvatarSessionForSettings,
  verifyWidgetAvatar,
} from "../lib/ai/avatar-extensions.mjs";

process.env.WIDGET_SESSION_SIGNING_SECRET = "widget-avatar-test-only-signing-key-more-than-32-characters";
process.env.TELNYX_API_KEY = "widget-avatar-test-only";
process.env.LIVEAVATAR_API_KEY = "heygen-test-key";
process.env.ANAM_API_KEY = "anam-test-key";
const pool = await prepareAcdTestPool("acd_core_test_widget_avatar");
after(() => { mock.restoreAll(); return pool.end(); });
mock.method(globalThis, "fetch", async (url) => {
  const id = decodeURIComponent(String(url).split("/ai/assistants/")[1]?.split(/[/?]/)[0] || "avatar-assistant");
  return Response.json({ id, greeting: "Welcome", telephony_settings: { supports_unauthenticated_web_calls: true } });
});

const AVATAR_ID = "513fd1b7-7ef9-466d-9af2-344e51eeb833";
const OTHER_AVATAR_ID = "071b0286-4cce-4808-bee2-e642f1062de3";
const verifiers = {
  verifyHeyGenAvatar: async (id) => ({ id, name: "Ann Therapist" }),
  verifyAnamAvatar: async (id) => ({ id, name: "Mia — studio" }),
};
const tokenFactories = {
  createHeyGenSession: async ({ avatarId }) => ({ sessionId: "hg-1", sessionToken: `heygen-token-${avatarId}`, sandbox: false }),
  createAnamSession: async ({ avatarId, avatarModel }) => ({ sessionToken: `anam-token-${avatarId}-${avatarModel}` }),
};
const anamAvatar = {
  enabled: true, provider: "anam", avatarId: OTHER_AVATAR_ID, name: "Mia — studio",
  previewUrl: "https://cdn.example.com/mia.jpg", portraitPreviewUrl: "https://cdn.example.com/mia-portrait.jpg",
  landscapePreviewUrl: "https://cdn.example.com/mia-landscape.jpg", avatarModel: "cara-4",
  displayFormat: "landscape", expandMode: "modal", modalWidthPercent: 50,
};

async function voiceWidget(assistantId, avatar, options = {}) {
  let widget = await createWidget(pool, { name: randomUUID(), actor: "admin" });
  const config = structuredClone(widget.draft.config);
  config.allowedOrigins = ["https://customer.example.com"]; config.decisions.enabled = false;
  config.channels.messaging.enabled = false; config.channels.voice.enabled = true;
  config.channels.voice.assistantId = assistantId;
  if (avatar) config.channels.voice.avatar = { ...config.channels.voice.avatar, ...avatar };
  widget = await updateWidgetDraft(pool, { id: widget.id, config, expectedDraftId: widget.draft.id, expectedEditVersion: widget.draft.editVersion, actor: "admin" });
  if (options.publish === false) return { widget };
  widget = await publishWidget(pool, { id: widget.id, expectedDraftId: widget.draft.id, expectedEditVersion: widget.draft.editVersion, actor: "admin" },
    { provisionHandoff: async () => ({ id: "test-shared-handoff" }), verifyAvatar: (block) => verifyWidgetAvatar(block, verifiers) });
  const start = { publicId: widget.publicId, bootstrapToken: createWidgetBootstrapToken({ publicId: widget.publicId, revisionId: widget.published.id, origin: config.allowedOrigins[0] }), clientKey: randomUUID(), channel: "voice" };
  return { widget, start };
}

test("the widget config carries the avatar block with defaults and validates the modal width", () => {
  const legacy = structuredClone(DEFAULT_WIDGET_CONFIG);
  delete legacy.channels.voice.avatar;
  delete legacy.components.voice.avatar;
  const parsed = parseWidgetConfig(legacy);
  assert.deepEqual(parsed.channels.voice.avatar, {
    enabled: false, provider: "heygen", avatarId: null, name: "", previewUrl: "", portraitPreviewUrl: "", landscapePreviewUrl: "",
    avatarModel: "", displayFormat: "portrait", expandMode: "fullscreen", modalWidthPercent: 75,
  });
  assert.deepEqual(parsed.components.voice.avatar, { maxHeight: 260, radius: 16, padding: 12, backgroundColor: "#f4f7f6", fit: "cover", focusY: 25, showExpandButton: true, position: "middle", showSubtitles: false, subtitleFontSize: 12, subtitlePosition: "bottom" });
  const bad = structuredClone(parsed); bad.channels.voice.avatar.modalWidthPercent = 60;
  assert.throws(() => parseWidgetConfig(bad), /25, 50 or 75/);
});

test("publishing verifies an enabled avatar against the provider catalog", async () => {
  const assistantId = `assistant-${randomUUID()}`;
  await assert.rejects(
    verifyWidgetAvatar({ ...anamAvatar, avatarId: null }, verifiers),
    /Select a Anam avatar/
  );
  await assert.rejects(
    verifyWidgetAvatar(anamAvatar, { ...verifiers, verifyAnamAvatar: async () => { throw new Error("Not found"); } }),
    /not available: Not found/
  );
  const { widget } = await voiceWidget(assistantId, anamAvatar, { publish: false });
  await assert.rejects(
    preflightWidget(pool, widget.id, { verifyAssistant: async () => ({}), verifyAvatar: async () => { throw Object.assign(new Error("Avatar gone"), { status: 400 }); } }),
    /Avatar gone/
  );
  const disabled = await voiceWidget(assistantId, { ...anamAvatar, enabled: false }, { publish: false });
  await preflightWidget(pool, disabled.widget.id, { verifyAssistant: async () => ({}), verifyAvatar: async () => { throw new Error("must not run"); } });
});

test("the public bootstrap exposes the presentation subset of the published avatar", async () => {
  const { widget } = await voiceWidget(`assistant-${randomUUID()}`, anamAvatar);
  const voice = publicWidgetConfig(widget.published.config).channels.voice;
  assert.deepEqual(voice.avatar, {
    avatarEnabled: true,
    avatarId: OTHER_AVATAR_ID,
    avatarConfig: {
      provider: "anam", displayFormat: "landscape", expandMode: "modal", modalWidthPercent: 50, name: "Mia — studio",
      previewUrl: "https://cdn.example.com/mia.jpg", portraitPreviewUrl: "https://cdn.example.com/mia-portrait.jpg",
      landscapePreviewUrl: "https://cdn.example.com/mia-landscape.jpg",
    },
  });
  assert.equal("avatarModel" in voice.avatar.avatarConfig, false);
  const plain = await voiceWidget(`assistant-${randomUUID()}`, null);
  assert.equal(publicWidgetConfig(plain.widget.published.config).channels.voice.avatar.avatarEnabled, false);
});

test("session tokens are only issued for the enabled avatar of the matching provider", async () => {
  const settings = { enabled: true, provider: "heygen", avatarId: AVATAR_ID };
  const session = await createAvatarSessionForSettings(settings, { avatarId: AVATAR_ID, provider: "heygen" }, tokenFactories);
  assert.deepEqual(session, { provider: "heygen", sessionId: "hg-1", sessionToken: `heygen-token-${AVATAR_ID}`, sandbox: false });
  const anam = await createAvatarSessionForSettings(anamAvatar, { avatarId: OTHER_AVATAR_ID, provider: "anam" }, tokenFactories);
  assert.equal(anam.sessionToken, `anam-token-${OTHER_AVATAR_ID}-cara-4`);

  for (const [request, reason, status] of [
    [{ avatarId: "nova", provider: "heygen" }, "invalid_request", 400],
    [{ avatarId: OTHER_AVATAR_ID, provider: "heygen" }, "avatar_disabled", 403],
    [{ avatarId: AVATAR_ID, provider: "anam" }, "avatar_disabled", 403],
  ]) {
    assert.throws(() => assertAvatarSessionAllowed(settings, request), (error) => error.reason === reason && error.status === status);
  }
  assert.throws(() => assertAvatarSessionAllowed({ ...settings, enabled: false }, { avatarId: AVATAR_ID, provider: "heygen" }), /not enabled/);
  const response = avatarErrorResponse(new AvatarSessionError("Avatar is not enabled for this widget", { status: 403, reason: "avatar_disabled" }));
  assert.deepEqual(response, { status: 403, body: { ok: false, reason: "avatar_disabled", error: "Avatar is not enabled for this widget" } });
  assert.equal(avatarErrorResponse(new Error("boom")).status, 500);
});

test("a visitor can only start the avatar of the revision behind an active voice session", async () => {
  const assistantId = `assistant-${randomUUID()}`;
  const { widget, start } = await voiceWidget(assistantId, { enabled: true, provider: "heygen", avatarId: AVATAR_ID, name: "Ann Therapist", previewUrl: "https://files2.heygen.ai/ann.webp" });
  const started = await startWidgetSession(pool, start);
  assert.equal(started.runtimeKind, "ai_voice");

  const authorized = await authorizeWidgetAvatarSession(pool, { publicId: widget.publicId, token: started.sessionToken, assistantId }, { getWidgetSession });
  assert.equal(authorized.settings.avatarId, AVATAR_ID);
  assert.equal(authorized.settings.avatarConfig.provider, "heygen");
  assert.equal(authorized.session.assistant_id, assistantId);
  const session = await createAvatarSessionForSettings(authorized.settings, { avatarId: AVATAR_ID, provider: "heygen" }, tokenFactories);
  assert.equal(session.sessionToken, `heygen-token-${AVATAR_ID}`);

  await assert.rejects(
    authorizeWidgetAvatarSession(pool, { publicId: widget.publicId, token: started.sessionToken, assistantId: "another-assistant" }, { getWidgetSession }),
    (error) => error.reason === "avatar_disabled" && error.status === 403
  );
  await assert.rejects(
    authorizeWidgetAvatarSession(pool, { publicId: "wgt_other", token: started.sessionToken, assistantId }, { getWidgetSession }),
    (error) => error.status === 403
  );
  await assert.rejects(
    authorizeWidgetAvatarSession(pool, { publicId: widget.publicId, token: "wss_invalid", assistantId }, { getWidgetSession }),
    (error) => error.status === 401 && error.reason === "authentication_required"
  );

  // A widget without an avatar yields a disabled block, so no token is issued.
  const plain = await voiceWidget(assistantId, null);
  const plainSession = await startWidgetSession(pool, plain.start);
  const plainAuth = await authorizeWidgetAvatarSession(pool, { publicId: plain.widget.publicId, token: plainSession.sessionToken, assistantId }, { getWidgetSession });
  assert.throws(() => assertAvatarSessionAllowed(plainAuth.settings, { avatarId: AVATAR_ID, provider: "heygen" }), /not enabled/);

  await updateWidgetVoiceState(pool, started.sessionToken, { status: "completed" });
  await assert.rejects(
    authorizeWidgetAvatarSession(pool, { publicId: widget.publicId, token: started.sessionToken, assistantId }, { getWidgetSession }),
    (error) => error.status === 409 && error.reason === "session_ended"
  );
});
