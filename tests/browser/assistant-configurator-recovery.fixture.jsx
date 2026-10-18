import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import VoicePicker from "../../components/assistants/VoicePicker";
import AssistantMessagingSettings from "../../components/assistants/AssistantMessagingSettings";
import { TooltipProvider } from "../../components/ui/tooltip";
import { assistantForEditor, payloadForSave } from "../../lib/ai/assistant-draft.mjs";
import { validateAssistantDraftChanges } from "../../lib/ai/assistant-contract.mjs";

window.fixture = { catalogReady: false };
window.fetch = async url => String(url).includes("/api/tts/voices")
  ? { ok: window.fixture.catalogReady, json: async () => ({ ok: window.fixture.catalogReady, providers: [] }) }
  : { ok: true, json: async () => ({ ok: true, profiles: [] }) };
function Fixture() {
  const [voice, setVoice] = useState({ voice: "Telnyx.KokoroTTS.af_heart", noise_suppression: false, background_audio: { type: "predefined_media", value: "silence" } });
  const [values, setValues] = useState(() => assistantForEditor({ messaging_settings: { conversation_inactivity_minutes: 45 } }));
  useEffect(() => {
    window.fixture.voice = voice;
    window.fixture.payload = payloadForSave(values, { patch: true });
    window.fixture.errors = validateAssistantDraftChanges(window.fixture.payload, values._original);
  }, [voice, values]);
  return <TooltipProvider><VoicePicker section="voice" value={voice} onChange={setVoice} /><AssistantMessagingSettings values={values} setValues={setValues} /></TooltipProvider>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
