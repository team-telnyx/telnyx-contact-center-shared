import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ASSISTANT_TRANSCRIPTION_MODELS,
  cloneAssistantTranscriptionOverride,
  createTranscriptionOverride,
  validateTranscriptionOverride,
} from "../lib/ai/assistant-transcription.mjs";
import {
  normalizeWorkflowCanvasLayout,
  validateConversationFlow,
} from "../lib/ai/assistant-conversation-workflow.mjs";

const workflowTab = readFileSync(
  new URL("../components/assistants/AssistantWorkflowTab.jsx", import.meta.url),
  "utf8"
);
const transcriptionPicker = readFileSync(
  new URL("../components/assistants/WorkflowTranscriptionPicker.jsx", import.meta.url),
  "utf8"
);

test("workflow exposes compact TTS and STT prompt-node tabs", () => {
  assert.match(workflowTab, /<TabsTrigger value="voice">TTS<\/TabsTrigger>/);
  assert.match(workflowTab, /<TabsTrigger value="transcription">STT<\/TabsTrigger>/);
  assert.match(workflowTab, /<WorkflowTranscriptionPicker/);
  assert.match(workflowTab, /transcription: cloneAssistantTranscriptionOverride/);
  assert.match(workflowTab, /transcription: undefined/);
  assert.doesNotMatch(workflowTab, /<TabsTrigger value="voice">Voice<\/TabsTrigger>/);
  assert.doesNotMatch(workflowTab, /<TabsTrigger value="transcription">Transcription<\/TabsTrigger>/);
});

test("LLM, TTS, and STT use the Tools-style Override assistant defaults toggle", () => {
  assert.match(
    workflowTab,
    /function OverrideAssistantDefaultsToggle[\s\S]*Override assistant defaults[\s\S]*<Switch checked=\{checked\} onCheckedChange=\{onCheckedChange\}/
  );
  assert.match(
    workflowTab,
    /function NodeTtsOverride[\s\S]*<OverrideAssistantDefaultsToggle[\s\S]*<WorkflowVoicePicker/
  );
  assert.match(
    workflowTab,
    /function NodeSttOverride[\s\S]*<OverrideAssistantDefaultsToggle[\s\S]*<WorkflowTranscriptionPicker/
  );
  assert.match(
    workflowTab,
    /function NodeLlmOverride[\s\S]*<OverrideAssistantDefaultsToggle[\s\S]*<AIModels/
  );
  assert.doesNotMatch(workflowTab, /<TabsTrigger value="default">/);
  assert.doesNotMatch(workflowTab, /<TabsTrigger value="override">/);
  assert.doesNotMatch(transcriptionPicker, /Use Assistant Default/);
});

test("workflow transcription catalog matches current Telnyx assistant OpenAPI models", () => {
  assert.deepEqual(ASSISTANT_TRANSCRIPTION_MODELS, [
    "deepgram/flux",
    "deepgram/nova-3",
    "deepgram/nova-2",
    "speechmatics/standard",
    "azure/fast",
    "assemblyai/universal-streaming",
    "xai/grok-stt",
    "soniox/stt-rt-v4",
    "nvidia/parakeet-v3",
    "humain/realtime",
    "distil-whisper/distil-large-v2",
    "openai/whisper-large-v3-turbo",
  ]);
});

test("enabling a node override clones every assistant transcription setting", () => {
  const assistantTranscription = {
    model: "azure/fast",
    language: "pl",
    region: "westeurope",
    api_key_ref: "azure-stt-key",
    settings: { custom_setting: true },
  };
  const cloned = cloneAssistantTranscriptionOverride(assistantTranscription);

  assert.deepEqual(cloned, assistantTranscription);
  assert.notEqual(cloned, assistantTranscription);
  assert.notEqual(cloned.settings, assistantTranscription.settings);
});

test("provider changes apply Telnyx defaults and discard settings from the previous provider", () => {
  assert.deepEqual(createTranscriptionOverride("deepgram/flux"), {
    model: "deepgram/flux",
    language: "auto",
    settings: {
      eot_threshold: 0.8,
      eot_timeout_ms: 5000,
      eager_eot_threshold: 0.4,
    },
  });
  assert.deepEqual(createTranscriptionOverride("assemblyai/universal-streaming"), {
    model: "assemblyai/universal-streaming",
    language: "auto",
    settings: {
      end_of_turn_confidence_threshold: 0.4,
      min_turn_silence: 400,
      max_turn_silence: 1280,
    },
  });
  assert.deepEqual(createTranscriptionOverride("azure/fast"), {
    model: "azure/fast",
    region: "latency",
  });
  assert.deepEqual(createTranscriptionOverride("not-a-telnyx-model"), {
    model: "deepgram/flux",
    language: "auto",
    settings: {
      eot_threshold: 0.8,
      eot_timeout_ms: 5000,
      eager_eot_threshold: 0.4,
    },
  });
});

test("provider-specific settings and constraints are rendered", () => {
  assert.match(transcriptionPicker, /smart_format/);
  assert.match(transcriptionPicker, /numerals/);
  assert.match(transcriptionPicker, /eot_threshold/);
  assert.match(transcriptionPicker, /eot_timeout_ms/);
  assert.match(transcriptionPicker, /eager_eot_threshold/);
  assert.match(transcriptionPicker, /keyterm/);
  assert.match(transcriptionPicker, /end_of_turn_confidence_threshold/);
  assert.match(transcriptionPicker, /min_turn_silence/);
  assert.match(transcriptionPicker, /max_turn_silence/);
  assert.match(transcriptionPicker, /api_key_ref/);
  assert.match(transcriptionPicker, /region/);
  assert.match(transcriptionPicker, /interim_results/);
  assert.match(transcriptionPicker, /enable_endpoint_detection/);
  assert.match(transcriptionPicker, /max_endpoint_delay_ms/);
});

test("workflow validation blocks invalid Flux, AssemblyAI, and Soniox settings", () => {
  assert.deepEqual(
    validateTranscriptionOverride({
      model: "deepgram/flux",
      settings: {
        eot_threshold: 0.6,
        eager_eot_threshold: 0.8,
        eot_timeout_ms: 499,
      },
    }),
    [
      "Flux end-of-turn timeout must be an integer between 500 and 10000 ms.",
      "Flux eager end-of-turn threshold must be less than or equal to the end-of-turn threshold.",
    ]
  );

  assert.deepEqual(
    validateTranscriptionOverride({
      model: "assemblyai/universal-streaming",
      settings: {
        end_of_turn_confidence_threshold: 1.1,
        min_turn_silence: 1500,
        max_turn_silence: 1000,
      },
    }),
    [
      "AssemblyAI end-of-turn confidence must be between 0 and 1.",
      "AssemblyAI minimum turn silence must be less than or equal to maximum turn silence.",
    ]
  );

  assert.deepEqual(
    validateTranscriptionOverride({
      model: "soniox/stt-rt-v4",
      settings: { max_endpoint_delay_ms: 400 },
    }),
    ["Soniox maximum endpoint delay must be an integer between 500 and 3000 ms."]
  );
});

test("node transcription survives workflow normalization and participates in save validation", () => {
  const transcription = createTranscriptionOverride("deepgram/flux");
  const flow = {
    start_node_id: "n_start",
    nodes: [
      {
        id: "n_start",
        type: "prompt",
        name: "Start",
        instructions: "Help the caller.",
        position: { x: 900, y: 400 },
        transcription,
      },
    ],
    edges: [],
  };

  const normalized = normalizeWorkflowCanvasLayout(flow);
  assert.deepEqual(normalized.nodes[0].transcription, transcription);
  assert.deepEqual(validateConversationFlow(normalized), []);

  normalized.nodes[0].transcription.settings.eager_eot_threshold = 0.9;
  normalized.nodes[0].transcription.settings.eot_threshold = 0.5;
  assert.match(validateConversationFlow(normalized)[0], /eager end-of-turn threshold/i);
});
