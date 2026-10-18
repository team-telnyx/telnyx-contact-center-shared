import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSISTANT_AVATAR_CHOICES,
  applySuggestedAvatarVoice,
  defaultAssistantAvatar,
  hasCompatibleAvatarVoice,
  suggestedAvatarVoice,
} from "../lib/ai/assistant-avatar-ui.mjs";
import {
  assistantForEditor,
  assistantVoiceSettings,
  payloadForSave,
} from "../lib/ai/assistant-draft.mjs";
import { validateAssistantDraftChanges } from "../lib/ai/assistant-contract.mjs";
import { settingLocation } from "../lib/ai/assistant-settings-index.mjs";

test("all portrait/background choices produce valid assistant payloads without changing the voice", () => {
  const original = {
    name: "Test",
    voice_settings: { voice: "Telnyx.KokoroTTS.af_heart", voice_speed: 1.1 },
    tools: [{ type: "hangup", hangup: { description: "End the call" } }],
  };
  for (const avatar of ASSISTANT_AVATAR_CHOICES)
    for (const background_id of ["studio", "office", "reception"]) {
      const draft = assistantForEditor(original);
      draft.avatar_settings = {
        ...defaultAssistantAvatar(),
        avatar_id: avatar.id,
        background_id,
      };
      const payload = payloadForSave(draft, { patch: true });
      assert.deepEqual(Object.keys(payload), ["avatar_settings"]);
      assert.deepEqual(validateAssistantDraftChanges(payload, original), []);
      assert.deepEqual(assistantVoiceSettings(draft), original.voice_settings);
    }
});

test("suggested voice updates canonical and legacy voice controls while preserving other settings", () => {
  for (const avatar of ASSISTANT_AVATAR_CHOICES) {
    const original = {
      avatar_settings: { ...defaultAssistantAvatar(), avatar_id: avatar.id },
      voice_settings: {
        voice: "Telnyx.KokoroTTS.af_heart",
        voice_speed: 1.1,
        language_boost: "Polish",
        background_audio: {
          type: "predefined_media",
          value: "silence",
          volume: 0.3,
        },
        tool_call_audio: {
          type: "predefined_media",
          value: "typing",
          volume: 0.7,
        },
      },
    };
    const draft = applySuggestedAvatarVoice(assistantForEditor(original));
    const expected = {
      ...original.voice_settings,
      voice: suggestedAvatarVoice(avatar.id).voice,
    };
    assert.equal(draft.voice, expected.voice);
    assert.deepEqual(assistantVoiceSettings(draft), expected);
    assert.deepEqual(payloadForSave(draft, { patch: true }), {
      voice_settings: expected,
    });
    assert.deepEqual(
      validateAssistantDraftChanges({ voice_settings: expected }, original),
      [],
    );
  }
});

test("clearing sends null and unrelated changes preserve existing avatar settings", () => {
  const original = {
    name: "Test",
    avatar_settings: {
      ...defaultAssistantAvatar(),
      avatar_id: "avery",
      background_id: "office",
    },
  };
  const draft = assistantForEditor(original);
  draft.name = "Renamed";
  assert.deepEqual(payloadForSave(draft, { patch: true }), { name: "Renamed" });
  draft.avatar_settings = null;
  assert.deepEqual(payloadForSave(draft, { patch: true }), {
    name: "Renamed",
    avatar_settings: null,
  });
  assert.deepEqual(
    validateAssistantDraftChanges(
      payloadForSave(draft, { patch: true }),
      original,
    ),
    [],
  );
});

test("reverting or clearing a suggested voice through the catalog overrides the suggestion", () => {
  const original = {
    avatar_settings: defaultAssistantAvatar(),
    voice_settings: { voice: "Telnyx.KokoroTTS.af_heart" },
  };
  const draft = applySuggestedAvatarVoice(assistantForEditor(original));
  assert.equal(draft.voice_speed, 1);
  assert.deepEqual(draft._original, original);
  assert.deepEqual(draft._writableBaseline.voice_settings, original.voice_settings);
  draft.voice = original.voice_settings.voice;
  assert.equal(assistantVoiceSettings(draft).voice, original.voice_settings.voice);
  assert.deepEqual(payloadForSave(draft, { patch: true }), {});
  draft.voice = "";
  assert.equal(assistantVoiceSettings(draft).voice, "");
  assert.deepEqual(payloadForSave(draft, { patch: true }), {
    voice_settings: { voice: "" },
  });
});

test("voice compatibility includes language overrides and unknown avatars do not invent a voice", () => {
  assert.equal(
    hasCompatibleAvatarVoice({
      voice: "Telnyx.Ultra.{{voice_id}}",
      language_voices: { pl: { voice: "Telnyx.KokoroTTS.af_heart" } },
    }),
    true,
  );
  assert.equal(
    hasCompatibleAvatarVoice({ voice: "ElevenLabs.example" }),
    false,
  );
  assert.equal(
    hasCompatibleAvatarVoice({
      voice: "Telnyx.Ultra.example",
      language_voices: { pl: "ElevenLabs.example" },
    }),
    false,
  );
  assert.equal(hasCompatibleAvatarVoice({}), false);
  assert.equal(suggestedAvatarVoice("unknown"), null);
  const draft = { avatar_settings: { avatar_id: "unknown" } };
  assert.equal(applySuggestedAvatarVoice(draft), draft);
  assert.deepEqual(settingLocation("avatar_settings.avatar_id"), [
    "avatar",
    null,
  ]);
});
