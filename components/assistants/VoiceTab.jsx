"use client";

import TtsVoicePicker from "@/components/assistants/VoicePicker";

export default function VoiceTab({ values, setValues }) {
  return (
    <>
      <TtsVoicePicker
        value={{
          voice: values.voice,
          voice_speed: values.voice_speed,
          background_audio: values.background_audio,
          transcription: values.transcription,
          voice_api_key_ref: values.voice_api_key_ref,
          interruption_settings: values.interruption_settings,
          telephony: values.telephony,
          elevenlabs_settings: values.elevenlabs_settings,
          language_boost: values.language_boost,
          voice_language: values.voice_language,
          expressive_mode: values.expressive_mode,
          pronunciation_dict_id: values.pronunciation_dict_id,
        }}
        onChange={(next) => {
          setValues((v) => {
            const nextVoice = next?.voice ?? v.voice ?? "";
            const nextSpeed = next?.voice_speed ?? v.voice_speed ?? 1;
            const nextBackgroundAudio =
              next?.background_audio ?? v.background_audio ?? "";
            const nextTranscription = next?.transcription
              ? { ...(v.transcription || {}), ...next.transcription }
              : v.transcription;
            const nextVoiceApiKeyRef =
              next?.voice_api_key_ref ?? v.voice_api_key_ref ?? "";
            const nextInterruptionSettings = next?.interruption_settings
              ? {
                  ...(v.interruption_settings || {}),
                  ...next.interruption_settings,
                }
              : v.interruption_settings;
            const nextTelephony = next?.telephony
              ? { ...(v.telephony || {}), ...next.telephony }
              : v.telephony;
            const nextElevenLabsSettings =
              next?.elevenlabs_settings !== undefined
                ? next.elevenlabs_settings
                : v.elevenlabs_settings;
            const nextLanguageBoost =
              next?.language_boost !== undefined
                ? next.language_boost
                : v.language_boost;
            const nextVoiceLanguage =
              next?.voice_language !== undefined
                ? next.voice_language
                : v.voice_language;
            const nextExpressiveMode =
              next?.expressive_mode !== undefined
                ? next.expressive_mode
                : v.expressive_mode;
            const sameVoice = v.voice === nextVoice;
            const sameSpeed = Number(v.voice_speed ?? 1) === Number(nextSpeed);
            const sameBackgroundAudio =
              v.background_audio === nextBackgroundAudio;
            const sameTranscription =
              JSON.stringify(v.transcription || {}) ===
              JSON.stringify(nextTranscription || {});
            const sameVoiceApiKeyRef =
              v.voice_api_key_ref === nextVoiceApiKeyRef;
            const sameInterruptionSettings =
              JSON.stringify(v.interruption_settings || {}) ===
              JSON.stringify(nextInterruptionSettings || {});
            const sameTelephony =
              JSON.stringify(v.telephony || {}) ===
              JSON.stringify(nextTelephony || {});
            const sameElevenLabsSettings =
              JSON.stringify(v.elevenlabs_settings || {}) ===
              JSON.stringify(nextElevenLabsSettings || {});
            const sameLanguageBoost = v.language_boost === nextLanguageBoost;
            const sameVoiceLanguage = v.voice_language === nextVoiceLanguage;
            const sameExpressiveMode = v.expressive_mode === nextExpressiveMode;
            const nextPronunciationDictId =
              next?.pronunciation_dict_id !== undefined
                ? next.pronunciation_dict_id
                : v.pronunciation_dict_id;
            const samePronunciationDictId = v.pronunciation_dict_id === nextPronunciationDictId;
            if (
              sameVoice &&
              sameSpeed &&
              sameBackgroundAudio &&
              sameTranscription &&
              sameVoiceApiKeyRef &&
              sameInterruptionSettings &&
              sameTelephony &&
              sameElevenLabsSettings &&
              sameLanguageBoost &&
              sameVoiceLanguage &&
              sameExpressiveMode &&
              samePronunciationDictId
            )
              return v;
            return {
              ...v,
              voice: nextVoice,
              voice_speed: nextSpeed,
              background_audio: nextBackgroundAudio,
              transcription: nextTranscription,
              voice_api_key_ref: nextVoiceApiKeyRef,
              interruption_settings: nextInterruptionSettings,
              telephony: nextTelephony,
              elevenlabs_settings: nextElevenLabsSettings,
              language_boost: nextLanguageBoost,
              voice_language: nextVoiceLanguage,
              expressive_mode: nextExpressiveMode,
              pronunciation_dict_id: nextPronunciationDictId,
            };
          });
        }}
      />
    </>
  );
}
