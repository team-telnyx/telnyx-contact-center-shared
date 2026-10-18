import { widgetAiRequest } from "../widgets/ai-provider.js";
import { TELNYX_AVATAR_MODEL, TELNYX_AVATAR_BACKGROUNDS, isTelnyxAvatarId } from "./telnyx-avatar-catalog.mjs";
import { normalizeAIMediaSettings } from "./avatar-config.mjs";

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const usesTelnyxAvatar = (config) => Boolean(config?.channels?.voice?.enabled && config.channels.voice.avatar?.enabled && config.channels.voice.avatar.provider === "telnyx");

export function telnyxAvatarSettings(avatar) {
  const normalized = normalizeAIMediaSettings(avatar);
  const background = normalized.avatarConfig.backgroundId || "studio";
  if (!isTelnyxAvatarId(normalized.avatarId) || !TELNYX_AVATAR_BACKGROUNDS.includes(background)) throw fail("Select a Telnyx avatar and background before publishing");
  if (normalized.avatarConfig.avatarModel && normalized.avatarConfig.avatarModel !== TELNYX_AVATAR_MODEL) throw fail("Unsupported Telnyx avatar model");
  return { provider: "telnyx", model: TELNYX_AVATAR_MODEL, avatar_id: normalized.avatarId, background_id: background };
}

export function assertTelnyxAvatarAssistant(assistant, voice, { requireMatch = false } = {}) {
  const wanted = telnyxAvatarSettings(voice.avatar);
  if (!String(assistant.voice_settings?.voice || "").startsWith("Telnyx.")) throw fail("Telnyx avatars require a Telnyx TTS voice on the selected assistant. Change its voice before publishing.");
  if (Object.values(assistant.voice_settings?.language_voices || {}).some((entry) => !String(typeof entry === "string" ? entry : entry?.voice || "").startsWith("Telnyx."))) throw fail("Every language voice must use Telnyx for avatar conversations.");
  if (voice.assistantVersionId && voice.assistantVersionId !== "main") throw fail("Telnyx avatar conversations use the current assistant. Select its main version.");
  if (voice.keepAssistantOnCall) throw fail("Telnyx avatar conversations do not support Keep assistant on call or telephone transfers.");
  if (requireMatch && !sameAvatar(assistant.avatar_settings, wanted)) throw fail("The assistant's Telnyx avatar changed. Republish this widget before starting a call.", 409);
  return wanted;
}

function sameAvatar(left, right) {
  return Boolean(left && right && ["provider", "model", "avatar_id", "background_id"].every((key) => left[key] === right[key]));
}

// Telnyx stores the avatar on the assistant, not on each conversation. Serialize
// publications of that assistant and reject conflicts with other published
// widgets. Restore the prior setting if local publication fails after the POST.
export async function publishWithTelnyxAvatar(pool, { widgetId, config, beforeMutation, request = widgetAiRequest }, publish) {
  if (!usesTelnyxAvatar(config)) return publish();
  const voice = config.channels.voice;
  const lock = await pool.connect();
  let locked = false, changed = false, previous, wanted;
  const endpoint = `/ai/assistants/${encodeURIComponent(voice.assistantId)}`;
  try {
    locked = (await lock.query("SELECT pg_try_advisory_lock(hashtextextended($1,814024)) AS acquired", [voice.assistantId])).rows[0].acquired;
    if (!locked) throw fail("Another widget is configuring this assistant's avatar. Retry publication shortly.", 409);
    // Disabled widgets retain their published revision and can be re-enabled
    // without publication, so their assistant/avatar agreement still matters.
    const others = await lock.query(`SELECT w.name,r.config FROM cc_widgets w JOIN cc_widget_revisions r ON r.id=w.published_revision_id WHERE w.id<>$1 AND r.config#>>'{channels,voice,assistantId}'=$2`, [widgetId, voice.assistantId]);
    wanted = telnyxAvatarSettings(voice.avatar);
    for (const other of others.rows) {
      if (usesTelnyxAvatar(other.config) && !sameAvatar(telnyxAvatarSettings(other.config.channels.voice.avatar), wanted)) throw fail(`The assistant is shared with widget "${other.name}", which uses a different Telnyx avatar. Use the same avatar and background or a separate assistant.`, 409);
    }
    const response = await request(endpoint);
    const assistant = response.data || response;
    assertTelnyxAvatarAssistant(assistant, voice);
    previous = assistant.avatar_settings || null;
    if (!sameAvatar(previous, wanted)) {
      await beforeMutation(lock);
      changed = true;
      await request(endpoint, { method: "POST", body: { avatar_settings: wanted } });
      const confirmed = await request(endpoint);
      assertTelnyxAvatarAssistant(confirmed.data || confirmed, voice, { requireMatch: true });
    }
    // Reuse the advisory-lock connection throughout publication. Acquiring a
    // second connection can deadlock when concurrent publications fill the pool.
    return await publish(lock);
  } catch (error) {
    if (changed) {
      try {
        const current = await request(endpoint);
        if (sameAvatar((current.data || current).avatar_settings, wanted)) await request(endpoint, { method: "POST", body: { avatar_settings: previous } });
      } catch { error.message += " The assistant avatar rollback could not be confirmed; check its saved settings before retrying."; }
    }
    throw error;
  } finally {
    try {
      if (locked) await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,814024))", [voice.assistantId]);
    } finally { lock.release(); }
  }
}
