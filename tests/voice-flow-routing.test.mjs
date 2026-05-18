import test from 'node:test';
import assert from 'node:assert/strict';

import { findNextNodes } from '../lib/voice-flow-routing.js';
import { VOICE_FLOW_NODES } from '../config/voice-flow-nodes.js';

function outboundFlow() {
  return {
    nodes: [
      { id: 'outbound-trigger', data: { nodeType: 'outbound_campaign' } },
      { id: 'assistant', data: { nodeType: 'ai_assistant_start' } },
      { id: 'logger', data: { nodeType: 'set_variable' } },
    ],
    edges: [
      {
        id: 'answered-assistant',
        source: 'outbound-trigger',
        target: 'assistant',
        sourceHandle: 'call.answered',
      },
      {
        id: 'default-logger',
        source: 'outbound-trigger',
        target: 'logger',
        sourceHandle: 'default',
      },
    ],
  };
}

test('outbound campaign initiator does not execute call.answered edge on call.initiated', () => {
  const nodes = findNextNodes(outboundFlow(), 'outbound-trigger', 'call.initiated');

  assert.deepEqual(nodes.map((node) => node.id), ['logger']);
});

test('outbound campaign initiator executes AI assistant edge on call.answered', () => {
  const nodes = findNextNodes(outboundFlow(), 'outbound-trigger', 'call.answered');

  assert.deepEqual(nodes.map((node) => node.id), ['assistant', 'logger']);
});

test('legacy outbound campaign output-0 edge waits for call.answered before running call-control nodes', () => {
  assert.equal(VOICE_FLOW_NODES.outbound_campaign.outputEvents[0], 'call.answered');

  const flow = {
    nodes: [
      { id: 'outbound-trigger', data: { nodeType: 'outbound_campaign' } },
      { id: 'speak', data: { nodeType: 'speak' } },
    ],
    edges: [
      {
        id: 'answered-speak',
        source: 'outbound-trigger',
        target: 'speak',
        sourceHandle: 'output-0',
      },
    ],
  };

  assert.deepEqual(findNextNodes(flow, 'outbound-trigger', 'call.initiated').map((node) => node.id), []);
  assert.deepEqual(findNextNodes(flow, 'outbound-trigger', 'call.answered').map((node) => node.id), ['speak']);
});
