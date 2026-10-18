import {
  TELNYX_AVATAR_MODEL,
  TELNYX_AVATARS,
} from "./telnyx-avatar-catalog.mjs";
import {
  assistantVoiceSettings,
  withAssistantVoiceSettings,
} from "./assistant-draft.mjs";

// Official optional pairings from the Mission Control Portal, checked 2026-10-15.
// Appearance and voice remain separate: selecting a portrait never changes TTS.
export const AVATAR_VOICE_PAIRINGS = Object.freeze({
  elena: {
    id: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
    name: "Skylar - Friendly Guide",
  },
  ben: {
    id: "47c38ca4-5f35-497b-b1a3-415245fb35e1",
    name: "Daniel - Modern Assistant",
  },
  jordan: {
    id: "a5136bf9-224c-4d76-b823-52bd5efcffcc",
    name: "Jameson - Easygoing Support",
  },
  lin: { id: "bf32f849-7bc9-4b91-8c62-954588efcc30", name: "Lan - Instructor" },
  avery: {
    id: "f786b574-daa5-4673-aa0c-cbe3e8534c02",
    name: "Katie - Friendly Fixer",
  },
  raphael: {
    id: "ed8a381a-0704-4d12-8544-0560cc3f32da",
    name: "Arturo - Professional Assistant",
  },
});

export function defaultAssistantAvatar() {
  return {
    provider: "telnyx",
    model: TELNYX_AVATAR_MODEL,
    avatar_id: "elena",
    background_id: "studio",
  };
}

export function suggestedAvatarVoice(avatarId) {
  const pairing = AVATAR_VOICE_PAIRINGS[avatarId];
  return pairing ? { ...pairing, voice: `Telnyx.Ultra.${pairing.id}` } : null;
}

export function applySuggestedAvatarVoice(values) {
  const suggested = suggestedAvatarVoice(values.avatar_settings?.avatar_id);
  if (!suggested) return values;
  const voice = assistantVoiceSettings(values) || {};
  return withAssistantVoiceSettings(values, {
    ...voice,
    voice: suggested.voice,
  });
}

// Resolve presentation independently from the saved API voice identifier.
export function avatarVoiceDetails(voice, providers = []) {
  if (!voice) return null;
  for (const provider of providers) {
    for (const model of provider.models || []) {
      const entry = (model.voices || []).find(
        (candidate) => String(candidate.id || "").toLowerCase() === String(voice).toLowerCase(),
      );
      if (entry) {
        const name = [entry.name, entry.label].find(value => value && value !== entry.id);
        if (name) return { name, provider: provider.name || provider.id, model: model.name || model.id };
      }
    }
  }
  const pairing = Object.values(AVATAR_VOICE_PAIRINGS).find(
    (entry) => `Telnyx.Ultra.${entry.id}` === voice,
  );
  return pairing ? { name: pairing.name, provider: "Telnyx", model: "Ultra" } : null;
}

export function hasCompatibleAvatarVoice(settings) {
  const isTelnyx = (voice) => /^Telnyx\./i.test(String(voice || ""));
  return (
    isTelnyx(settings?.voice) &&
    Object.values(settings?.language_voices || {}).every((entry) =>
      isTelnyx(typeof entry === "string" ? entry : entry?.voice),
    )
  );
}

export const ASSISTANT_AVATAR_CHOICES = TELNYX_AVATARS;
