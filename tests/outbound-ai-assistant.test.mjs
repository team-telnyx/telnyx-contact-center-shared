import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAgentlessAiAssistantStartBody,
  startAgentlessAiAssistantForCall,
} from '../lib/outbound-dialer/ai-assistant.js';

test('buildAgentlessAiAssistantStartBody uses Telnyx Start AI Assistant schema', () => {
  const body = buildAgentlessAiAssistantStartBody({
    assistantId: 'assistant-123',
    callControlId: 'cc-123',
    ledgerId: 'ledger-123',
    campaignId: 'campaign-123',
  });

  assert.deepEqual(body.assistant, { id: 'assistant-123' });
  assert.equal(body.assistant_id, undefined);
  assert.equal(body.command_id, 'outbound-ai-assistant-start-ledger-123');

  const state = JSON.parse(Buffer.from(body.client_state, 'base64').toString('utf8'));
  assert.equal(state.source, 'outbound_agentless_ai');
  assert.equal(state.call_control_id, 'cc-123');
  assert.equal(state.ledger_id, 'ledger-123');
  assert.equal(state.campaign_id, 'campaign-123');
});

test('startAgentlessAiAssistantForCall posts assistant.id to call command endpoint', async () => {
  const calls = [];
  const result = await startAgentlessAiAssistantForCall({
    apiKey: 'test-key',
    callControlId: 'cc-456',
    assistantId: 'assistant-456',
    ledgerId: 'ledger-456',
    campaignId: 'campaign-456',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: { result: 'ok' } };
        },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/calls\/cc-456\/actions\/ai_assistant_start$/);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');

  const payload = JSON.parse(calls[0].options.body);
  assert.deepEqual(payload.assistant, { id: 'assistant-456' });
  assert.equal(payload.assistant_id, undefined);
});
