import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeWorkflowTranscriptBatch } from '../lib/agent-assist/workflow-analyzer.js';
import { buildBatchAnalysisPrompt } from '../lib/agent-assist/workflow-prompts.js';

const pendingItems = [
  {
    item_id: 'patient_name',
    type: 'slot',
    label: 'Patient first and last name',
    stage_name: 'Patient Information',
    slot_name: 'patient_name',
    slot_type: 'text',
  },
  {
    item_id: 'patient_dob',
    type: 'slot',
    label: 'Patient date of birth',
    stage_name: 'Patient Information',
    slot_name: 'patient_dob',
    slot_type: 'date',
  },
  {
    item_id: 'patient_weight',
    type: 'slot',
    label: 'Patient weight (lbs or kg)',
    stage_name: 'Patient Information',
    slot_name: 'patient_weight',
    slot_type: 'text',
  },
];

const transcripts = [
  { speaker: 'agent', transcript: 'How may I help you today?' },
  { speaker: 'customer', transcript: 'Hi, I need to order a medical transport.' },
  { speaker: 'customer', transcript: 'The patient is named John Applegate.' },
  { speaker: 'customer', transcript: 'Patient date of birth is nineteenth of November nineteen seventy nine.' },
  { speaker: 'customer', transcript: 'Patient weight is eighty kilograms.' },
];

test('batch workflow analysis requests enough output budget for multi-slot extraction', async (t) => {
  let requestBody;
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                completed_items: [
                  { item_id: 'patient_name', confidence: 0.95, extracted_value: 'John Applegate', source_text: 'named John Applegate' },
                  { item_id: 'patient_dob', confidence: 0.95, extracted_value: 'November 19, 1979', source_text: 'date of birth is nineteenth of November nineteen seventy nine' },
                  { item_id: 'patient_weight', confidence: 0.95, extracted_value: '80 kg', source_text: 'weight is eighty kilograms' },
                ],
              }),
            },
          },
        ],
      }),
    };
  };

  const result = await analyzeWorkflowTranscriptBatch({
    transcripts,
    pendingItems,
    slotsFilled: {},
  });

  assert.ok(requestBody.max_tokens >= 1200);
  assert.deepEqual(result.completed_items.map((item) => item.item_id), [
    'patient_name',
    'patient_dob',
    'patient_weight',
  ]);
});

test('batch workflow analysis falls back to reasoning when content is non-json prose', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: 'I will analyze the call step by step and then provide the answer.',
            reasoning: JSON.stringify({
              completed_items: [
                { item_id: 'patient_name', confidence: 0.95, extracted_value: 'John Applegate', source_text: 'named John Applegate' },
              ],
            }),
          },
        },
      ],
    }),
  });

  const result = await analyzeWorkflowTranscriptBatch({
    transcripts,
    pendingItems,
    slotsFilled: {},
  });

  assert.equal(result.completed_items.length, 1);
  assert.equal(result.completed_items[0].item_id, 'patient_name');
  assert.equal(result.completed_items[0].extracted_value, 'John Applegate');
});

test('batch prompt explicitly forbids reasoning text around JSON', () => {
  const { userPrompt } = buildBatchAnalysisPrompt({
    transcripts,
    pendingItems,
    slotsFilled: {},
  });

  assert.match(userPrompt, /Return ONLY one valid JSON object/);
  assert.match(userPrompt, /Do not include reasoning/);
});

test('batch prompt stays compact so reasoning models return JSON before token budget is exhausted', () => {
  const { systemPrompt } = buildBatchAnalysisPrompt({
    transcripts,
    pendingItems,
    slotsFilled: {},
  });

  assert.match(systemPrompt, /You are a JSON API/);
  assert.doesNotMatch(systemPrompt, /## Detection Guidelines/);
  assert.ok(systemPrompt.length < 2500, `batch system prompt was ${systemPrompt.length} chars`);
});
