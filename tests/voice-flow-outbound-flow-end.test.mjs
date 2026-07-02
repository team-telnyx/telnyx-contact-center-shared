import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourcePromise = readFile(new URL('../lib/voice-flow-engine.js', import.meta.url), 'utf8');

test('Flow End receives execution state so outbound campaign context is available', async () => {
  const source = await sourcePromise;
  assert.match(
    source,
    /return await executeFlowEndNode\(node, callControlId, executionState\);/,
    'executeFlowNode should pass executionState into Flow End',
  );
});

test('outbound campaign Flow End requests Telnyx hangup by default', async () => {
  const source = await sourcePromise;
  assert.match(source, /async function executeFlowEndNode\(node, callControlId, executionState = \{\}\)/);
  assert.match(source, /variables\.trigger_type === "outbound_campaign"/);
  assert.match(source, /variables\.outbound_campaign_id/);
  assert.match(source, /config\.hangupOnEnd !== false/);
  assert.match(source, /await callTelnyxAction\([\s\S]*?"hangup"[\s\S]*?callControlId[\s\S]*?\)/);
  assert.match(source, /hangupRequested: Boolean\(shouldHangupOutboundCall\)/);
});
