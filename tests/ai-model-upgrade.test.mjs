import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyAiSettings } from '../lib/ai-operations/upgrade-1-10.mjs';
import { AI_OPERATION_IDS } from '../lib/ai-operations/catalog.mjs';
import { prepareAiOperation } from '../lib/ai-operations/runtime.mjs';

test('upgraded installations can resolve every operation without a new environment variable', async () => {
  const settings = legacyAiSettings({}, {});
  assert.deepEqual(Object.keys(settings.ai_operations).sort(), [...AI_OPERATION_IDS].sort());
  for (const id of AI_OPERATION_IDS) {
    const body = await prepareAiOperation(id, { messages: [] }, { settings, env: {} });
    assert.ok(body.model, id);
  }
  assert.equal(settings.ai_operations['form-builder'].model, 'meta-llama/Meta-Llama-3.1-8B-Instruct');
  assert.equal(settings.ai_operations['email-template'].model, 'Qwen/Qwen3-235B-A22B');
});

test('legacy environment overrides become editable settings with their original precedence', () => {
  const next = legacyAiSettings({}, {
    TELNYX_AI_TRANSLATION_MODEL: 'legacy/live', FORM_BUILDER_AI_MODEL: 'legacy/form',
    TELNYX_CHAT_MODEL: 'legacy/chat', TELNYX_AI_DASHBOARD_SUMMARY_MODEL: 'legacy/summary',
    TELNYX_TRANSLATION_MODEL: 'legacy/preview',
  });
  for (const [id, model] of Object.entries({ 'live-translation': 'legacy/live', 'form-builder': 'legacy/form',
    'assistant-summary': 'legacy/summary', 'preview-translation': 'legacy/preview' })) {
    assert.equal(next.ai_operations[id].model, model);
  }
  assert.equal(legacyAiSettings({}, { TELNYX_CHAT_MODEL: 'legacy/chat' }).ai_operations['form-builder'].model, 'legacy/chat');
});

test('explicit models, guidance, channel configuration and unrelated settings are preserved', () => {
  const before = { ai_operations: { 'form-builder': { model: 'saved/model', instructions: 'Keep guidance.' },
    'call-summary': { model: '', instructions: 'Preserve this too.' } },
    chat_copilot: { model: 'channel/model', bucketIds: ['knowledge'], maxTokens: 6000 },
    consult_hold: { media_name: 'keep' } };
  const copy = structuredClone(before);
  const after = legacyAiSettings(before, { FORM_BUILDER_AI_MODEL: 'env/model' });
  assert.deepEqual(before, copy, 'input is not mutated');
  assert.deepEqual(after.ai_operations['form-builder'], before.ai_operations['form-builder']);
  assert.equal(after.ai_operations['call-summary'].instructions, 'Preserve this too.');
  assert.deepEqual(after.chat_copilot, before.chat_copilot);
  assert.deepEqual(after.consult_hold, before.consult_hold);
});

test('an already configured platform default keeps intentional inheritance', () => {
  for (const [settings, env] of [
    [{ ai_default_model: 'saved/default', ai_operations: { 'call-summary': { model: '', instructions: 'Keep' } } }, {}],
    [{ ai_operations: {} }, { TELNYX_AI_DEFAULT_MODEL: 'env/default' }],
  ]) assert.equal(legacyAiSettings(settings, env), settings);
});
